import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ConversationStore } from '../dist/store.js';
import { DiagnosticLog, DiagnosticPersistenceError } from '../dist/diagnostics.js';
import { queryDiagnostics, replayDiagnosticCall } from '../dist/logs.js';
import { runLogsCli } from '../dist/logs-cli.js';
import { ContextTokenEstimator, contextCalibrationKey } from '../dist/context-tokens.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const standalonePath = fileURLToPath(new URL('../dist/logs-cli.js', import.meta.url));
const privateText = 'PRIVATE_SAVED_USER_TEXT';
const privateResponse = 'PRIVATE_SAVED_RESPONSE';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-logs-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // An existing business file is intentionally not a valid SQLite database: any accidental open fails.
  writeFileSync(join(dir, 'pa.sqlite'), 'BUSINESS_DATABASE_MUST_REMAIN_UNOPENED');
  return { dir, log: new DiagnosticLog(dir) };
}

test('默认诊断仅显示校准摘要，完整哈希分块留给显式content查询',t=>{
  const {log}=fixture(t);
  const payload={messages:[{role:'user',content:privateText.repeat(2000)}]};
  const estimator=new ContextTokenEstimator(contextCalibrationKey('fixture','model','openai-completions','https://local.test','room'));
  const metadata=estimator.metadata(payload);assert.ok(metadata);
  const id=log.startCall({traceId:'calibration-query',kind:'chat',provider:'fixture',model:'model',phase:'request',
    contextCalibration:metadata},payload);
  const compact=queryDiagnostics(log,{callId:id});
  assert.equal(compact.calls[0].contextCalibration.requestBytes,metadata.footprint.bytes);
  assert.equal(compact.calls[0].contextCalibration.blockCount,metadata.footprint.blocks.reduce((sum,b)=>sum+b.count,0));
  assert.doesNotMatch(JSON.stringify(compact),/footprint|PRIVATE_SAVED_USER_TEXT/);
  const full=queryDiagnostics(log,{callId:id},true);
  assert.deepEqual(full.calls[0].contextCalibration,metadata);
  assert.deepEqual(log.calls({callId:id})[0].contextCalibration,metadata);
});

function memoryInput() {
  return {
    job: { id: 'job-offline', conversationId: 'conversation-offline', reason: 'capacity', status: 'running',
      startSeq: 1, endSeq: 2, messageIds: ['user-one', 'assistant-one'], attempts: 1 },
    roomType: 'group', profiles: [], messages: [
      { id: 'user-one', conversationId: 'conversation-offline', personId: 'person-one', actorId: 'actor-one',
        role: 'user', text: privateText, ingestSeq: 1, createdAt: '2026-10-16T00:00:00Z' },
      { id: 'assistant-one', conversationId: 'conversation-offline', role: 'assistant', text: '上下文回复',
        ingestSeq: 2, createdAt: '2026-10-16T00:00:01Z' },
    ],
  };
}

function savedMemory(log, mode = 'success') {
  const input = memoryInput();
  const proposal = { topics: [], fragments: [], profiles: [], ignoredMessageIds: mode === 'coverage' ? [] : ['user-one'] };
  const text = mode === 'json' ? '{PRIVATE_INVALID_RESPONSE_JSON' : JSON.stringify(proposal);
  const id = log.startCall({ traceId: `memory-${mode}`, taskId: 'task-offline', jobId: input.job.id,
    conversationId: input.job.conversationId, kind: 'memory', provider: 'offline-fixture', model: 'offline-fixture', phase: 'extract' },
  { messages: [{ role: 'user', content: privateText }], tool_choice: 'none' }, input);
  log.saveResponse(id, { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: { input: 10, output: 5 } });
  log.finishCall(id, mode === 'success' ? 'completed' : 'failed', mode === 'json' ? 'parse' : 'validate');
  return id;
}

function savedChat(log, request = { messages: [{ role: 'user', content: privateText }], tool_choice: 'none' },
  response = { content: [{ type: 'text', text: privateResponse }], stopReason: 'stop' }) {
  const id = log.startCall({ traceId: 'trace-chat', taskId: 'task-chat', kind: 'chat', provider: 'offline-fixture',
    model: 'offline-fixture', phase: 'response' }, request);
  log.saveResponse(id, response);
  log.finishCall(id, 'completed', 'response');
  return id;
}

