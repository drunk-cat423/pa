import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../dist/store.js';

const target = 'https://github.com/example-owner/DeepSeek-Bot';
const wrong = 'https://github.com/other-owner/ai-storyteller';
const proposal = (changes = {}) => ({ key:'implementation', title:'DeepSeek Bot 实现研究', goal:'检查源码实现及部署条件', urls:[target], ...changes });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-research-target-'));
  const path = join(directory, 'pa.sqlite'), store = new ConversationStore(path);
  const route = { channel:'qq', accountId:'fixture', roomType:'group', roomId:'group' };
  const conversation = store.ensureConversation('group', '/fixture/group.jsonl', route);
  const second = store.ensureConversation('other-group', '/fixture/other.jsonl', { ...route, roomId:'other-group' });
  const db = new DatabaseSync(path);
  let serial = 0;
  const message = (text, { senderId='alice', room=conversation, sentAt=new Date().toISOString(), quote, modelInputText=text } = {}) => {
    const eventId = `event-${++serial}`;
    store.recordInbound(room.id, text, { eventId, senderId, sentAt, modelInputText });
    const source = store.externalMessage(room.id, eventId);
    if (quote) store.enqueueChannelTask(room.id, source.id, { route, eventId, senderId, sentAt, text, mentioned:true, quote });
    return { ...source, eventId, conversationId:room.id };
  };
  const create = (source, input=proposal()) => store.research.create(source.conversationId, source.id, input);
  const count = () => Number(db.prepare('SELECT count(*) AS n FROM research_tasks').get().n);
  t.after(() => { db.close(); store.close(); rmSync(directory, { recursive:true, force:true }); });
  return { store, db, conversation, second, message, create, count };
}

test('明确承接继承最近同actor链接，群友新链接不会覆盖', t => {
  const f = fixture(t), anchor = f.message(target);
  f.message(wrong, { senderId:'bob' });
  const source = f.message('那把这个作为调研任务，重点看如何实现，能否摆脱现有方案');
  assert.deepEqual(f.store.research.targetContext(source.conversationId, source.id), { kind:'recent', sourceMessageId:anchor.id, urls:[target] });
  assert.throws(() => f.create(source, proposal({ urls:[wrong], title:'ai-storyteller' })), /链接不一致/);
  assert.equal(f.create(source).urls[0], target);
});
