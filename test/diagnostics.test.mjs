import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DiagnosticLog, DiagnosticPersistenceError, DIAGNOSTIC_MAX_ARTIFACT_BYTES } from '../dist/diagnostics.js';

const exec = promisify(execFile);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, log: new DiagnosticLog(dir, ['explicit-secret-value']) };
}
const spec = (extra = {}) => ({ traceId: 'trace-a', taskId: 'task-a', jobId: 'job-a', runId: 'run-a', conversationId: 'room-a', attempt: 1,
  kind: 'memory', provider: 'mock', model: 'mock-model', phase: 'extract', ...extra });
const index = dir => join(dir, 'diagnostics', 'index.sqlite');
const artifactPath = (dir, id, name = 'request') => join(dir, 'diagnostics', 'calls', id, `${name}.json`);
function indexEdit(dir, edit) { const db = new DatabaseSync(index(dir)); try { edit(db); } finally { db.close(); } }

test('captures SDK-normalized evidence, redacts secrets while retaining user text and token usage', t => {
  const { dir, log } = fixture(t);
  const id = log.startCall(spec(), { messages: [{ role: 'user', content: '保留用户原文 explicit-secret-value' }],
    headers: { Authorization: 'Bearer hidden', Cookie: 'sid=hidden', 'x-api-key': 'hidden' }, apiKey: 'hidden', leaseToken: 'hidden',
    nested: { secret: 'hidden', auth: 'hidden', token: 'hidden', bearerToken: 'hidden', privateKeyPem: 'hidden',
      'explicit-secret-value': 'sensitive field name' }, url: 'https://example.test/?api_key=hidden&x=1',
    roomRules: [{ key: 'pa' }], tools: [{ properties: { key: { type: 'string' } } }], absent: undefined,
    array: [undefined, 'preserved'] }, { frozen: '原始冻结输入' });
  log.saveResponse(id, { content: '模型回复', usage: { inputTokens: 42, outputTokens: 7, totalTokens: 49,
    cacheRead: 2, cost: { total: 0.001 }, injectedContent: 'must stay out of index' } });
  log.finishCall(id, 'completed', 'extract');
  log.finishCall(id, 'failed', 'validate', { code: 'contract', leaseToken: 'hidden' });
  const request = log.artifact(id, 'request');
  assert.equal(request.messages[0].content, '保留用户原文 [REDACTED]');
  assert.equal(request.apiKey, '[REDACTED]');
  assert.equal(request.leaseToken, '[REDACTED]');
  assert.equal(request.headers.Authorization, '[REDACTED]');
  assert.equal(request.headers.Cookie, '[REDACTED]');
  assert.equal(request.headers['x-api-key'], '[REDACTED]');
  assert.equal(request.nested.bearerToken, '[REDACTED]');
  assert.equal(request.nested.privateKeyPem, '[REDACTED]');
  assert.equal(Object.hasOwn(request.nested, 'explicit-secret-value'), false);
  assert.equal(request.url, 'https://example.test/?api_key=[REDACTED]&x=1');
  assert.equal(request.roomRules[0].key, 'pa');
  assert.deepEqual(request.tools[0].properties.key, { type: 'string' });
  assert.equal(Object.hasOwn(request, 'absent'), false);
  assert.deepEqual(request.array, [null, 'preserved']);
  assert.deepEqual(log.artifact(id, 'input'), { frozen: '原始冻结输入' });
  const [record] = log.calls({ callId: id });
  assert.equal(record.captureLevel, 'sdk-normalized');
  assert.equal(record.status, 'failed');
  assert.equal(record.phase, 'validate');
  assert.equal(record.taskId, 'task-a');
  assert.equal(record.usage.inputTokens, 42);
  assert.equal(record.usage.outputTokens, 7);
  assert.equal(record.usage.injectedContent, undefined);
  assert.equal(record.usageSource, 'sdk-normalized');
  assert.equal(record.billedUsage, null);
  assert.equal(JSON.stringify(record).includes('模型回复'), false);
  assert.equal(JSON.stringify(record).includes('保留用户原文'), false);
  const events = log.events({ callId: id });
  assert.deepEqual(events.map(event => event.event), ['call_failed', 'call_completed', 'call_started']);
  assert.equal(events[0].details.leaseToken, '[REDACTED]');
  const eventFile = join(dir, 'diagnostics', 'events', readdirSync(join(dir, 'diagnostics', 'events'))[0]);
  assert.equal(readFileSync(eventFile, 'utf8').trim().split('\n').length, 3);
  if (process.platform !== 'win32') {
    assert.equal(statSync(artifactPath(dir, id)).mode & 0o777, 0o600);
    assert.equal(statSync(index(dir)).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'diagnostics')).mode & 0o777, 0o700);
  } else {
    const encodedRoot = Buffer.from(join(dir, 'diagnostics'), 'utf8').toString('base64');
    const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRoot}')); `
      + `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[IO.Directory]::GetAccessControl($p); `
      + `if (!$acl.AreAccessRulesProtected) { throw 'ACL not protected' }; `
      + `foreach ($item in @($p, [IO.Path]::Combine($p,'index.sqlite'), [IO.Path]::Combine($p,'calls','${id}','request.json'))) { `
      + `$security=[IO.File]::GetAccessControl($item); foreach ($ace in $security.Access) { `
      + `if ($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Broad grant' } } }`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: 'pipe', windowsHide: true });
  }
});

