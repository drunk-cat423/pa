import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';

const cli = join(process.cwd(), 'dist', 'memory-backfill-cli.js');

function envFor(dataDir, model = false, baseUrl = '') {
  const env = { ...process.env, PA_DATA_DIR: dataDir, PA_MEMORY_ENABLED: 'false' };
  for (const name of ['PA_PROVIDER', 'PA_MODEL', 'PA_API_KEY', 'PA_BASE_URL']) delete env[name];
  if (model) Object.assign(env, {
    PA_PROVIDER: 'deepseek', PA_MODEL: 'deepseek-chat', PA_API_KEY: 'local-fake-key', PA_BASE_URL: baseUrl,
    PA_CONTEXT_WINDOW: '100000', PA_MAX_OUTPUT_TOKENS: '2048', PA_MEMORY_MAX_OUTPUT_TOKENS: '2048',
    PA_TIMEOUT_MS: '4000', PA_MEMORY_TIMEOUT_MS: '4000',
  });
  return env;
}

function runCli(args, env, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: process.cwd(), env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function modelServer(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, body: raw ? JSON.parse(raw) : undefined });
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404); response.end(); return;
    }
    const input = JSON.parse(requests.at(-1).body.messages.findLast(message => message.role === 'user').content);
    const content = JSON.stringify(input.mode === 'profiles'
      ? { profiles: input.profiles.map(profile => ({ personId: profile.personId, baseVersion: profile.baseVersion,
        facts: profile.facts, updates:[],pendingResults: (profile.pending ?? []).map(item => ({ pendingId: item.id, status: 'deferred' })) })) }
      : { topics: [], profiles: [] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'local-backfill', object: 'chat.completion.chunk', created: 1,
      model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'local-backfill', object: 'chat.completion.chunk', created: 1,
      model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test('plan, reserve, and status work without credentials and status output omits source text', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-backfill-cli-offline-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new ConversationStore(join(dataDir, 'pa.sqlite'));
  const room = store.ensureConversation('offline-room', '/offline/session.jsonl', {
    channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'offline-room',
  });
  const original = 'private original source text should never appear in status';
  store.recordInbound(room.id, original, { eventId: 'one', senderId: 'alice', modelInputText: original });
  store.close();
  const env = envFor(dataDir);

  const plan = await runCli(['plan', room.id], env);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).messageCount, 1);
  assert.equal(plan.stdout.includes(original), false);

  const reserved = await runCli(['reserve', room.id, 'offline test backfill'], env);
  assert.equal(reserved.code, 0, reserved.stderr);
  const runId = JSON.parse(reserved.stdout).runId;
  assert.ok(runId);
  assert.equal(reserved.stdout.includes(original), false);

  const status = await runCli(['status', runId], env);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status.queued, 1);
  assert.equal(status.stdout.includes(original), false);
  const allRuns = await runCli(['status'], env);
  assert.equal(allRuns.code, 0, allRuns.stderr);
  assert.equal(JSON.parse(allRuns.stdout).length, 1);
});

test('run uses a bounded local model budget, records failure without retry, and completed runs make zero calls', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-backfill-cli-run-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new ConversationStore(join(dataDir, 'pa.sqlite'));
  const largeRoom = store.ensureConversation('large-room', '/large/session.jsonl', {
    channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'large-room',
  });
  for (let index = 0; index < 101; index++) {
    const text = `source ${index}`;
    store.recordInbound(largeRoom.id, text, { eventId: `large-${index}`, senderId: 'alice', modelInputText: text });
  }
  const smallRoom = store.ensureConversation('small-room', '/small/session.jsonl', {
    channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'small-room',
  });
  store.recordInbound(smallRoom.id, 'single local source', { eventId: 'small-one', senderId: 'alice', modelInputText: 'single local source' });
  store.close();

  const server = await modelServer(t);
  const env = envFor(dataDir, true, server.baseUrl);
  const failedReservation = await runCli(['reserve', largeRoom.id, 'bounded CLI test'], env);
  assert.equal(failedReservation.code, 0, failedReservation.stderr);
  const failedRunId = JSON.parse(failedReservation.stdout).runId;
  const stopped = await runCli(['run', failedRunId, '--max-calls', '1'], env);
  assert.equal(stopped.code, 1, stopped.stderr);
  const stoppedLines = stopped.stdout.trim().split(/\r?\n/).map(line => {
    try { return JSON.parse(line); } catch { return undefined; }
  }).filter(Boolean);
  const stoppedResult = stoppedLines.at(-1);
  assert.equal(stoppedResult.event, 'stopped');
  assert.equal(stoppedResult.calls, 1);
  assert.equal(stoppedResult.run.status.completed, 0);
  assert.equal(stoppedResult.run.status.failed, 1);
  assert.equal(stoppedResult.run.status.queued, 1);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, '/v1/chat/completions');

  const refusedRetry = await runCli(['run', failedRunId, '--max-calls', '5'], env);
  assert.equal(refusedRetry.code, 1);
  assert.equal(server.requests.length, 1);
  const failedStatus = await runCli(['status', failedRunId], envFor(dataDir));
  assert.equal(JSON.parse(failedStatus.stdout).status.failed, 1);
  assert.equal(server.requests.length, 1);

  const completedReservation = await runCli(['reserve', smallRoom.id, 'completed run test'], env);
  assert.equal(completedReservation.code, 0, completedReservation.stderr);
  const completedRunId = JSON.parse(completedReservation.stdout).runId;
  const completed = await runCli(['run', completedRunId, '--max-calls', '2'], env);
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(server.requests.length, 3);
  const alreadyDone = await runCli(['run', completedRunId], envFor(dataDir));
  assert.equal(alreadyDone.code, 0, alreadyDone.stderr);
  const result = JSON.parse(alreadyDone.stdout);
  assert.equal(result.calls, 0);
  assert.equal(result.note.includes('没有发起模型调用'), true);
  assert.equal(server.requests.length, 3);
});

test('invalid CLI parameters fail before creating the configured database directory', async t => {
  const dataDir = join(tmpdir(), `pa-backfill-cli-invalid-${process.pid}-${Date.now()}`);
  const env = envFor(dataDir);
  for (const args of [
    ['plan', 'conversation', 'extra'],
    ['reserve', 'conversation'],
    ['run', 'unknown', '--max-calls', '0'],
    ['run', 'unknown', '--max-calls', '1001'],
  ]) {
    const result = await runCli(args, env);
    assert.equal(result.code, 1);
  }
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(dataDir), false);
});
