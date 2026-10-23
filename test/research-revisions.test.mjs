import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { applyResearchCleanup, previewResearchCleanup } from '../scripts/deployment/research-retention.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const budget = { maxModelCalls: 16, maxToolCalls: 24, maxSearchCalls: 6 };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-research-revisions-'));
  const path = join(directory, 'pa.sqlite');
  let store = new ConversationStore(path), db = new DatabaseSync(path), index = 0;
  const route = { channel: 'qq', accountId: 'fixture', roomType: 'group', roomId: 'group' };
  const conversation = store.ensureConversation('revision-room', join(directory, 'room.jsonl'), route);
  const message = senderId => {
    const eventId = `revision-${++index}`;
    store.recordInbound(conversation.id, '研究续作请求', { eventId, senderId, sentAt: new Date().toISOString(), modelInputText: '研究续作请求' });
    return store.externalMessage(conversation.id, eventId);
  };
  const source = message('alice');
  const task = store.research.create(conversation.id, source.id, { key: 'initial', title: '研究版本替换', goal: '调查并保存结论' });
  t.after(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, conversation, source, task, message, get store() { return store; }, get db() { return db; },
    reopen() { db.close(); store.close(); store = new ConversationStore(path); db = new DatabaseSync(path); },
    claim() { return store.research.claim(task.id, budget); } };
}

test('完成任务可附加新增要求；续作键按来源和内容幂等，并拒绝越权及超限', t => {
  const f = fixture(t), task = f.task;
  f.claim();
  f.store.research.finish(task.id, 1, { status: 'completed', markdown: '# v1', abstract: '旧结论', keywords: ['旧'] });
  const owner = f.message('alice');
  const input = { id: task.id, key: 'revise-costs', requirements: '补充核验官方成本数据' };
  const queued = f.store.research.retry(task.conversationId, owner.id, input);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.attempt, 2);
  assert.deepEqual(queued.followups.map(item => item.requirements), ['补充核验官方成本数据']);
  assert.equal(f.db.prepare("SELECT count(*) n FROM research_evidence WHERE task_id=? AND attempt=2 AND ordinal=1 AND json_extract(evidence_json,'$.tool')='research_followup'").get(task.id).n, 1);
  assert.equal(f.store.research.retry(task.conversationId, owner.id, input).attempt, 2);
  assert.throws(() => f.store.research.retry(task.conversationId, owner.id, { ...input, requirements: '换成另一项要求' }), /不同的新增要求/);
  const other = f.message('bob');
  assert.throws(() => f.store.research.retry(task.conversationId, other.id, { id: task.id, key: 'other', requirements: '越权要求' }), /没有属于你的/);
  assert.throws(() => f.store.research.retry(task.conversationId, owner.id, { id: task.id, key: 'too-long', requirements: '🙂'.repeat(4001) }), /过长/);
  assert.equal(f.store.research.get(task.id).attempt, 2);
});

