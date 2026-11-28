import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { inImmediateTransaction } from './schema.js';
import type { TaskDispatchSpec, TaskOutcome, TaskPhase, TaskReceipt } from './store.js';
import { WORKER_PROTOCOL_VERSION } from './worker-contract.js';
import type {
  AuthenticatedWorkerReport, WorkerAttemptFence, WorkerAttemptKey, WorkerDeclaration, WorkerRecordDisposition,
  WorkerRequirements,
} from './worker-contract.js';
import type { StartDisposition, StoredWorkerAttempt, WorkerAttemptPort } from './worker-endpoint.js';

export interface SchedulingLimits {
  readonly maxConcurrent: number;
  readonly maxConcurrentPerOwner: number;
  readonly poolLimits: ReadonlyMap<string, number>;
}

export interface SchedulingUsage {
  readonly global: number;
  readonly workers: ReadonlyMap<string, number>;
  readonly pools: ReadonlyMap<string, number>;
  readonly workspaces: ReadonlySet<string>;
}

export interface SchedulingRound {
  readonly examined: number;
  readonly attempts: readonly WorkerAttemptKey[];
}

type ResourceKind = 'global' | 'owner' | 'worker' | 'pool' | 'workspace';
type Resource = { kind: ResourceKind; key: string; units: number };
type Usage = Record<ResourceKind, Map<string, number>>;

type Candidate = {
  queue_id: number; task_id: string; revision: number; owner: string; phase: 'queued' | 'waiting_dependency';
  capability: string; dispatch_json: string | null; deadline_at: number; resume_worker_id: string | null;
};

type AttemptRow = {
  attempt_key: string; task_id: string; revision: number; worker_id: string; lease_generation: number;
  attempt_token: string; permissions_json: string; dispatch_state: 'unsent' | 'possibly_sent' | 'accepted' | 'rejected';
  last_event_seq: number; ended_at: number | null;
  owner: string; phase: TaskPhase; capability: string; dispatch_json: string | null;
  goal: string; materials_json: string; deadline_at: number; budget: number;
  resume_attempt_key: string | null; resume_revision: number | null; resume_external_id: string | null;
};

type ClaimOptions = {
  limits: SchedulingLimits;
  scanLimit: number;
  now: number;
  permissions(owner: string): ReadonlySet<string>;
  select(requirements: WorkerRequirements, permissions: ReadonlySet<string>, hasCapacity: (worker: WorkerDeclaration) => boolean): WorkerDeclaration | undefined;
};

function requirementsFor(capability: string, dispatch: TaskDispatchSpec): WorkerRequirements {
  return { protocolVersion: WORKER_PROTOCOL_VERSION, capability,
    inputFormats: dispatch.inputFormats ?? [], outputFormats: dispatch.outputFormats ?? [] };
}

function receiptFor(attempt: AttemptRow): TaskReceipt {
  return { taskId: attempt.task_id, revision: attempt.revision };
}

function workspaceFor(owner: string, taskId: string, dispatch: TaskDispatchSpec): string {
  if (!dispatch.workspaceKey) return taskId;
  return `workspace:${createHash('sha256').update(JSON.stringify([owner, dispatch.workspaceKey])).digest('hex')}`;
}

function resourcesFor(owner: string, worker: WorkerDeclaration, workspace: string): Resource[] {
  return [
    { kind: 'global', key: '', units: 1 }, { kind: 'owner', key: owner, units: 1 },
    { kind: 'worker', key: worker.workerId, units: 1 }, { kind: 'workspace', key: workspace, units: 1 },
    ...worker.resources.map(({ poolId, units }) => ({ kind: 'pool' as const, key: poolId, units })),
  ];
}

function used(usage: Usage, kind: ResourceKind, key: string): number {
  return usage[kind].get(key) ?? 0;
}

function ownsFence(attempt: AttemptRow | undefined, key: WorkerAttemptKey): attempt is AttemptRow {
  return !!attempt && attempt.worker_id === key.workerId && attempt.lease_generation === key.leaseGeneration;
}

function canReport(attempt: AttemptRow): boolean {
  return attempt.ended_at === null && (attempt.phase === 'running' || attempt.phase === 'reconciling');
}