test('redacts quoted credentials embedded in message and provider error strings while retaining valid JSON', t => {
  const { log } = fixture(t);
  const embedded = JSON.stringify({ api_key: 'fixture-other-key', password: 'prefix"tail-secret',
    access_token: 'fixture-token', nested: { cookie: 'fixture-cookie' },
    encoded: JSON.stringify({ api_key: 'inner-secret' }), ordinary: 'preserve me' });
  const id = log.startCall(spec(), { messages: [{ content: embedded }] });
  log.saveResponse(id, { errorMessage: 'HTTP 503: ' + embedded });
  const request = log.artifact(id, 'request');
  const response = log.artifact(id, 'response');
  assert.deepEqual(JSON.parse(request.messages[0].content), { api_key: '[REDACTED]', password: '[REDACTED]',
    access_token: '[REDACTED]', nested: { cookie: '[REDACTED]' },
    encoded: JSON.stringify({ api_key: '[REDACTED]' }), ordinary: 'preserve me' });
  assert.doesNotMatch(JSON.stringify({ request, response }), /fixture-other-key|tail-secret|fixture-token|fixture-cookie|inner-secret/);
  assert.equal(JSON.parse(response.errorMessage.slice('HTTP 503: '.length)).password, '[REDACTED]');
});

test('queries by call, job, task and trace; constructor and absent reads create nothing', t => {
  const { dir, log } = fixture(t);
  assert.deepEqual(log.calls(), []);
  assert.deepEqual(log.events(), []);
  assert.throws(() => log.artifact(randomUUID(), 'input'), DiagnosticPersistenceError);
  assert.deepEqual(readdirSync(dir), []);
  const first = log.startCall(spec(), { n: 1 });
  const second = log.startCall(spec({ traceId: 'trace-b', taskId: 'task-b', jobId: 'job-b' }), { n: 2 });
  log.event({ traceId: 'trace-a', taskId: 'task-a' }, 'validate', 'validation_failed', { code: 'contract' }, first);
  assert.equal(log.calls({ jobId: 'job-a' })[0].callId, first);
  assert.equal(log.calls({ taskId: 'task-b' })[0].callId, second);
  assert.equal(log.calls({ traceId: 'trace-a' }).length, 1);
  assert.equal(log.calls({ traceId: 'trace-b', taskId: 'task-a' }).length, 0);
  assert.equal(log.calls({ limit: 1 }).length, 1);
  assert.equal(log.events({ callId: first, taskId: 'task-a' }).length, 2);
  assert.throws(() => log.calls({ limit: 0 }), DiagnosticPersistenceError);
  assert.throws(() => log.calls({ limit: 10001 }), DiagnosticPersistenceError);
  const before = readFileSync(index(dir));
  const beforeMtime = statSync(index(dir)).mtimeMs;
  const reopened = new DiagnosticLog(dir);
  assert.deepEqual(reopened.artifact(first, 'request'), { n: 1 });
  reopened.calls(); reopened.events();
  assert.deepEqual(readFileSync(index(dir)), before);
  assert.equal(statSync(index(dir)).mtimeMs, beforeMtime);
});

test('response evidence is immutable and same-value save is idempotent', t => {
  const { dir, log } = fixture(t);
  const id = log.startCall(spec(), {});
  log.saveResponse(id, { result: 1 });
  log.saveResponse(id, { result: 1 });
  assert.throws(() => log.saveResponse(id, { result: 2 }), /禁止覆盖/);
  assert.deepEqual(log.artifact(id, 'response'), { result: 1 });
  assert.deepEqual(readdirSync(join(dir, 'diagnostics', 'calls', id)).sort(), ['request.json', 'response.json']);
});

