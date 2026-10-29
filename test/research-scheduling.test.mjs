import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { ResearchService } from '../dist/research-service.js';

const budget = { maxModelCalls: 4, maxToolCalls: 8, maxSearchCalls: 2 };
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-research-scheduling-'));
  const store = new ConversationStore(join(directory, 'pa.sqlite'));
  const routes = ['A','B','outside'].map(roomId => ({ channel:'qq', accountId:'fixture', roomType:'group', roomId }));
  const rooms = routes.map(route => store.ensureConversation(route.roomId, `/fixture/${route.roomId}.jsonl`, route));
  let serial = 0;
  const create = (room = 0) => {
    const eventId = `event-${++serial}`;
    store.recordInbound(rooms[room].id, '研究资料整理', { eventId, senderId:'alice', sentAt:new Date().toISOString(), modelInputText:'研究资料整理' });
    const source = store.externalMessage(rooms[room].id, eventId);
    return store.research.create(rooms[room].id, source.id, { key:eventId, title:eventId, goal:'核验资料并生成研究报告' });
  };
  const finish = task => { store.research.claim(task.id, budget); return store.research.finish(task.id, task.attempt, { status:'failed', reason:'保留研究现场。' }); };
  const service = send => {
    const result = new ResearchService({ research:budget }, routes.slice(0,2), send, () => assert.fail('unexpected fatal research error'));
    result.store = store;
    return result;
  };
  t.after(() => { store.close(); rmSync(directory, { recursive:true, force:true }); });
  return { store, routes, rooms, create, finish, service };
}

test('SQL领取一项只读元信息，checkpoint及状态核验不展开旧证据，单材料读取保持原编号', t => {
  const f = fixture(t), outside = f.create(2), tasks = Array.from({ length:48 }, () => f.create());
  const evidence = JSON.stringify({ tool:'web_fetch', input:{ url:'https://example.com' }, result:'x'.repeat(100_000) });
  const insert = f.store.db.prepare('INSERT INTO research_evidence VALUES(?,?,?,?,?)');
  for (const task of [outside,...tasks]) insert.run(task.id,1,1,evidence,task.createdAt);
  // No broad task getter or material query may serve scheduling or checkpoint state.
  const get = f.store.research.get.bind(f.store.research), prepare = f.store.db.prepare.bind(f.store.db);
  const materialQueries = [];
  f.store.research.get = () => assert.fail('full task read from metadata path');
  f.store.db.prepare = sql => {
    if (/SELECT\s+(?:e\.)?evidence_json\s+FROM\s+research_evidence/i.test(sql)) materialQueries.push(sql);
    return prepare(sql);
  };
  const task = f.store.research.claimNext(budget,[f.routes[0]]);
  assert.ok(tasks.some(item => item.id === task.id));
  assert.equal(task.status,'running'); assert.equal('evidence' in task,false); assert.equal('followups' in task,false);
  assert.equal(prepare("SELECT count(*) AS n FROM research_tasks WHERE status='running'").get().n,1);
  assert.equal(f.store.research.metadata(outside.id).status,'queued');
  f.store.research.checkpoint(task.id,1,{ modelCalls:1, toolCalls:0, searchCalls:0 });
  assert.throws(() => f.store.research.checkpoint(task.id,1,{ modelCalls:0, toolCalls:0, searchCalls:0 }),/modelCalls/);
  assert.throws(() => f.store.research.checkpoint(task.id,2,{ modelCalls:1, toolCalls:0, searchCalls:0 }),/批次/);
  assert.throws(() => f.store.research.checkpoint(task.id,1,{ modelCalls:5, toolCalls:0, searchCalls:0 }),/modelCalls/);
  assert.equal(f.store.research.notificationObsolete(task.id,1),true);
  prepare("UPDATE research_tasks SET status='failed' WHERE id=?").run(task.id);
  assert.equal(f.store.research.nextNotification([f.routes[0]]).id,task.id);
  assert.equal(f.store.research.notificationObsolete(task.id,1),false);
  assert.deepEqual(materialQueries,[]);
  assert.deepEqual(f.store.research.evidence(task.id,1),JSON.parse(evidence));
  assert.equal(f.store.research.evidence(task.id,2),undefined);
  assert.equal(materialQueries.length,2); assert.ok(materialQueries.every(sql => /LIMIT 1 OFFSET \?/.test(sql)));
  f.store.db.prepare = prepare; f.store.research.get = get;
  assert.equal(get(task.id).evidence[0].result.length,100_000);
});

