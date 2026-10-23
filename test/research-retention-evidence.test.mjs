import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DiagnosticLog, DiagnosticPersistenceError } from '../dist/diagnostics.js';
import { applyResearchCleanup, previewResearchCleanup } from '../scripts/deployment/research-retention.mjs';
import { ConversationStore } from '../dist/store.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const budget = { maxModelCalls: 12, maxToolCalls: 24, maxSearchCalls: 6 };
const now = new Date('2026-10-23T00:00:00.000Z');
const notice = '研究诊断正文已按30天保留规则清理；调用用量/失败阶段/审计仍保留，无法离线重放。';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-research-retention-evidence-'));
  const path = join(directory, 'pa.sqlite');
  const store = new ConversationStore(path), db = new DatabaseSync(path);
  const conversation = store.ensureConversation('group', join(directory, 'ordinary-chat.jsonl'),
    { channel: 'qq', accountId: 'fixture', roomType: 'group', roomId: 'fixture' });
  let serial = 0;
  const message = () => {
    const eventId = `evidence-${++serial}`;
    store.recordInbound(conversation.id, '整理资料', { eventId, senderId: 'alice', sentAt: new Date().toISOString(), modelInputText: '整理资料' });
    return store.externalMessage(conversation.id, eventId);
  };
  const create = (key, { complete = true, at = '2026-09-01T00:00:00.000Z', withPlan = false } = {}) => {
    const input = message();
    const task = store.research.create(conversation.id, input.id, { key, title: `资料 ${key}`, goal: '核对资料并整理报告' });
    if (!complete) return task;
    store.research.claim(task.id, budget);
    if (withPlan) {
      const workflow = store.research.workflow;
      let cycle = workflow.begin(task.id, 1, { phase: 'plan', input: { goal: task.goal, source: 'fixture' } });
      workflow.savePlan(task.id, 1, cycle, { version: 1, sections: [{ id: 's1', title: '证据', objective: '核对', acceptance: '有来源' }] });
      cycle = workflow.begin(task.id, 1, { phase: 'write', sectionId: 's1', expectedVersion: 0, input: { draft: '固定输入' } });
      workflow.saveSection(task.id, 1, cycle, { sectionId: 's1', expectedVersion: 0, mode: 'replace', status: 'written',
        markdown: '正文', summary: '摘要', sources: ['https://example.invalid/source'], gaps: [] });
      cycle = workflow.begin(task.id, 1, { phase: 'review', sectionId: 's1', expectedVersion: 1, input: { review: '固定评审输入' } });
      workflow.saveReview(task.id, 1, cycle, { sectionId: 's1', expectedVersion: 1, verdict: 'pass', reason: '核验通过' });
      store.research.checkpoint(task.id, 1, { modelCalls: 2, toolCalls: 1, searchCalls: 1,
        evidence: { tool: 'fetch', input: { url: 'https://example.invalid/private' }, result: '需留哈希的原文材料' } });
    }
    store.research.finish(task.id, 1, { status: 'completed', markdown: '# 正式报告\n\n到期正文', abstract: '摘要保留', keywords: ['资料'] });
    const timestamp = new Date(at).toISOString();
    db.prepare('UPDATE research_tasks SET updated_at=? WHERE id=?').run(timestamp, task.id);
    db.prepare('UPDATE research_attempts SET updated_at=? WHERE task_id=? AND attempt=1').run(timestamp, task.id);
    return task;
  };
  const diagnostics = new DiagnosticLog(directory);
  const addCall = (task, { failed = true, runId = randomUUID() } = {}) => {
    const callId = diagnostics.startCall({ traceId: runId, runId, taskId: task.id,
      conversationId: task.conversationId ?? conversation.id, kind: 'chat', provider: 'fixture', model: 'offline', phase: 'request' },
    { prompt: 'fixture request', credentials: 'never persisted' }, { replay: 'fixture input' });
    diagnostics.saveResponse(callId, { content: 'fixture response', usage: { inputTokens: 17, outputTokens: 5, totalTokens: 22 } });
    diagnostics.finishCall(callId, failed ? 'failed' : 'completed', failed ? 'provider_rejected' : 'completed',
      failed ? { failure: 'fixed fixture failure' } : undefined);
    return { callId, runId };
  };
  const sessionKeys = task => {
    const keys = new Set([`research:${task.id}:1`]);
    for (const row of [...db.prepare('SELECT attempt,cycle FROM research_workflow_cycles WHERE task_id=?').all(task.id),
      ...db.prepare('SELECT attempt,cycle FROM research_collection_cycles WHERE task_id=?').all(task.id)]) {
      keys.add(`research:${task.id}:${row.attempt}:cycle:${row.cycle}`);
    }
    return [...keys].sort();
  };
  const writePi = (key, runIds) => {
    const relative = `${hash(key)}/session.jsonl`, file = join(directory, relative);
    mkdirSync(join(directory, hash(key)), { recursive: true });
    writeFileSync(file, [JSON.stringify({ type: 'session', version: 3 }), ...runIds.map(runId =>
      JSON.stringify({ type: 'custom', customType: 'pa_run', data: { runId } }))].join('\n') + '\n');
    return { path: relative, absolute: file };
  };
  t.after(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, store, db, conversation, diagnostics, create, addCall, sessionKeys, writePi };
}