test('rejects invalid identifiers, traversal, tampered refs, hashes and oversized evidence', t => {
  const { dir, log } = fixture(t);
  const id = log.startCall(spec(), { text: 'original' });
  assert.throws(() => log.artifact('../escape', 'request'), DiagnosticPersistenceError);
  assert.throws(() => log.artifact(id, '../request'), DiagnosticPersistenceError);
  writeFileSync(artifactPath(dir, id), '{"text":"modified"}');
  assert.throws(() => log.artifact(id, 'request'), /哈希或长度/);
  const [record] = log.calls({ callId: id });
  record.requestRef.path = '../outside.json';
  indexEdit(dir, db => db.prepare('UPDATE calls SET record_json=? WHERE call_id=?').run(JSON.stringify(record), id));
  assert.throws(() => log.artifact(id, 'request'), /引用无效/);
  assert.throws(() => log.startCall(spec(), { text: 'x'.repeat(DIAGNOSTIC_MAX_ARTIFACT_BYTES) }), /超过大小上限/);
  assert.equal(log.calls().length, 1);
  assert.throws(() => log.event({ traceId: 't' }, 'error', 'error', { error: new Error('explicit-secret-value') }), /不接受原始 Error/);
  assert.equal(log.events().length, 1);
});

test('refuses file and directory symlinks for read and write', t => {
  const { dir, log } = fixture(t);
  const id = log.startCall(spec(), { x: 1 });
  const outside = join(dir, 'outside.json');
  writeFileSync(outside, '{"x":1}');
  const request = artifactPath(dir, id);
  unlinkSync(request);
  try { symlinkSync(outside, request); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      // Windows permits junction tests even without symlink privileges.
      const calls = join(dir, 'diagnostics', 'calls');
      rmSync(calls, { recursive: true });
      const outsideDirectory = join(dir, 'outside-dir'); mkdirSync(outsideDirectory);
      symlinkSync(outsideDirectory, calls, 'junction');
      assert.throws(() => log.startCall(spec(), {}), DiagnosticPersistenceError);
      assert.throws(() => log.artifact(id, 'request'), DiagnosticPersistenceError);
      return;
    }
    throw error;
  }
  assert.throws(() => log.artifact(id, 'request'), /符号链接/);
  const response = artifactPath(dir, id, 'response');
  symlinkSync(outside, response);
  assert.throws(() => log.saveResponse(id, { x: 1 }), /符号链接/);
  assert.equal(readFileSync(outside, 'utf8'), '{"x":1}');
});

test('index version and persistence failures are explicit and do not leave open handles', t => {
  const { dir, log } = fixture(t);
  mkdirSync(join(dir, 'diagnostics'));
  writeFileSync(join(dir, 'diagnostics', 'calls'), 'blocked');
  assert.throws(() => log.startCall(spec(), {}), DiagnosticPersistenceError);
  unlinkSync(join(dir, 'diagnostics', 'calls'));
  const id = log.startCall(spec(), { ok: true });
  const events = join(dir, 'diagnostics', 'events');
  rmSync(events, { recursive: true });
  writeFileSync(events, 'blocked');
  assert.throws(() => log.finishCall(id, 'completed', 'done'), DiagnosticPersistenceError);
  assert.equal(log.calls({ callId: id })[0].status, 'started');
  unlinkSync(events);
  indexEdit(dir, db => db.exec('PRAGMA user_version=999'));
  const before = readFileSync(index(dir));
  assert.throws(() => log.calls(), /版本未知/);
  assert.throws(() => log.startCall(spec(), {}), /版本未知/);
  assert.deepEqual(readFileSync(index(dir)), before);
  rmSync(join(dir, 'diagnostics'), { recursive: true });
  assert.deepEqual(readdirSync(dir), []);
});

test('multiple instances and processes share one directory with short-lived SQLite connections', async t => {
  const { dir, log } = fixture(t);
  const moduleUrl = new URL('../dist/diagnostics.js', import.meta.url).href;
  const code = `import { DiagnosticLog } from ${JSON.stringify(moduleUrl)};
    const log = new DiagnosticLog(process.argv[1]);
    const id = log.startCall({traceId:process.argv[2],kind:'chat',provider:'mock',model:'mock',phase:'model'}, {message:'evidence'});
    log.saveResponse(id, {usage:{input:1,output:2}}); log.finishCall(id,'completed','done');`;
  await Promise.all(Array.from({ length: 6 }, (_, i) => exec(process.execPath, ['--input-type=module', '-e', code, dir, `process-${i}`])));
  assert.equal(log.calls().length, 6);
  assert.equal(log.events().length, 12);
  for (const call of log.calls()) assert.equal(call.status, 'completed');
  const another = new DiagnosticLog(dir);
  assert.equal(another.calls().length, 6);
  // Windows recursive removal fails if this module leaked a database or artifact handle.
  rmSync(join(dir, 'diagnostics'), { recursive: true });
  assert.deepEqual(readdirSync(dir), []);
});