test('慢A房间通知不阻塞B研究；通知单并发且wait等待持久回执', async t => {
  const f = fixture(t), a = f.finish(f.create()), b = f.create(1), gate = deferred(), started = deferred();
  let sends = 0, peak = 0, running = 0, computed = false;
  const service = f.service(async message => {
    peak = Math.max(peak,++running); sends++;
    if (message.route.roomId === 'A') { started.resolve(); await gate.promise; }
    running--; return { status:'sent', externalMessageId:`notice-${sends}` };
  });
  service.run = async task => {
    assert.equal(task.id,b.id); computed = true;
    f.store.research.finish(task.id,task.attempt,{ status:'failed',reason:'B研究完成。' });
    service.wakeNotifications();
  };
  service.wake(); await started.promise; await turn();
  assert.equal(computed,true); assert.equal(sends,1); assert.equal(peak,1);
  assert.equal(f.store.research.metadata(b.id).status,'failed');
  assert.equal(f.store.db.prepare("SELECT status FROM research_deliveries WHERE task_id=?").get(a.id).status,'sending');
  let waited = false; const waiting = service.wait().then(() => { waited = true; });
  await turn(); assert.equal(waited,false);
  gate.resolve(); await waiting;
  assert.equal(sends,2); assert.equal(peak,1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM research_deliveries WHERE status='sent'").get().n,2);
  service.wake(); await service.wait(); assert.equal(sends,2);
});

test('通知在房间实际发送前复核归档、续作及关闭；重启未知投递不重发', async t => {
  const f = fixture(t), task = f.finish(f.create());
  let gate, entered, guardResult, sends = 0;
  const service = f.service(async (_message, shouldSend) => {
    sends++; entered.resolve(); await gate.promise;
    guardResult = shouldSend();
    return { status:guardResult ? 'sent' : 'rejected', ...(guardResult ? { externalMessageId:`notice-${sends}` } : {}) };
  });
  const begin = async () => { gate = deferred(); entered = deferred(); service.wakeNotifications(); await entered.promise; };
  await begin();
  f.store.research.archive(task.conversationId,task.sourceMessageId,{ ids:[task.id],reason:'用户明确归档。' });
  gate.resolve(); await service.wait(); assert.equal(guardResult,false);

  const continued = f.finish(f.create()); await begin();
  f.store.research.retry(continued.conversationId,continued.sourceMessageId,{ id:continued.id,key:'continue' });
  gate.resolve(); await service.wait(); assert.equal(guardResult,false);
  assert.equal(f.store.research.metadata(continued.id).status,'queued');

  const closing = f.finish(f.create()); await begin();
  const pending = f.finish(f.create(1));
  let stopped = false; const aborting = service.abort().then(() => { stopped = true; });
  await turn(); assert.equal(stopped,false);
  gate.resolve(); await aborting; assert.equal(guardResult,false);
  assert.equal(f.store.db.prepare('SELECT status FROM research_deliveries WHERE task_id=?').get(closing.id).status,'rejected');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM research_deliveries WHERE task_id=?').get(pending.id).n,0);
  f.store.research.reserveNotification(pending.id,1,'服务中断前已预约。');
  f.store.research.recover();
  assert.equal(f.store.db.prepare('SELECT status FROM research_deliveries WHERE task_id=?').get(pending.id).status,'uncertain');
  const restarted = f.service(async () => assert.fail('unknown delivery must not resend'));
  restarted.wakeNotifications(); await restarted.wait();
});