test('报告替换先保留旧版至新版本提交；旧正文明确失效且元数据哈希保留', t => {
  const f = fixture(t), task = f.task, root = join(f.directory, 'research', task.id);
  f.claim();
  const oldMarkdown = '# 正式报告 v1\n\n旧正文';
  f.store.research.finish(task.id, 1, { status: 'completed', markdown: oldMarkdown, abstract: '旧摘要', keywords: ['旧'] });
  const oldReportRow = f.db.prepare('SELECT * FROM research_reports WHERE task_id=? AND version=1').get(task.id);
  const oldPath = join(root, '1.md'), oldTxtPath = join(root, '1.txt');
  assert.equal(readFileSync(oldPath, 'utf8'), oldMarkdown);

  const owner = f.message('alice');
  f.store.research.retry(task.conversationId, owner.id, { id: task.id, key: 'revision', requirements: '补充新的证据' });
  f.claim();
  f.store.research.finish(task.id, 2, { status: 'failed', reason: '新报告未完成' });
  assert.equal(readFileSync(oldPath, 'utf8'), oldMarkdown);
  assert.equal(f.store.research.get(task.id).reportVersion, 1);

  const retrySource = f.message('alice');
  f.store.research.retry(task.conversationId, retrySource.id, { id: task.id, key: 'finish-revision', requirements: '补充新的证据' });
  f.claim();
  f.store.research.finish(task.id, 3, { status: 'interrupted', reason: '新报告提交前进程中断' });
  assert.equal(readFileSync(oldPath, 'utf8'), oldMarkdown);
  const lastSource = f.message('alice');
  f.store.research.retry(task.conversationId, lastSource.id, { id: task.id, key: 'recover-revision', requirements: '补充新的证据' });
  f.claim();
  const newMarkdown = '# 正式报告 v2\n\n新增证据已核验';
  f.store.research.finish(task.id, 4, { status: 'completed', markdown: newMarkdown, abstract: '新结论及剩余缺口', keywords: ['新'] });
  assert.equal(f.store.research.get(task.id).reportVersion, 2);
  assert.equal(existsSync(oldPath), false);
  assert.equal(existsSync(oldTxtPath), false);
  assert.throws(() => f.store.research.report(task.id, 1), /已被 v2 替换/);
  const retained = f.db.prepare('SELECT content_hash,status,abstract FROM research_reports WHERE task_id=? AND version=1').get(task.id);
  assert.equal(retained.content_hash, oldReportRow.content_hash);
  assert.equal(retained.status, oldReportRow.status);
  assert.equal(retained.abstract, oldReportRow.abstract);
  assert.equal(retained.content_hash, hash(oldMarkdown));

  // Simulate a crash after the new pointer commits but before cleanup, then ensure recovery replays cleanup.
  writeFileSync(oldPath, oldMarkdown); writeFileSync(oldTxtPath, oldMarkdown);
  f.store.research.recover();
  assert.equal(existsSync(oldPath), false);
  assert.equal(existsSync(oldTxtPath), false);
  assert.equal(f.db.prepare('SELECT content_hash FROM research_reports WHERE task_id=? AND version=1').get(task.id).content_hash, hash(oldMarkdown));

  // Expiry walks retained report metadata while accepting already superseded bodies.
  f.db.prepare('UPDATE research_tasks SET updated_at=? WHERE id=?').run('2026-09-01T00:00:00.000Z', task.id);
  f.db.prepare('UPDATE research_attempts SET updated_at=? WHERE task_id=? AND attempt=4').run('2026-09-01T00:00:00.000Z', task.id);
  const now = new Date('2026-10-23T00:00:00.000Z');
  assert.ok(f.store.research.pendingNotifications().some(item => item.id === task.id));
  const cleanupPlan = previewResearchCleanup(f.directory, { now });
  assert.deepEqual(cleanupPlan.candidates.map(candidate => candidate.taskId), [task.id]);
  assert.ok(cleanupPlan.candidates[0].files.some(file => file.path === `research/${task.id}/2.md`));
  assert.equal(applyResearchCleanup(f.directory, cleanupPlan, { now }).status, 'done');
  assert.equal(f.store.research.pendingNotifications().some(item => item.id === task.id), false);
  assert.equal(existsSync(join(root, '2.md')), false);
  assert.equal(existsSync(join(root, '2.txt')), false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM research_reports WHERE task_id=?').get(task.id).n, 2);
});

for (const deliveryStatus of ['sent', 'rejected']) {
  test(`新版提交期间保留sending旧报告，投递${deliveryStatus}后再清理`, t => {
    const f = fixture(t), task = f.task, root = join(f.directory, 'research', task.id);
    f.claim();
    f.store.research.finish(task.id, 1, { status: 'completed', markdown: '# v1 仍在投递', abstract: 'v1 摘要', keywords: [] });
    const oldPath = join(root, '1.md'), oldTxtPath = join(root, '1.txt');
    const delivery = f.store.research.reserveDelivery(f.conversation.id, f.source.id, { id: task.id, format: 'md' });
    assert.equal(delivery.shouldSend, true);
    assert.equal(delivery.status, 'sending');

    const owner = f.message('alice');
    f.store.research.retry(task.conversationId, owner.id, { id: task.id, key: `replace-during-${deliveryStatus}`, requirements: '更新报告' });
    f.claim();
    f.store.research.finish(task.id, 2, { status: 'completed', markdown: '# v2 最新报告', abstract: 'v2 摘要', keywords: ['最新'] });
    assert.equal(existsSync(oldPath), true);
    assert.equal(existsSync(oldTxtPath), true);
    assert.equal(f.store.research.report(task.id, 2).markdown, '# v2 最新报告');

    f.store.research.finishDelivery(delivery.deliveryId, deliveryStatus,
      deliveryStatus === 'sent' ? 'platform-message-v1' : undefined);
    assert.equal(existsSync(oldPath), false);
    assert.equal(existsSync(oldTxtPath), false);
    assert.equal(f.store.research.report(task.id, 2).markdown, '# v2 最新报告');
  });
}

test('新版报告元数据提交失败并恢复时保留旧指针和正文文件', t => {
  const f = fixture(t), task = f.task, root = join(f.directory, 'research', task.id);
  f.claim();
  const oldMarkdown = '# 可用的旧报告';
  f.store.research.finish(task.id, 1, { status: 'completed', markdown: oldMarkdown, abstract: '旧报告摘要', keywords: [] });
  const oldPath = join(root, '1.md'), oldTxtPath = join(root, '1.txt');
  const owner = f.message('alice');
  f.store.research.retry(task.conversationId, owner.id, { id: task.id, key: 'metadata-failure', requirements: '更新报告' });
  f.claim();
  f.db.exec(`CREATE TRIGGER reject_report_v2 BEFORE INSERT ON research_reports
    WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'simulated report metadata failure'); END;`);

  assert.throws(() => f.store.research.finish(task.id, 2, {
    status: 'completed', markdown: '# 新正文尚未提交', abstract: '不应发布的摘要', keywords: [],
  }), /simulated report metadata failure/);
  assert.equal(f.store.research.get(task.id).reportVersion, 1);
  assert.equal(readFileSync(oldPath, 'utf8'), oldMarkdown);
  assert.equal(readFileSync(oldTxtPath, 'utf8'), oldMarkdown);

  f.db.exec('DROP TRIGGER reject_report_v2');
  f.store.research.recover();
  assert.equal(f.store.research.get(task.id).status, 'interrupted');
  assert.equal(f.store.research.get(task.id).reportVersion, 1);
  assert.equal(f.store.research.report(task.id, 1).markdown, oldMarkdown);
  assert.equal(readFileSync(oldPath, 'utf8'), oldMarkdown);
  assert.equal(readFileSync(oldTxtPath, 'utf8'), oldMarkdown);
});