test('v4 cleanup removes only eligible research diagnostics and Pi sessions and recovers idempotently', t => {
  const f = fixture(t), task = f.create('eligible');
  const call = f.addCall(task);
  const researchSessions = f.sessionKeys(task).map(key => f.writePi(key, [call.runId]));
  const ordinaryCallId = f.diagnostics.startCall({ traceId: randomUUID(), conversationId: f.conversation.id,
    kind: 'chat', provider: 'fixture', model: 'offline', phase: 'ordinary' }, { prompt: 'ordinary chat' });
  const ordinaryPath = join(f.directory, 'ordinary-chat.jsonl');
  writeFileSync(ordinaryPath, '{"type":"session"}\n');
  const ordinaryBytes = readFileSync(ordinaryPath);
  const ordinaryCall = f.diagnostics.calls({ callId: ordinaryCallId })[0];
  const ordinaryRequestPath = join(f.directory, 'diagnostics', ordinaryCall.requestRef.path);
  const unfinished = f.create('unfinished', { complete: false });
  const unfinishedCall = f.addCall(unfinished);
  const unfinishedRef = f.diagnostics.calls({ callId: unfinishedCall.callId })[0].requestRef;
  const unfinishedPath = join(f.directory, 'diagnostics', unfinishedRef.path);
  const indexPath = join(f.directory, 'diagnostics', 'index.sqlite');
  const indexBytes = readFileSync(indexPath);
  const originalRows = f.diagnostics.calls({ callId: call.callId })[0];
  const originalEvents = f.diagnostics.events({ callId: call.callId });
  const plan = previewResearchCleanup(f.directory, { now });
  const candidate = plan.candidates.find(item => item.taskId === task.id);
  assert.ok(candidate);
  assert.equal(candidate.evidence.diagnostics.callIds.includes(call.callId), true);
  assert.deepEqual(candidate.files.filter(file => file.kind === 'diagnostic').map(file => file.artifact).sort(), ['input', 'request', 'response']);
  assert.equal(candidate.files.filter(file => file.kind === 'pi_session').length, researchSessions.length);
  assert.deepEqual(readFileSync(indexPath), indexBytes, 'preview must not write the diagnostic index');

  assert.throws(() => applyResearchCleanup(f.directory, plan, { now, afterCommit() { throw new Error('pause after committed manifest'); } }), /pause after committed manifest/);
  assert.equal(f.db.prepare("SELECT status FROM research_retention_runs WHERE status='pending'").get().status, 'pending');
  assert.ok(candidate.files.every(file => existsSync(join(f.directory, file.path))));
  const resumed = applyResearchCleanup(f.directory, plan, { now });
  assert.equal(resumed.status, 'done');
  for (const file of candidate.files) assert.equal(existsSync(join(f.directory, file.path)), false, file.path);
  assert.deepEqual(readFileSync(ordinaryPath), ordinaryBytes);
  assert.equal(existsSync(ordinaryRequestPath), true);
  assert.equal(existsSync(unfinishedPath), true);
  assert.ok(f.diagnostics.calls({ callId: ordinaryCallId }).length);
  assert.ok(f.diagnostics.calls({ callId: unfinishedCall.callId }).length);
  const retainedCall = f.diagnostics.calls({ callId: call.callId })[0];
  assert.equal(retainedCall.usage.inputTokens, 17);
  assert.equal(retainedCall.usage.outputTokens, 5);
  assert.equal(retainedCall.status, 'failed');
  assert.equal(retainedCall.phase, 'provider_rejected');
  assert.deepEqual(f.diagnostics.events({ callId: call.callId }), originalEvents);
  assert.equal(f.diagnostics.calls({ callId: call.callId })[0].requestRef.sha256, originalRows.requestRef.sha256);
  for (const artifact of ['request', 'response', 'input']) {
    assert.throws(() => f.diagnostics.artifact(call.callId, artifact), error => error instanceof DiagnosticPersistenceError && error.message === notice);
  }
  assert.equal(applyResearchCleanup(f.directory, plan, { now }).repeated, true);
});

