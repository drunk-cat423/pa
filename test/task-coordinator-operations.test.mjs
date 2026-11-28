import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TaskCoordinatorStore } from '../dist/task-coordinator/store.js';
import { overdueRevisionsQuery } from '../dist/task-coordinator/scheduler-store.js';
import { queryOperations, queueQueries } from '../dist/task-coordinator/operations.js';

test('V12 offline operations stay bounded and read-only with 10000 closed revisions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-ops-'));
  const file = join(dir, 'tasks.sqlite');
  new TaskCoordinatorStore(file).close();
  const db = new DatabaseSync(file);
  const admin = new DatabaseSync(file, { readOnly: true });
  t.after(() => { admin.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const queued = '00000000-0000-4000-8000-000000000001';
  db.exec(`BEGIN;
    INSERT INTO tasks VALUES ('${queued}','owner','qq1',1,1),('unknown','owner','qq2',1,2);
    INSERT INTO task_revisions(task_id,revision,goal,capability,materials_json,deadline_at,budget,phase,created_at)
      VALUES ('${queued}',1,'private','write','[]',5000,1,'queued',1),('unknown',1,'private','write','[]',5000,1,'closed',2);
    INSERT INTO task_dispatch_queue(owner,task_id,revision) VALUES ('owner','${queued}',1);
    INSERT INTO task_conclusions VALUES ('unknown',1,'outcome_unknown','private',3);
    INSERT INTO task_notifications(task_id,revision,recipient_owner,purpose,status,created_at) VALUES ('unknown',1,'owner','final','pending',3);
    INSERT INTO task_scheduler_workers VALUES ('worker','{}');
    INSERT INTO task_attempts(attempt_key,task_id,revision,worker_id,lease_generation,attempt_token,can_resume,permissions_json,dispatch_state,created_at,next_recovery_at)
      VALUES ('attempt','unknown',1,'worker',1,'secret',0,'[]','possibly_sent',2,5);
    INSERT INTO task_reservations(attempt_key,resource_kind,resource_key,units,acquired_at) VALUES ('attempt','pool','model',1,2);
    COMMIT`);
  const blocked = [];
  admin.setAuthorizer((action, table, column) => {
    if (action === constants.SQLITE_READ && ['goal','materials_json','summary','bytes','attempt_token','event_json'].includes(column)) {
      blocked.push([table, column]);
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
  function sample(label) {
    const times = [];
    let backlog;
    for (let i = 0; i < 32; i++) {
      const start = performance.now();
      backlog = queryOperations(admin, ['backlog']);
      times.push(performance.now() - start);
    }
    times.sort((a,b) => a-b);
    t.diagnostic(label + ' backlog ms p50=' + times[16].toFixed(3) + ' p95=' + times[30].toFixed(3));
    assert.equal(backlog.queued[0].task_id, queued);
    assert.equal(backlog.undelivered[0].task_id, 'unknown');
    assert.equal(backlog.recovery[0].attempt_key, 'attempt');
    assert.equal(queryOperations(admin, ['status']).capacity.reservations[0].awaiting_confirmation, 1);
    assert.equal(queryOperations(admin, ['inspect', queued]).revision.phase, 'queued');
    return backlog;
  }
  const before = sample('baseline');
  db.exec(`BEGIN;
    WITH RECURSIVE ids(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM ids WHERE i<10000)
      INSERT INTO tasks SELECT 'old-'||i,'owner','old-'||i,1,i FROM ids;
    INSERT INTO task_revisions(task_id,revision,goal,capability,materials_json,deadline_at,budget,phase,created_at)
      SELECT task_id,1,'private history','write','[]',5000,1,'closed',1 FROM tasks WHERE task_id LIKE 'old-%';
    INSERT INTO task_conclusions SELECT task_id,1,'succeeded','private history',2 FROM tasks WHERE task_id LIKE 'old-%';
    INSERT INTO task_notifications(task_id,revision,recipient_owner,purpose,status,created_at)
      SELECT task_id,1,'owner','final','sent',2 FROM tasks WHERE task_id LIKE 'old-%';
    COMMIT`);
  assert.deepEqual(sample('10000 closed'), before);
  for (const [key, sql] of Object.entries(queueQueries)) {
    const plan = admin.prepare('EXPLAIN QUERY PLAN ' + sql).all(32).map(row => row.detail).join(' / ');
    t.diagnostic(key + ' ' + plan);
    assert.doesNotMatch(plan, /TEMP B-TREE|SCAN (?:r|task_revisions|task_notifications|task_attempts)(?:$| \/)/);
    const expected = {queued:'SCAN q', waitingInput:'task_waiting_input_age', recovery:'task_attempts_recovery', undelivered:'task_undelivered'};
    assert.ok(plan.includes(expected[key]), plan);
  }
  const expiryPlan = admin.prepare('EXPLAIN QUERY PLAN ' + overdueRevisionsQuery).all(5000, 1).map(row => row.detail).join(' / ');
  assert.match(expiryPlan, /task_revisions_expiry/);
  assert.doesNotMatch(expiryPlan, /TEMP B-TREE/);
  assert.equal(admin.prepare(overdueRevisionsQuery).all(5000, 1)[0].task_id, queued);
  t.diagnostic('scheduler expiry ' + expiryPlan);
  assert.deepEqual(blocked, []);
  assert.throws(() => admin.exec('DELETE FROM task_notifications'), /readonly|authorized/i);
  for (const command of ['dispatch', 'report']) {
    const child = spawnSync(process.execPath, ['dist/task-coordinator/operations.js',file,command], {encoding:'utf8'});
    assert.equal(child.status, 1);
    assert.match(child.stderr, /用法/);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, 10002);
  assert.equal(db.prepare('SELECT count(*) n FROM task_notifications').get().n, 10001);
  assert.deepEqual(sample('after rejected commands'), before);
});