function snapshot(root) {
  const result = {};
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = statSync(path);
      result[relative(root, path)] = entry.isDirectory()
        ? { directory: true, mtimeMs: stat.mtimeMs }
        : { bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
      if (entry.isDirectory()) visit(path);
    }
  }
  visit(root);
  return result;
}

function cli(dir, args, standalone = false) {
  const env = { ...process.env, PA_DATA_DIR: dir };
  for (const key of Object.keys(env)) {
    if (/api.?key|token|secret|credential/i.test(key) || ['PA_MODEL', 'PA_PROVIDER'].includes(key)) delete env[key];
  }
  const argv = standalone ? [standalonePath, ...args] : [cliPath, 'logs', ...args];
  try {
    const stdout = execFileSync(process.execPath, argv, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 15000 });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test('default metadata omits saved text; call --content explicitly reads complete artifacts without API credentials', t => {
  const { dir, log } = fixture(t);
  const id = savedChat(log);
  const before = snapshot(dir);
  const metadata = queryDiagnostics(log, { callId: id });
  assert.equal(metadata.calls.length, 1);
  assert.equal(metadata.calls[0].artifacts, undefined);
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_SAVED_USER_TEXT|PRIVATE_SAVED_RESPONSE/);
  for (const args of [['recent'], ['task', 'task-chat'], ['trace', 'trace-chat'], ['export', 'trace-chat'], ['call', id]]) {
    const result = cli(dir, args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).calls[0].callId, id);
    assert.doesNotMatch(result.stdout, /PRIVATE_SAVED_USER_TEXT|PRIVATE_SAVED_RESPONSE/);
  }
  const content = cli(dir, ['call', id, '--content']);
  assert.equal(content.code, 0, content.stderr);
  const artifacts = JSON.parse(content.stdout).calls[0].artifacts;
  assert.equal(artifacts.request.messages[0].content, privateText);
  assert.equal(artifacts.response.content[0].text, privateResponse);
  const standalone = cli(dir, ['call', id], true);
  assert.equal(standalone.code, 0, standalone.stderr);
  assert.equal(JSON.parse(standalone.stdout).calls[0].callId, id);
  assert.deepEqual(snapshot(dir), before);
});

test('CLI replay requires the explicit --offline flag and rejects extra action flags', t => {
  const { dir, log } = fixture(t);
  const id = savedChat(log);
  const before = snapshot(dir);
  for (const args of [['replay', id], ['replay', id, '--online'], ['replay', id, '--offline', '--execute'], ['call', id, '--offline']]) {
    assert.throws(() => runLogsCli(args, dir), /用法/);
    const result = cli(dir, args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /PRIVATE_SAVED_USER_TEXT|PRIVATE_SAVED_RESPONSE/);
  }
  const result = cli(dir, ['replay', id, '--offline']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual({ ok: JSON.parse(result.stdout).ok, offline: JSON.parse(result.stdout).offline }, { ok: true, offline: true });
  assert.deepEqual(snapshot(dir), before);
});

for (const mode of ['json', 'coverage', 'success']) test(`offline memory replay ${mode} reproduces parsing and coverage checks without writes`, t => {
  const { dir, log } = fixture(t);
  const id = savedMemory(log, mode);
  const before = snapshot(dir);
  const report = replayDiagnosticCall(log, id);
  assert.equal(report.ok, mode === 'success');
  assert.equal(report.phase, mode === 'json' ? 'parse' : 'validate');
  assert.equal(report.offline, true);
  assert.equal(report.networkRequests, 0);
  assert.equal(report.businessWrites, 0);
  assert.equal(report.captureLevel, 'sdk-normalized');
  if (mode === 'json') assert.match(report.failure, /model_json/);
  if (mode === 'coverage') assert.match(report.failure, /遗漏|覆盖/);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SAVED_USER_TEXT|PRIVATE_INVALID_RESPONSE_JSON/);
  const result = cli(dir, ['replay', id, '--offline']);
  assert.equal(result.code, mode === 'success' ? 0 : 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, mode === 'success');
  const byJob = cli(dir, ['job', 'job-offline']);
  assert.equal(byJob.code, 0, byJob.stderr);
  assert.equal(JSON.parse(byJob.stdout).calls[0].callId, id);
  assert.deepEqual(snapshot(dir), before);
});

