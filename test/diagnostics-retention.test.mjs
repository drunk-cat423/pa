import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DiagnosticLog, DiagnosticPersistenceError } from '../dist/diagnostics.js';

const notice = '研究诊断正文已按30天保留规则清理；调用用量/失败阶段/审计仍保留，无法离线重放。';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-diagnostics-retention-'));
  const log = new DiagnosticLog(directory);
  const callId = log.startCall({ traceId: 'trace', kind: 'chat', provider: 'local', model: 'fixture', phase: 'request' }, { prompt: 'local fixture' });
  log.saveResponse(callId, { usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }, content: 'fixture response' });
  log.finishCall(callId, 'failed', 'provider_rejected');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, log, callId };
}

function commitDiagnosticRetention(directory, callId, name, ref, status) {
  const db = new DatabaseSync(join(directory, 'pa.sqlite'));
  try {
    db.exec(`CREATE TABLE research_retention_runs (
      id TEXT PRIMARY KEY, policy_version INTEGER NOT NULL, plan_json TEXT NOT NULL,
      post_hashes_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT
    )`);
    const plan = { candidates: [{ files: [{ path: `diagnostics/calls/${callId}/${name}.json`, sha256: ref.sha256, bytes: ref.bytes, kind: 'diagnostic' }] }] };
    db.prepare('INSERT INTO research_retention_runs VALUES (?,?,?,?,?,?,?)')
      .run('cleanup', 1, JSON.stringify(plan), '{}', status, new Date().toISOString(), status === 'done' ? new Date().toISOString() : null);
  } finally { db.close(); }
}

for (const status of ['pending', 'done']) test(`diagnostic artifact reports committed ${status} retention while metadata remains`, t => {
  const f = fixture(t), call = f.log.calls()[0], ref = call.requestRef;
  commitDiagnosticRetention(f.directory, f.callId, 'request', ref, status);
  unlinkSync(join(f.directory, 'diagnostics', ref.path));

  assert.throws(() => f.log.artifact(f.callId, 'request'), error => error instanceof DiagnosticPersistenceError && error.message === notice);
  const retained = f.log.calls({ callId: f.callId })[0];
  assert.equal(retained.usage.inputTokens, 12);
  assert.equal(retained.usage.outputTokens, 3);
  assert.equal(retained.status, 'failed');
  assert.equal(retained.phase, 'provider_rejected');
  assert.ok(f.log.events({ callId: f.callId }).length > 0);
});

test('ordinary missing diagnostic artifact remains a persistence error without an expiry claim', t => {
  const f = fixture(t), ref = f.log.calls()[0].requestRef;
  unlinkSync(join(f.directory, 'diagnostics', ref.path));

  assert.throws(() => f.log.artifact(f.callId, 'request'), error => error instanceof DiagnosticPersistenceError
    && error.message !== notice && error.message === '诊断证据持久化或读取失败；未自动重试。');
});

test('artifact reads do not create a missing business database', t => {
  const f = fixture(t), ref = f.log.calls()[0].requestRef;
  assert.equal(existsSync(join(f.directory, 'pa.sqlite')), false);

  assert.deepEqual(f.log.artifact(f.callId, 'request'), { prompt: 'local fixture' });
  assert.equal(existsSync(join(f.directory, 'pa.sqlite')), false);
});