export function closeTaskRevision(db: DatabaseSync, owner: string, { taskId, revision }: TaskReceipt,
  outcome: TaskOutcome, phase: TaskPhase, now: number): void {
  const update = db.prepare("UPDATE task_revisions SET phase = 'closed' WHERE task_id = ? AND revision = ? AND phase = ?")
    .run(taskId, revision, phase);
  if (update.changes !== 1) throw new Error('Task phase compare-and-set failed.');
  db.prepare('INSERT INTO task_conclusions (task_id, revision, status, summary, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, revision, outcome.status, outcome.summary, now);
  db.prepare(`INSERT INTO task_notifications (task_id, revision, recipient_owner, purpose, status, created_at)
    VALUES (?, ?, ?, 'automatic', 'pending', ?)`).run(taskId, revision, owner, now);
  db.prepare('DELETE FROM task_dispatch_queue WHERE task_id = ? AND revision = ?').run(taskId, revision);
}

/** All state transitions run on the same SQLite connection as task admission. */
export class TaskSchedulingStore {
  constructor(private readonly db: DatabaseSync) {}

  workerPort(now: () => number): WorkerAttemptPort {
    return {
      getAttempt: attemptKey => this.getAttempt(attemptKey),
      claimStart: fence => this.claimStart(fence),
      recordReport: report => this.recordReport(report, now()),
    };
  }

  configure(limits: SchedulingLimits, workers: readonly WorkerDeclaration[]): void {
    const pools = [...limits.poolLimits].sort(([a], [b]) => a < b ? -1 : Number(a > b));
    const policy = JSON.stringify([limits.maxConcurrent, limits.maxConcurrentPerOwner, pools]);
    inImmediateTransaction(this.db, () => {
      this.db.prepare('INSERT INTO task_scheduler_policy (singleton, limits_json) VALUES (1, ?) ON CONFLICT DO NOTHING').run(policy);
      if (this.db.prepare('SELECT limits_json FROM task_scheduler_policy WHERE singleton = 1').get()?.limits_json !== policy) {
        throw new Error('inconsistent_scheduler_limits');
      }
      for (const worker of workers) {
        const resources = worker.resources.map(({ poolId, units }) => [poolId, units] as const)
          .sort(([a], [b]) => a < b ? -1 : Number(a > b));
        const capacity = JSON.stringify([worker.limits.maxConcurrent, resources]);
        this.db.prepare(`INSERT INTO task_scheduler_workers (worker_id, capacity_json) VALUES (?, ?)
          ON CONFLICT DO NOTHING`).run(worker.workerId, capacity);
        if (this.db.prepare('SELECT capacity_json FROM task_scheduler_workers WHERE worker_id = ?')
          .get(worker.workerId)?.capacity_json !== capacity) throw new Error('inconsistent_worker_capacity');
      }
    });
  }

  usage(): SchedulingUsage {
    const usage = this.readUsage();
    return { global: used(usage, 'global', ''), workers: usage.worker, pools: usage.pool,
      workspaces: new Set(usage.workspace.keys()) };
  }

  claimRound({ limits, scanLimit, now, permissions, select }: ClaimOptions): SchedulingRound {
    return inImmediateTransaction(this.db, () => {
      const usage = this.readUsage();
      const attempts: WorkerAttemptKey[] = [];
      const examinedQueues = new Set<number>();
      const exhaustedOwners = new Set<string>();
      const permissionsByOwner = new Map<string, ReadonlySet<string>>();
      let lastOwner = this.db.prepare('SELECT last_owner FROM task_scheduler_policy WHERE singleton = 1').get()?.last_owner as string;
      const initialOwner = lastOwner;

      while (examinedQueues.size < scanLimit && used(usage, 'global', '') < limits.maxConcurrent) {
        const owner = this.nextOwner(lastOwner, exhaustedOwners);
        if (owner === undefined) break;
        const { candidate, scanEndId } = this.nextCandidate(owner);
        if (examinedQueues.has(candidate.queue_id)) {
          exhaustedOwners.add(owner);
          continue;
        }
        lastOwner = owner;
        examinedQueues.add(candidate.queue_id);
        this.db.prepare(`INSERT INTO task_scheduler_cursors (owner, queue_id, scan_end_id) VALUES (?, ?, ?)
          ON CONFLICT(owner) DO UPDATE SET queue_id = excluded.queue_id, scan_end_id = excluded.scan_end_id`)
          .run(owner, candidate.queue_id, scanEndId);

        if (candidate.deadline_at <= now || !this.resolveDependencies(candidate)
          || used(usage, 'owner', owner) >= limits.maxConcurrentPerOwner) continue;
        const dispatch = JSON.parse(candidate.dispatch_json ?? '{}') as TaskDispatchSpec;
        const workspace = workspaceFor(owner, candidate.task_id, dispatch);
        if (used(usage, 'workspace', workspace) > 0) continue;

        const allowed = permissionsByOwner.get(owner) ?? permissions(owner);
        permissionsByOwner.set(owner, allowed);
        const worker = select(requirementsFor(candidate.capability, dispatch), allowed, declaration =>
          (candidate.resume_worker_id === null || (declaration.workerId === candidate.resume_worker_id && declaration.canResume))
          && used(usage, 'worker', declaration.workerId) < declaration.limits.maxConcurrent
          && declaration.resources.every(({ poolId, units }) =>
            units <= (limits.poolLimits.get(poolId) ?? 0) - used(usage, 'pool', poolId)));
        if (!worker) continue;

        const resources = resourcesFor(owner, worker, workspace);
        const attempt = this.reserve(candidate, worker, allowed, resources, now);
        attempts.push(attempt);
        for (const { kind, key, units } of resources) usage[kind].set(key, used(usage, kind, key) + units);
      }

      if (lastOwner !== initialOwner) {
        this.db.prepare('UPDATE task_scheduler_policy SET last_owner = ? WHERE singleton = 1').run(lastOwner);
      }
      return { examined: examinedQueues.size, attempts };
    });
  }

  finishStart(key: WorkerAttemptKey, result: StartDisposition, now: number): void {
    if (result.disposition === 'rejected' && result.reason === 'dispatch_not_claimed') return;
    inImmediateTransaction(this.db, () => {
      const attempt = this.readAttempt(key.attemptKey);
      if (!ownsFence(attempt, key)) return;
      if (result.disposition === 'rejected') {
        if (!canReport(attempt)) return;
        this.db.prepare("UPDATE task_attempts SET dispatch_state = 'rejected' WHERE attempt_key = ?").run(key.attemptKey);
        this.finishAttempt(attempt, { status: 'failed', summary: `Worker refused to start (${result.reason}).` }, 'start_rejected', now);
        return;
      }
      if (attempt.dispatch_state !== 'possibly_sent') return;
      this.db.prepare('UPDATE task_attempts SET dispatch_state = ?, external_id = ? WHERE attempt_key = ?')
        .run(result.disposition === 'accepted' ? 'accepted' : 'possibly_sent', result.externalId ?? null, key.attemptKey);
      if (result.disposition === 'unknown' && canReport(attempt)) {
        this.db.prepare("UPDATE task_revisions SET phase = 'reconciling' WHERE task_id = ? AND revision = ? AND phase = 'running'")
          .run(attempt.task_id, attempt.revision);
      }
    });
  }

  private readUsage(): Usage {
    const usage: Usage = { global: new Map(), owner: new Map(), worker: new Map(), pool: new Map(), workspace: new Map() };
    const rows = this.db.prepare(`SELECT resource_kind, resource_key, sum(units) AS units FROM task_reservations
      WHERE released_at IS NULL GROUP BY resource_kind, resource_key`).all();
    for (const row of rows) usage[row.resource_kind as ResourceKind].set(String(row.resource_key), Number(row.units));
    return usage;
  }

  private nextOwner(lastOwner: string, excluded: Set<string>): string | undefined {
    const skipped = JSON.stringify([...excluded]);
    const next = this.db.prepare(`SELECT owner FROM task_dispatch_queue WHERE owner > ?
      AND owner NOT IN (SELECT value FROM json_each(?)) ORDER BY owner LIMIT 1`);
    return (next.get(lastOwner, skipped) ?? next.get('', skipped))?.owner as string | undefined;
  }

  private nextCandidate(owner: string): { candidate: Candidate; scanEndId: number } {
    const cursor = this.db.prepare('SELECT queue_id, scan_end_id FROM task_scheduler_cursors WHERE owner = ?').get(owner);
    const next = this.db.prepare(`SELECT q.*, r.phase, r.capability, r.dispatch_json, r.deadline_at, prior.worker_id AS resume_worker_id
      FROM task_dispatch_queue q JOIN task_revisions r USING (task_id, revision)
      LEFT JOIN task_attempts prior ON prior.attempt_key = r.resume_attempt_key
      WHERE q.owner = ? AND q.queue_id > ? AND q.queue_id <= ?
      ORDER BY q.queue_id LIMIT 1`);
    const current = next.get(owner, cursor?.queue_id ?? 0, cursor?.scan_end_id ?? 0);
    if (current) return { candidate: current as Candidate, scanEndId: Number(cursor?.scan_end_id) };
    // Freeze the next pass so new submissions cannot keep an older row behind the cursor forever.
    const tail = this.db.prepare('SELECT queue_id FROM task_dispatch_queue WHERE owner = ? ORDER BY queue_id DESC LIMIT 1').get(owner);
    const scanEndId = Number(tail?.queue_id);
    const candidate = next.get(owner, 0, scanEndId);
    if (!candidate) throw new Error('Task queue owner has no candidate.');
    return { candidate: candidate as Candidate, scanEndId };
  }

  private resolveDependencies(candidate: Candidate): boolean {
    if (candidate.phase === 'queued') return true;
    const blocked = this.db.prepare(`SELECT 1 FROM task_dependencies d LEFT JOIN task_conclusions c
      ON c.task_id = d.prerequisite_id AND c.revision = d.prerequisite_revision
      WHERE d.task_id = ? AND d.revision = ? AND (c.status IS NULL
        OR (c.status != 'succeeded' AND (c.status != 'partial' OR COALESCE(d.allow_partial, 0) = 0))) LIMIT 1`)
      .get(candidate.task_id, candidate.revision);
    if (blocked) return false;
    this.db.prepare("UPDATE task_revisions SET phase = 'queued' WHERE task_id = ? AND revision = ? AND phase = 'waiting_dependency'")
      .run(candidate.task_id, candidate.revision);
    return true;
  }

  private reserve(candidate: Candidate, worker: WorkerDeclaration, permissions: ReadonlySet<string>, resources: Resource[], now: number): WorkerAttemptKey {
    const attemptKey = randomUUID();
    const { workerId, canResume } = worker;
    const leaseGeneration = Number(this.db.prepare(`SELECT COALESCE(MAX(lease_generation), 0) + 1 AS next
      FROM task_attempts WHERE task_id = ? AND revision = ?`).get(candidate.task_id, candidate.revision)?.next);
    const update = this.db.prepare("UPDATE task_revisions SET phase = 'running' WHERE task_id = ? AND revision = ? AND phase = 'queued'")
      .run(candidate.task_id, candidate.revision);
    if (update.changes !== 1) throw new Error('Task queue compare-and-set failed.');
    this.db.prepare(`INSERT INTO task_attempts
      (attempt_key, task_id, revision, worker_id, lease_generation, attempt_token, can_resume, permissions_json, dispatch_state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unsent', ?)`)
      .run(attemptKey, candidate.task_id, candidate.revision, workerId, leaseGeneration, randomBytes(32).toString('hex'),
        Number(canResume), JSON.stringify([...permissions]), now);
    const reserve = this.db.prepare(`INSERT INTO task_reservations
      (attempt_key, resource_kind, resource_key, units, acquired_at) VALUES (?, ?, ?, ?, ?)`);
    for (const { kind, key, units } of resources) reserve.run(attemptKey, kind, key, units, now);
    this.db.prepare('DELETE FROM task_dispatch_queue WHERE queue_id = ?').run(candidate.queue_id);
    return { attemptKey, workerId, leaseGeneration };
  }

  private readAttempt(attemptKey: string): AttemptRow | undefined {
    return this.db.prepare(`SELECT a.*, t.owner, r.phase, r.capability, r.dispatch_json, r.goal, r.materials_json,
      r.deadline_at, r.budget, r.resume_attempt_key, prior.revision AS resume_revision, prior.external_id AS resume_external_id
      FROM task_attempts a JOIN task_revisions r USING (task_id, revision) JOIN tasks t USING (task_id)
      LEFT JOIN task_attempts prior ON prior.attempt_key = r.resume_attempt_key WHERE a.attempt_key = ?`)
      .get(attemptKey) as AttemptRow | undefined;
  }

  private getAttempt(attemptKey: string): StoredWorkerAttempt | undefined {
    const attempt = this.readAttempt(attemptKey);
    if (!attempt) return undefined;
    const dispatch = JSON.parse(attempt.dispatch_json ?? '{}') as TaskDispatchSpec;
    return {
      attemptKey, workerId: attempt.worker_id, leaseGeneration: attempt.lease_generation, attemptToken: attempt.attempt_token,
      ...receiptFor(attempt), requirements: requirementsFor(attempt.capability, dispatch), goal: attempt.goal,
      materials: JSON.parse(attempt.materials_json) as string[], deadlineAt: attempt.deadline_at, budget: attempt.budget,
      workspaceKey: workspaceFor(attempt.owner, attempt.task_id, dispatch),
      ...(attempt.resume_attempt_key !== null && attempt.resume_revision !== null ? { resumeFrom: {
        attemptKey: attempt.resume_attempt_key, revision: attempt.resume_revision,
        ...(attempt.resume_external_id === null ? {} : { externalId: attempt.resume_external_id }),
      } } : {}),
      allowedPermissions: new Set(JSON.parse(attempt.permissions_json) as string[]),
    };
  }

  private claimStart({ attemptKey, workerId, leaseGeneration, attemptToken }: WorkerAttemptFence): boolean {
    const result = this.db.prepare(`UPDATE task_attempts SET dispatch_state = 'possibly_sent'
      WHERE attempt_key = ? AND worker_id = ? AND lease_generation = ? AND attempt_token = ?
        AND dispatch_state = 'unsent' AND ended_at IS NULL AND EXISTS (SELECT 1 FROM task_revisions r
          WHERE r.task_id = task_attempts.task_id AND r.revision = task_attempts.revision AND r.phase = 'running')`)
      .run(attemptKey, workerId, leaseGeneration, attemptToken);
    return result.changes === 1;
  }

  private recordReport(report: AuthenticatedWorkerReport, now: number): WorkerRecordDisposition {
    return inImmediateTransaction(this.db, () => {
      const attempt = this.readAttempt(report.attemptKey);
      if (!ownsFence(attempt, report) || attempt.attempt_token !== report.attemptToken
        || attempt.dispatch_state === 'unsent') return 'stale_attempt';
      const { eventSeq, event } = report;
      const payload = JSON.stringify(event);
      const original = this.db.prepare('SELECT event_json FROM task_attempt_events WHERE attempt_key = ? AND event_seq = ?')
        .get(report.attemptKey, eventSeq);
      if (original) return original.event_json === payload ? 'duplicate' : 'conflict';
      const active = canReport(attempt);
      if (active && eventSeq <= attempt.last_event_seq) return 'out_of_order';
      this.db.prepare(`INSERT INTO task_attempt_events (attempt_key, event_seq, event_json, late, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(report.attemptKey, eventSeq, payload, active ? 0 : 1, now);
      if (!active) return 'late';
      this.db.prepare('UPDATE task_attempts SET last_event_seq = ? WHERE attempt_key = ?').run(eventSeq, report.attemptKey);
      if (event.kind === 'result') {
        this.finishAttempt(attempt, { status: event.outcome, summary: event.summary }, 'worker_result', now);
      }
      return 'recorded';
    });
  }

  private finishAttempt(attempt: AttemptRow, outcome: TaskOutcome, releaseReason: string, now: number): void {
    const ended = this.db.prepare('UPDATE task_attempts SET ended_at = ? WHERE attempt_key = ? AND ended_at IS NULL')
      .run(now, attempt.attempt_key);
    if (ended.changes !== 1) throw new Error('Task attempt compare-and-set failed.');
    closeTaskRevision(this.db, attempt.owner, receiptFor(attempt), outcome, attempt.phase, now);
    this.db.prepare(`UPDATE task_reservations SET released_at = ?, release_reason = ?
      WHERE attempt_key = ? AND released_at IS NULL`).run(now, releaseReason, attempt.attempt_key);
  }
}