test('the exact 30-day boundary is eligible and one millisecond early is protected', t => {
  const f = fixture(t);
  const boundary = f.create('boundary', { at: '2026-09-23T00:00:00.000Z' });
  const recent = f.create('recent', { at: '2026-09-23T00:00:00.001Z' });
  const plan = previewResearchCleanup(f.directory, { now });
  assert.ok(plan.candidates.some(candidate => candidate.taskId === boundary.id));
  assert.equal(plan.candidates.some(candidate => candidate.taskId === recent.id), false);
  assert.ok(plan.skipped.some(row => row.taskId === recent.id && row.reason === 'retention_30_days'));
});

test('locks and Pi sessions without a matching pa_run are listed as excluded and left untouched', t => {
  const f = fixture(t), task = f.create('excluded', { withPlan: true }), call = f.addCall(task);
  const keys = f.sessionKeys(task);
  assert.ok(keys.length > 1);
  const locked = f.writePi(keys[0], [call.runId]);
  const lockPath = join(f.directory, hash(keys[0]), 'conversation.lock');
  writeFileSync(lockPath, 'active lease');
  const unmatched = f.writePi(keys[1], [randomUUID()]);
  const piBytes = new Map([[locked.path, readFileSync(locked.absolute)], [unmatched.path, readFileSync(unmatched.absolute)]]);
  const indexPath = join(f.directory, 'diagnostics', 'index.sqlite'), indexBytes = readFileSync(indexPath);

  const lockedPlan = previewResearchCleanup(f.directory, { now });
  assert.equal(lockedPlan.candidates.some(item => item.taskId === task.id), false);
  assert.ok(lockedPlan.skipped.some(item => item.taskId === task.id && item.reason === 'active_research_session'));
  assert.deepEqual(readFileSync(locked.absolute), piBytes.get(locked.path));
  unlinkSync(lockPath);

  const plan = previewResearchCleanup(f.directory, { now });
  const candidate = plan.candidates.find(item => item.taskId === task.id);
  assert.ok(candidate);
  assert.ok(candidate.evidence.excluded.some(item => item.path === unmatched.path && item.reason === 'unverified_session'));
  assert.ok(candidate.files.some(file => file.path === locked.path));
  assert.equal(candidate.files.some(file => file.path === unmatched.path), false);
  assert.deepEqual(readFileSync(indexPath), indexBytes);
  assert.deepEqual(readFileSync(unmatched.absolute), piBytes.get(unmatched.path));
});

test('a committed manifest resumes after two approved diagnostics and Pi files were already unlinked', t => {
  const f = fixture(t), task = f.create('partial-unlink'), call = f.addCall(task);
  const pi = f.writePi(f.sessionKeys(task)[0], [call.runId]);
  const plan = previewResearchCleanup(f.directory, { now });
  const candidate = plan.candidates.find(item => item.taskId === task.id);
  const removed = [candidate.files.find(file => file.kind === 'diagnostic' && file.artifact === 'response'),
    candidate.files.find(file => file.kind === 'pi_session')];
  assert.ok(removed.every(Boolean));

  assert.throws(() => applyResearchCleanup(f.directory, plan, { now, afterCommit() {
    for (const file of removed) unlinkSync(join(f.directory, file.path));
    throw new Error('crash after two authorized unlinks');
  } }), /crash after two authorized unlinks/);
  assert.ok(removed.every(file => !existsSync(join(f.directory, file.path))));
  assert.equal(f.db.prepare('SELECT status FROM research_retention_runs').get().status, 'pending');
  assert.ok(candidate.files.filter(file => !removed.includes(file)).every(file => existsSync(join(f.directory, file.path))));

  assert.equal(applyResearchCleanup(f.directory, plan, { now }).status, 'done');
  assert.ok(candidate.files.every(file => !existsSync(join(f.directory, file.path))));
  assert.equal(existsSync(pi.absolute), false);
});

