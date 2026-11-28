import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { TaskDeliveryStore } from '../dist/task-coordinator/delivery-store.js';
import { TaskDeliveryWorker } from '../dist/task-coordinator/delivery.js';
import { hasQQCoordinatorCutover } from '../dist/task-coordinator/qq-router.js';
import { WorkerRegistry } from '../dist/task-coordinator/registry.js';
import { TaskScheduler } from '../dist/task-coordinator/scheduler.js';
import { TaskCoordinatorStore } from '../dist/task-coordinator/store.js';

// Frozen SQLite written by the P5 coordinator, scheduler and delivery worker at
// dc2d38cf31ba40a291d23ee0fb3d1aa7f8701971. All identities, work and receipts
// are synthetic. Keeping the original database avoids recreating v4 with v5 code.
const fixture = new URL('./fixtures/task-coordinator-v4.sqlite.gz', import.meta.url);
const owner = 'synthetic-owner';

function snapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'task%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({name}) => {
    assert.match(name, /^tasks?$|^task_[a-z_]+$/);
    return [name, db.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all()];
  }));
}

test('P6 upgrades a populated v4 database without replaying execution or delivery', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-v4-upgrade-'));
  const file = join(dir, 'task-coordinator.sqlite');
  writeFileSync(file, gunzipSync(readFileSync(fixture)));
  const audit = new DatabaseSync(file, { readOnly: true });
  let store, delivery, scheduler, sender;
  t.after(async () => {
    await sender?.close();
    await scheduler?.close();
    delivery?.close();
    store?.close();
    audit.close();
    rmSync(dir, {recursive:true,force:true});
  });

  const version = () => audit.prepare('PRAGMA user_version').get().user_version;
  const indexes = () => audit.prepare("SELECT name FROM sqlite_schema WHERE type='index' ORDER BY name").all().map(r => r.name);
  assert.equal(version(), 4);
  assert.equal(hasQQCoordinatorCutover(dir), false, 'an independent v4 database never opted into QQ');
  const oldIndexes = indexes();
  const oldData = snapshot(audit);
  const pending = oldData.task_attempts.find(row => row.dispatch_state === 'possibly_sent');
  assert.ok(pending);
  assert.equal(oldData.task_notifications[0].status, 'unknown');
  assert.equal(oldData.task_attempts.length, 2);
  const oldLive = oldData.task_reservations.filter(r => r.released_at === null);
  assert.ok(oldLive.some(r => r.resource_kind === 'pool' && r.attempt_key === pending.attempt_key));

  // First application open migrates. The second open exercises normal process restart.
  store = new TaskCoordinatorStore(file);
  assert.equal(version(), 5);
  assert.equal(hasQQCoordinatorCutover(dir), false, 'schema upgrade alone does not transfer QQ ownership');
  assert.deepEqual(indexes(), [...oldIndexes, 'task_waiting_input_age', 'task_undelivered'].sort());
  assert.deepEqual(snapshot(audit), oldData);
  store.close();
  store = new TaskCoordinatorStore(file);
  delivery = new TaskDeliveryStore(file);
  assert.deepEqual(snapshot(audit), oldData);
  assert.deepEqual(audit.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(audit.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

  const completed = store.lookupRequest(owner,'completed');
  assert.equal(delivery.result(owner,completed).conclusion.status, 'succeeded');
  const result = delivery.readArtifact(owner,completed,'result.md');
  assert.deepEqual(Buffer.from(result.bytes), Buffer.from('# 合成结果\r\n第一版\n'));
  const notificationId = oldData.task_notifications[0].notification_id;
  assert.deepEqual(delivery.delivery(owner,notificationId).parts.map(part => part.status), ['sent','unknown']);

  // Resume normal polling at the old attempt's next scheduled reconciliation.
  // A possibly charged call may be inspected by its original key; repeating start is unsafe.
  const clock = () => pending.next_recovery_at;
  const observations = { starts: 0, sends: 0, inspected: [] };
  const workerId = pending.worker_id;
  const registry = new WorkerRegistry();
  registry.register({
    declaration: {
      workerId, protocolVersion: 1, effects: 'external',
      capabilities: [{name:'write', inputFormats:[], outputFormats:['text/markdown'], requiredPermissions:[]}],
      resources: [{poolId:'fixture-pool',units:1}],
      limits: {maxConcurrent:2, operationTimeoutMs:2000, reportBytes:8192},
      idempotentStart: false, canResume: true, canInspect: true, canStop: false,
    },
    async start() { observations.starts++; return {disposition:'unknown'}; },
    async inspect(attempt) { observations.inspected.push(attempt.attemptKey); return {disposition:'unknown'}; },
  });
  scheduler = new TaskScheduler({store, registry, now:clock, maxConcurrent:2,
    poolLimits:new Map([['fixture-pool',2]]), connectionSecrets:new Map([[workerId,'a'.repeat(64)]])});
  sender = new TaskDeliveryWorker(delivery, {
    resolveRoute: () => ({roomKey:'fixture-room',recipientKey:'fixture-recipient'}),
    async sendPart() { observations.sends++; return {status:'unknown'}; },
  }, {now:clock});
  const round = scheduler.tick();
  await Promise.all([...round.dispatches, ...round.recoveries]);
  assert.equal(await sender.tick(), false);
  assert.deepEqual(observations, {starts:0,sends:0,inspected:[pending.attempt_key]});
  assert.equal(scheduler.usage().global, 1);
  assert.equal(delivery.delivery(owner, notificationId).status, 'unknown');
  t.diagnostic('v4→v5 preserved ' + oldData.tasks.length + ' tasks, 2 attempts, the Markdown bytes, the unknown delivery and the active reservation; inspected once, replayed zero.');
});