test('chat toolUse without a toolCall is rejected even when saved content contains text', t => {
  const { dir, log } = fixture(t);
  const id = savedChat(log, { tools: [{ type: 'function', function: { name: 'web_search' } }] },
    { content: [{ type: 'text', text: 'cannot count as a completed tool call' }], stopReason: 'toolUse' });
  const before = snapshot(dir);
  const report = replayDiagnosticCall(log, id);
  assert.equal(report.ok, false);
  assert.equal(report.phase, 'validate');
  assert.ok(report.failure);
  const result = cli(dir, ['replay', id, '--offline']);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.deepEqual(snapshot(dir), before);
});

test('tampered request, response or frozen input hash rejects replay and explicit content reads', t => {
  const { dir, log } = fixture(t);
  for (const name of ['request', 'response', 'input']) {
    const id = savedMemory(log, 'success');
    const artifact = join(dir, 'diagnostics', 'calls', id, `${name}.json`);
    writeFileSync(artifact, '{"TAMPERED_PAYLOAD":"must never be replayed"}');
    const before = snapshot(dir);
    assert.throws(() => replayDiagnosticCall(log, id), error => error instanceof DiagnosticPersistenceError && /哈希|长度/.test(error.message));
    assert.throws(() => queryDiagnostics(log, { callId: id }, true), DiagnosticPersistenceError);
    for (const args of [['replay', id, '--offline'], ['call', id, '--content']]) {
      const result = cli(dir, args);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /TAMPERED_PAYLOAD|PRIVATE_SAVED_USER_TEXT/);
    }
    assert.deepEqual(snapshot(dir), before);
  }
});

test('queries on absent diagnostics do not create storage; replay runs no network, model, tool or business operation', t => {
  const { dir, log } = fixture(t);
  const empty = snapshot(dir);
  assert.deepEqual(queryDiagnostics(log), { calls: [], events: [], mayBeTruncated: false });
  const recent = cli(dir, ['recent']);
  assert.equal(recent.code, 0, recent.stderr);
  assert.deepEqual(snapshot(dir), empty);
  const memory = savedMemory(log);
  const prepared = savedChat(log, { tool_choice: { type: 'function', function: { name: 'prepare_turn' } },
    tools: [{ type: 'function', function: { name: 'prepare_turn' } }] }, { stopReason: 'toolUse', content: [
    { type: 'toolCall', id: 'tool-one', name: 'prepare_turn', arguments: { intent: 'memory_update', mode: 'standard',
      updates: [{ target: 'room_rule', key: 'test', content: '不可实际写入的群约定' }] } },
  ] });
  const searched = savedChat(log, { tools: [{ type: 'function', function: { name: 'web_search' } }] },
    { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool-two', name: 'web_search', arguments: { query: 'offline fixture' } }] });
  const before = snapshot(dir);
  const attempts = { network: 0, model: 0, tool: 0, process: 0 };
  const forbidden = kind => () => { attempts[kind]++; throw new Error(`Unexpected ${kind} operation`); };
  try {
    t.mock.method(globalThis, 'fetch', forbidden('network'));
    for (const module of [http, https]) for (const name of ['request', 'get']) t.mock.method(module, name, forbidden('network'));
    for (const name of ['connect', 'createConnection']) t.mock.method(net, name, forbidden('network'));
    for (const name of ['spawn', 'spawnSync', 'exec', 'execFile', 'execFileSync']) t.mock.method(childProcess, name, forbidden('process'));
    t.mock.method(ModelRuntime.prototype, 'completeSimple', forbidden('model'));
    t.mock.method(ConversationStore.prototype, 'prepareTurn', forbidden('tool'));
    syncBuiltinESMExports();
    assert.equal(queryDiagnostics(log).calls.length, 3);
    for (const id of [memory, prepared, searched]) {
      const report = replayDiagnosticCall(log, id);
      assert.equal(report.ok, true);
      assert.equal(report.networkRequests, 0);
      assert.equal(report.businessWrites, 0);
    }
    assert.deepEqual(attempts, { network: 0, model: 0, tool: 0, process: 0 });
    assert.deepEqual(snapshot(dir), before);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