test('diagnostic index changes after the cleanup manifest commits block deletion and preserve files', t => {
  const f = fixture(t), task = f.create('index-changed'), call = f.addCall(task);
  const pi = f.writePi(f.sessionKeys(task)[0], [call.runId]);
  const plan = previewResearchCleanup(f.directory, { now });
  const candidate = plan.candidates.find(item => item.taskId === task.id);

  assert.throws(() => applyResearchCleanup(f.directory, plan, { now, afterCommit() {
    const changed = new DatabaseSync(join(f.directory, 'diagnostics', 'index.sqlite'));
    const row = changed.prepare('SELECT record_json FROM calls WHERE call_id=?').get(call.callId);
    const record = JSON.parse(row.record_json); record.phase = 'changed after manifest commit';
    changed.prepare('UPDATE calls SET record_json=? WHERE call_id=?').run(JSON.stringify(record), call.callId);
    changed.close();
  } }), /研究诊断索引已变化/);

  assert.equal(f.db.prepare('SELECT status FROM research_retention_runs').get().status, 'pending');
  assert.ok(candidate.files.every(file => existsSync(join(f.directory, file.path))));
  assert.equal(existsSync(pi.absolute), true);
});

test('a session lock appearing after the cleanup manifest commits blocks deletion and preserves files', t => {
  const f = fixture(t), task = f.create('lock-after-commit'), call = f.addCall(task);
  const key = f.sessionKeys(task)[0], pi = f.writePi(key, [call.runId]);
  const lockPath = join(f.directory, hash(key), 'conversation.lock');
  const plan = previewResearchCleanup(f.directory, { now });
  const candidate = plan.candidates.find(item => item.taskId === task.id);

  assert.throws(() => applyResearchCleanup(f.directory, plan, { now, afterCommit() {
    writeFileSync(lockPath, 'new active lease');
  } }), /研究证据归属、锁或内容已变化/);

  assert.equal(f.db.prepare('SELECT status FROM research_retention_runs').get().status, 'pending');
  assert.ok(candidate.files.every(file => existsSync(join(f.directory, file.path))));
  assert.equal(existsSync(pi.absolute), true);
});

test('a conversation registered on the derived research Pi path protects that file', t => {
  const f = fixture(t), task = f.create('ordinary-session-protected'), call = f.addCall(task);
  const key = f.sessionKeys(task)[0], pi = f.writePi(key, [call.runId]);
  f.db.prepare('UPDATE conversations SET pi_session_file=? WHERE id=?').run(pi.absolute, f.conversation.id);
  const plan = previewResearchCleanup(f.directory, { now });
  const candidate = plan.candidates.find(item => item.taskId === task.id);
  assert.ok(candidate);
  assert.equal(candidate.files.some(file => file.path === pi.path), false);
  assert.ok(candidate.evidence.excluded.some(file => file.path === pi.path && file.reason === 'ordinary_session_protected'));

  assert.equal(applyResearchCleanup(f.directory, plan, { now }).status, 'done');
  assert.equal(existsSync(pi.absolute), true);
  assert.ok(candidate.files.filter(file => file.path !== pi.path).every(file => !existsSync(join(f.directory, file.path))));
});

