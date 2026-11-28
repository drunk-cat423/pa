import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireTaskCoordinatorSchema, SCHEMA_VERSION } from './schema.js';

// Keep the queues separate: a long delivery backlog must not hide an execution awaiting reconciliation.
export const queueQueries = {
  queued: `SELECT q.task_id,q.revision,r.phase,r.created_at,r.deadline_at
    FROM task_dispatch_queue q JOIN task_revisions r USING(task_id,revision)
    ORDER BY q.queue_id LIMIT ?`,
  waitingInput: `SELECT task_id,revision,created_at,deadline_at FROM task_revisions
    WHERE phase='waiting_input' ORDER BY created_at,task_id,revision LIMIT ?`,
  recovery: `SELECT attempt_key,task_id,revision,worker_id,dispatch_state,next_recovery_at
    FROM task_attempts WHERE next_recovery_at IS NOT NULL ORDER BY next_recovery_at,attempt_key LIMIT ?`,
  undelivered: `SELECT notification_id,task_id,revision,status,created_at,detail FROM task_notifications
    WHERE status <> 'sent' ORDER BY notification_id LIMIT ?`,
};

function queues(db: DatabaseSync, limit: number) {
  return Object.fromEntries(Object.entries(queueQueries).map(([key, sql]) => [key, db.prepare(sql).all(limit)]));
}

function pools(db: DatabaseSync) {
  const config = db.prepare('SELECT limits_json FROM task_scheduler_policy WHERE singleton=1').get();
  const limits = config ? JSON.parse(String(config.limits_json)) as [number, number, [string, number][]] : undefined;
  const reservations = db.prepare(`SELECT r.resource_kind,r.resource_key,sum(r.units) AS occupied,
    sum(CASE WHEN v.phase IN ('reconciling','closed') THEN r.units ELSE 0 END) AS awaiting_confirmation
    FROM task_reservations r JOIN task_attempts a USING(attempt_key) JOIN task_revisions v USING(task_id,revision)
    WHERE r.released_at IS NULL AND r.resource_kind IN ('global','worker','pool')
    GROUP BY r.resource_kind,r.resource_key ORDER BY r.resource_kind,r.resource_key`).all();
  return { globalLimit: limits?.[0] ?? null, poolLimits: limits?.[2] ?? [], reservations };
}

export function queryOperations(db: DatabaseSync, args: readonly string[]) {
  const [command, id] = args;
  if (command === 'inspect' && args.length === 2 && id && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
    const task = db.prepare('SELECT task_id,head_revision,created_at FROM tasks WHERE task_id=?').get(id);
    if (!task) throw new Error('未找到任务。');
    const revision = task.head_revision!;
    return { task, revision: db.prepare(`SELECT r.revision,r.phase,r.capability,r.deadline_at,c.status AS outcome
      FROM task_revisions r LEFT JOIN task_conclusions c USING(task_id,revision)
      WHERE r.task_id=? AND r.revision=?`).get(id, revision),
      attempts: db.prepare(`SELECT attempt_key,worker_id,dispatch_state,created_at,ended_at,next_recovery_at FROM task_attempts
        WHERE task_id=? AND revision=? ORDER BY lease_generation DESC LIMIT 32`).all(id, revision),
      notifications: db.prepare(`SELECT notification_id,status,detail FROM task_notifications WHERE task_id=? AND revision=?
        AND recipient_owner=(SELECT owner FROM tasks WHERE task_id=?) ORDER BY notification_id DESC LIMIT 32`).all(id, revision, id) };
  }
  if (args.length === 1) {
    if (command === 'status') return { schemaVersion: SCHEMA_VERSION, oldest: queues(db, 1), capacity: pools(db) };
    if (command === 'backlog') return { limitPerQueue: 32, ...queues(db, 32) };
    if (command === 'pools') return pools(db);
  }
  throw new Error('用法：operations.js <数据库路径> status | backlog | pools | inspect <任务编号>');
}

export function readOperations(file: string, args: readonly string[]) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    requireTaskCoordinatorSchema(db);
    return queryOperations(db, args);
  } finally { db.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (!process.argv[2]) throw new Error('需要指定任务数据库路径。');
    console.log(JSON.stringify(readOperations(process.argv[2], process.argv.slice(3)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : '读取任务库失败。');
    process.exitCode = 1;
  }
}