for (const fault of ['wrong artifact hash', 'cross-task call metadata', 'linked Pi session path']) test(`preview rejects ${fault}`, t => {
  const f = fixture(t), task = f.create(`fault-${fault}`), call = f.addCall(task);
  const pi = f.writePi(f.sessionKeys(task)[0], [call.runId]);
  if (fault === 'wrong artifact hash') {
    writeFileSync(join(f.directory, 'diagnostics', 'calls', call.callId, 'request.json'), '{"tampered":true}');
  } else if (fault === 'cross-task call metadata') {
    const index = new DatabaseSync(join(f.directory, 'diagnostics', 'index.sqlite'));
    const row = index.prepare('SELECT record_json FROM calls WHERE call_id=?').get(call.callId);
    const record = JSON.parse(row.record_json); record.taskId = 'R' + 'f'.repeat(32);
    index.prepare('UPDATE calls SET record_json=? WHERE call_id=?').run(JSON.stringify(record), call.callId);
    index.close();
  } else {
    const sourceDirectory = join(f.directory, hash(f.sessionKeys(task)[0]));
    const movedDirectory = join(f.directory, 'session-target');
    renameSync(sourceDirectory, movedDirectory);
    symlinkSync(movedDirectory, sourceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const plan = previewResearchCleanup(f.directory, { now });
  assert.equal(plan.candidates.some(candidate => candidate.taskId === task.id), false);
  assert.ok(plan.skipped.some(row => row.taskId === task.id && row.reason === 'missing_or_unsafe_artifacts'));
  assert.ok(existsSync(pi.absolute) || fault === 'linked Pi session path');
});

test('a v3 done manifest permits v4 to add diagnostic and Pi cleanup without changing tombstones', t => {
  const f = fixture(t), task = f.create('v3-upgrade', { withPlan: true }), call = f.addCall(task);
  const piSessions = f.sessionKeys(task).map(key => f.writePi(key, [call.runId]));
  const v4Preview = previewResearchCleanup(f.directory, { now });
  const original = v4Preview.candidates.find(candidate => candidate.taskId === task.id);
  assert.ok(original);
  const legacy = structuredClone(v4Preview);
  legacy.policy = 'research-content-30d-v3';
  const legacyCandidate = legacy.candidates.find(candidate => candidate.taskId === task.id);
  delete legacyCandidate.evidence;
  delete legacyCandidate.cleanupKind;
  legacyCandidate.files = legacyCandidate.files.filter(file => file.path.startsWith(`research/${task.id}/`));
  const legacyId = hash(JSON.stringify(legacy));

  const tombstoneRows = [];
  for (const [table, column] of [['research_evidence', 'evidence_json'], ['research_workflow_cycles', 'input_json']]) {
    for (const row of f.db.prepare(`SELECT rowid,${column} AS value FROM ${table} WHERE task_id=?`).all(task.id)) {
      const tombstone = JSON.stringify({ retained: false, cleanupId: legacyId, sha256: hash(row.value), bytes: Buffer.byteLength(row.value) });
      f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(tombstone, row.rowid);
      tombstoneRows.push({ table, rowid: row.rowid, column, value: tombstone });
    }
  }
  for (const file of legacyCandidate.files) unlinkSync(join(f.directory, file.path));
  f.db.exec(`CREATE TABLE research_retention_runs (
    id TEXT PRIMARY KEY, policy_version INTEGER NOT NULL, plan_json TEXT NOT NULL,
    post_hashes_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT
  )`);
  f.db.prepare('INSERT INTO research_retention_runs VALUES(?,1,?,? ,\'done\',?,?)')
    .run(legacyId, JSON.stringify(legacy), '{}', now.toISOString(), now.toISOString());

  const upgraded = previewResearchCleanup(f.directory, { now });
  const candidate = upgraded.candidates.find(item => item.taskId === task.id);
  assert.ok(candidate);
  assert.ok(candidate.files.some(file => file.kind === 'diagnostic' && file.callId === call.callId));
  assert.equal(candidate.files.some(file => file.kind === 'pi_session'), true);
  assert.equal(candidate.files.some(file => file.path.startsWith(`research/${task.id}/`)), false);
  assert.deepEqual(candidate.files.filter(file => file.kind === 'pi_session').map(file => file.path).sort(), piSessions.map(file => file.path).sort());

  applyResearchCleanup(f.directory, upgraded, { now });
  for (const file of candidate.files) assert.equal(existsSync(join(f.directory, file.path)), false);
  const tombstonesAfter = [];
  for (const row of tombstoneRows) {
    const current = f.db.prepare(`SELECT ${row.column} AS value FROM ${row.table} WHERE rowid=?`).get(row.rowid).value;
    tombstonesAfter.push({ ...row, current });
  }
  assert.ok(tombstonesAfter.every(row => row.current === row.value));
});
