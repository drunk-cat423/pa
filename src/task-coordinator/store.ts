import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initializeTaskCoordinatorSchema, inImmediateTransaction, OUTCOME_STATUSES, TASK_PHASES } from './schema.js';
import { closeTaskRevision, TaskSchedulingStore } from './scheduler-store.js';
import { validWorkerFormat, validWorkerName } from './worker-contract.js';

export interface TaskSpec {
  readonly goal: string;
  readonly capability: string;
  readonly materials: readonly string[];
  readonly deadlineAt: number;
  readonly budget: number;
  readonly dependencies?: readonly TaskDependency[];
  readonly workspaceKey?: string;
  readonly inputFormats?: readonly string[];
  readonly outputFormats?: readonly string[];
  readonly waitingForInput?: boolean;
  readonly notBeforeAt?: number;
}

export type TaskRevisionOptions = Pick<TaskSpec, 'deadlineAt' | 'materials'>;
export type TaskCancellation = { disposition: 'pending' | 'cancelled' | 'already_closed' };

export interface TaskReceipt {
  taskId: string;
  revision: number;
}

export interface TaskDependency extends TaskReceipt {
  readonly allowPartial?: boolean;
}

export type TaskDispatchSpec = Pick<TaskSpec, 'workspaceKey' | 'inputFormats' | 'outputFormats'>;

export type TaskPhase = typeof TASK_PHASES[number];
export type TaskOutcomeStatus = typeof OUTCOME_STATUSES[number];

export interface TaskOutcome {
  status: TaskOutcomeStatus;
  summary: string;
}

export type TaskStatus = TaskReceipt & { spec: TaskSpec; cancelRequestedAt?: number } & (
  | { phase: Exclude<TaskPhase, 'closed'>; conclusion: null }
  | { phase: 'closed'; conclusion: TaskOutcome }
);

export type TaskCoordinatorErrorCode = 'invalid_request' | 'not_found' | 'conflict' | 'invalid_state';

export class TaskCoordinatorError extends Error {
  constructor(readonly code: TaskCoordinatorErrorCode, message: string) {
    super(message);
    this.name = 'TaskCoordinatorError';
  }
}

type RequestOperation = 'submit' | 'revise';
type ConclusionRow = { phase: TaskPhase; status: TaskOutcomeStatus | null; summary: string | null };
type StatusRow = ConclusionRow & {
  revision: number;
  goal: string;
  capability: string;
  materials_json: string;
  deadline_at: number;
  budget: number;
  not_before_at: number | null;
  cancel_requested_at: number | null;
  dispatch_json: string | null;
  dependencies_locked: number;
};

const MAX_OWNER_BYTES = 256;
const MAX_SOURCE_KEY_BYTES = 4096;
const MAX_TASK_ID_BYTES = 128;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_MATERIALS = 64;

function invalid(field: string): never {
  throw new TaskCoordinatorError('invalid_request', `Invalid ${field}.`);
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length > maxBytes || !value.trim() || value.includes('\0')) invalid(field);
  const utf8 = Buffer.from(value);
  if (utf8.length > maxBytes || utf8.toString() !== value) invalid(field);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(field);
  return value;
}

function exactRecord(value: unknown, fields: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) invalid(field);
  return value as Record<string, unknown>;
}

function validateSpec(value: unknown): TaskSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('spec');
  const input = value as Record<string, unknown>;
  const required = ['goal', 'capability', 'materials', 'deadlineAt', 'budget'];
  const optional = ['dependencies', 'workspaceKey', 'inputFormats', 'outputFormats', 'waitingForInput', 'notBeforeAt'];
  if (!required.every(key => Object.hasOwn(input, key))
    || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) invalid('spec');
  const goal = boundedText(input.goal, 'goal', MAX_TEXT_BYTES);
  const capability = boundedText(input.capability, 'capability', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(capability)) invalid('capability');
  const materials = validateMaterials(input.materials);
  const deadlineAt = positiveInteger(input.deadlineAt, 'deadlineAt');
  const budget = input.budget;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) invalid('budget');
  if (input.waitingForInput !== undefined && typeof input.waitingForInput !== 'boolean') invalid('waitingForInput');
  const notBeforeAt = input.notBeforeAt === undefined ? undefined : positiveInteger(input.notBeforeAt, 'notBeforeAt');
  const spec: TaskSpec = { goal, capability, materials, deadlineAt, budget,
    ...(input.waitingForInput ? { waitingForInput: true } : {}),
    ...(notBeforeAt === undefined ? {} : { notBeforeAt }) };
  const dispatch: { -readonly [Key in keyof TaskDispatchSpec]: TaskDispatchSpec[Key] } = {};
  if (Object.hasOwn(input, 'workspaceKey')) {
    if (!validWorkerName(input.workspaceKey)) invalid('workspace key');
    dispatch.workspaceKey = input.workspaceKey;
  }
  for (const key of ['inputFormats', 'outputFormats'] as const) {
    if (!Object.hasOwn(input, key)) continue;
    const formats = input[key];
    if (!Array.isArray(formats) || formats.length > 64 || !Array.from(formats).every(validWorkerFormat)
      || new Set(formats).size !== formats.length) invalid(key);
    dispatch[key] = [...formats];
  }
  return Object.hasOwn(input, 'dependencies')
    ? { ...spec, ...dispatch, dependencies: validateDependencies(input.dependencies) }
    : { ...spec, ...dispatch };
}

function validateMaterials(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_MATERIALS) invalid('materials');
  return Array.from(value, (value: unknown) => {
    const reference = boundedText(value, 'material reference', 256);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]+)?$/.test(reference) || /^[A-Za-z]:/.test(reference)) invalid('material reference');
    return reference;
  });
}

function validateDependencies(value: unknown): TaskDependency[] {
  if (!Array.isArray(value) || value.length > 64) invalid('dependencies');
  const seen = new Set<string>();
  return Array.from(value, (value: unknown) => {
    const fields = value && typeof value === 'object' && Object.hasOwn(value, 'allowPartial')
      ? ['taskId', 'revision', 'allowPartial'] : ['taskId', 'revision'];
    const input = exactRecord(value, fields, 'dependency');
    const taskId = boundedText(input.taskId, 'prerequisite ID', MAX_TASK_ID_BYTES);
    const revision = positiveInteger(input.revision, 'prerequisite revision');
    const key = JSON.stringify([taskId, revision]);
    if (seen.has(key)) invalid('duplicate dependency');
    seen.add(key);
    if (fields.length === 2) return { taskId, revision };
    if (typeof input.allowPartial !== 'boolean') invalid('allow partial dependency result');
    return { taskId, revision, allowPartial: input.allowPartial };
  });
}

function validateOutcome(value: unknown): TaskOutcome {
  const input = exactRecord(value, ['status', 'summary'], 'outcome');
  const status = OUTCOME_STATUSES.find(status => status === input.status);
  if (!status) invalid('outcome status');
  return { status, summary: boundedText(input.summary, 'outcome summary', MAX_TEXT_BYTES) };
}

function hashRequest(operation: RequestOperation, ...payload: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify([1, operation, ...payload])).digest('hex');
}

function readConclusion(row: ConclusionRow): TaskOutcome | null {
  if (row.phase !== 'closed' && row.status === null && row.summary === null) return null;
  if (row.phase === 'closed' && row.status !== null && row.summary !== null) return { status: row.status, summary: row.summary };
  throw new Error('Inconsistent task coordinator conclusion.');
}

/** Callers obtain owner and source keys from the trusted PA endpoint. */
export class TaskCoordinatorStore {
  private readonly db: DatabaseSync;
  readonly scheduling: TaskSchedulingStore;

  constructor(dbPath: string) {
    const db = new DatabaseSync(dbPath);
    try { initializeTaskCoordinatorSchema(db); }
    catch (error) { db.close(); throw error; }
    this.db = db;
    this.scheduling = new TaskSchedulingStore(db);
  }

  submit(owner: string, sourceKey: string, spec: TaskSpec): TaskReceipt {
    boundedText(owner, 'owner', MAX_OWNER_BYTES);
    boundedText(sourceKey, 'source key', MAX_SOURCE_KEY_BYTES);
    const snapshot = validateSpec(spec);
    const hash = hashRequest('submit', snapshot);
    return inImmediateTransaction(this.db, () => {
      const original = this.readRequest(owner, sourceKey, hash);
      if (original) return original;

      const receipt = { taskId: randomUUID(), revision: 1 };
      const now = Date.now();
      const { goal, capability, materials, deadlineAt, budget, dependencies, waitingForInput, notBeforeAt, ...dispatch } = snapshot;
      this.db.prepare('INSERT INTO tasks (task_id, owner, origin_source_key, head_revision, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(receipt.taskId, owner, sourceKey, receipt.revision, now);
      this.db.prepare(`INSERT INTO task_revisions
        (task_id, revision, goal, capability, materials_json, deadline_at, budget, phase, created_at, dispatch_json, not_before_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(receipt.taskId, receipt.revision, goal, capability, JSON.stringify(materials), deadlineAt, budget,
          waitingForInput ? 'waiting_input' : 'queued', now,
          JSON.stringify(waitingForInput ? { ...dispatch, waitingForInput } : dispatch), notBeforeAt ?? null);
      if (dependencies) this.writeDependencies(owner, receipt, dependencies);
      if (!waitingForInput) this.enqueue(owner, receipt);
      this.insertRequest(owner, sourceKey, 'submit', hash, receipt, now);
      return receipt;
    });
  }

  lookupRequest(owner: string, sourceKey: string): TaskReceipt | undefined {
    boundedText(owner, 'owner', MAX_OWNER_BYTES);
    boundedText(sourceKey, 'source key', MAX_SOURCE_KEY_BYTES);
    return this.readRequest(owner, sourceKey);
  }

  status(owner: string, taskId: string, revision?: number): TaskStatus | undefined {
    boundedText(owner, 'owner', MAX_OWNER_BYTES);
    boundedText(taskId, 'task ID', MAX_TASK_ID_BYTES);
    if (revision !== undefined) positiveInteger(revision, 'revision');
    const row = this.db.prepare(`SELECT r.revision, r.goal, r.capability, r.materials_json, r.deadline_at, r.budget,
        r.phase, r.dispatch_json, r.dependencies_locked, r.not_before_at, r.cancel_requested_at, c.status, c.summary
      FROM tasks t JOIN task_revisions r ON r.task_id = t.task_id AND r.revision = COALESCE(?, t.head_revision)
      LEFT JOIN task_conclusions c ON c.task_id = r.task_id AND c.revision = r.revision
      WHERE t.owner = ? AND t.task_id = ?`).get(revision ?? null, owner, taskId) as StatusRow | undefined;
    if (!row) return undefined;
    const spec: TaskSpec = {
      goal: row.goal, capability: row.capability, materials: JSON.parse(row.materials_json) as string[],
      deadlineAt: row.deadline_at, budget: row.budget,
      ...JSON.parse(row.dispatch_json ?? '{}') as TaskDispatchSpec,
      ...(row.not_before_at === null ? {} : { notBeforeAt: row.not_before_at }),
      ...(row.dependencies_locked ? { dependencies: this.readDependencies(taskId, row.revision) } : {}),
    };
    const receipt = { taskId, revision: row.revision, spec,
      ...(row.cancel_requested_at === null ? {} : { cancelRequestedAt: row.cancel_requested_at }) };
    const conclusion = readConclusion(row);
    if (row.phase === 'closed' && conclusion) return { ...receipt, phase: row.phase, conclusion };
    if (row.phase !== 'closed') return { ...receipt, phase: row.phase, conclusion: null };
    throw new Error('Closed task revision has no conclusion.');
  }

  revise(owner: string, sourceKey: string, taskId: string, expectedRevision: number, newGoal: string,
    options: Partial<TaskRevisionOptions> = {}): TaskReceipt {
    boundedText(owner, 'owner', MAX_OWNER_BYTES);
    boundedText(sourceKey, 'source key', MAX_SOURCE_KEY_BYTES);
    boundedText(taskId, 'task ID', MAX_TASK_ID_BYTES);
    positiveInteger(expectedRevision, 'expected revision');
    boundedText(newGoal, 'goal', MAX_TEXT_BYTES);
    const materials = options.materials === undefined ? undefined : validateMaterials(options.materials);
    const deadline = options.deadlineAt === undefined ? undefined : positiveInteger(options.deadlineAt, 'deadlineAt');
    const change = materials === undefined && deadline === undefined ? [] : [{ materials, deadline }];
    const hash = hashRequest('revise', taskId, expectedRevision, newGoal, ...change);
    return inImmediateTransaction(this.db, () => {
      const original = this.readRequest(owner, sourceKey, hash);
      if (original) return original;

      const head = this.db.prepare(`SELECT t.head_revision, r.phase, c.status, c.summary,
        json_extract(r.dispatch_json, '$.waitingForInput') AS needs_input FROM tasks t
        JOIN task_revisions r ON r.task_id = t.task_id AND r.revision = t.head_revision
        LEFT JOIN task_conclusions c ON c.task_id = r.task_id AND c.revision = r.revision
        WHERE t.owner = ? AND t.task_id = ?`).get(owner, taskId) as (ConclusionRow & { head_revision: number; needs_input: number | null }) | undefined;
      if (!head) throw new TaskCoordinatorError('not_found', 'Task not found.');
      if (head.head_revision !== expectedRevision) throw new TaskCoordinatorError('conflict', 'Task revision changed.');
      const now = Date.now();
      if (head.needs_input === 1 && !materials?.length) {
        throw new TaskCoordinatorError('invalid_request', 'Additional materials are required.');
      }
      if (head.phase === 'waiting_input') {
        closeTaskRevision(this.db, owner, { taskId, revision: expectedRevision },
          { status: 'cancelled', summary: '收到补充材料，任务将在新修订中继续。' }, head.phase, now);
      } else if (!readConclusion(head)) {
        throw new TaskCoordinatorError('invalid_state', 'Current task revision is still open.');
      }
      const prior = this.db.prepare(`SELECT attempt_key, can_resume FROM task_attempts
        WHERE task_id = ? AND revision <= ? AND dispatch_state IN ('possibly_sent', 'accepted')
        ORDER BY revision DESC, lease_generation DESC LIMIT 1`).get(taskId, expectedRevision);
      if (prior?.can_resume === 0) {
        throw new TaskCoordinatorError('invalid_state', 'Assigned worker does not support continuation.');
      }

      const receipt = { taskId, revision: positiveInteger(expectedRevision + 1, 'next revision') };
      const update = this.db.prepare('UPDATE tasks SET head_revision = ? WHERE task_id = ? AND owner = ? AND head_revision = ?')
        .run(receipt.revision, taskId, owner, expectedRevision);
      if (update.changes !== 1) throw new Error('Task head revision compare-and-set failed.');
      const insertion = this.db.prepare(`INSERT INTO task_revisions
        (task_id, revision, goal, capability, materials_json, deadline_at, budget, phase, created_at, dispatch_json,
          dependencies_locked, resume_attempt_key)
        SELECT task_id, ?, ?, capability, COALESCE(?, materials_json), COALESCE(?, deadline_at), budget,
          CASE WHEN EXISTS (SELECT 1 FROM task_dependencies d WHERE d.task_id = r.task_id AND d.revision = r.revision)
            THEN 'waiting_dependency' ELSE 'queued' END, ?, json_remove(dispatch_json, '$.waitingForInput'),
          dependencies_locked, ? FROM task_revisions r
        WHERE task_id = ? AND revision = ?`).run(receipt.revision, newGoal, materials === undefined ? null : JSON.stringify(materials),
          deadline ?? null, now, prior?.attempt_key ?? null, taskId, expectedRevision);
      if (insertion.changes !== 1) throw new Error('Task revision snapshot was not copied.');
      this.db.prepare(`INSERT INTO task_dependencies (task_id, revision, prerequisite_id, prerequisite_revision, allow_partial)
        SELECT task_id, ?, prerequisite_id, prerequisite_revision, allow_partial FROM task_dependencies
        WHERE task_id = ? AND revision = ?`).run(receipt.revision, taskId, expectedRevision);
      this.enqueue(owner, receipt);
      this.insertRequest(owner, sourceKey, 'revise', hash, receipt, now);
      return receipt;
    });
  }

  cancel(owner: string, taskId: string, revision: number, now = Date.now()): TaskCancellation {
    boundedText(owner, 'owner', MAX_OWNER_BYTES);
    boundedText(taskId, 'task ID', MAX_TASK_ID_BYTES);
    positiveInteger(revision, 'revision');
    const result = this.scheduling.cancel(owner, { taskId, revision }, now);
    if (!result) throw new TaskCoordinatorError('not_found', 'Task revision not found.');
    return result;
  }

  settle(owner: string, taskId: string, revision: number, outcome: TaskOutcome): void {
    boundedText(owner, 'owner', MAX_OWNER_BYTES);
    boundedText(taskId, 'task ID', MAX_TASK_ID_BYTES);
    positiveInteger(revision, 'revision');
    const proposed = validateOutcome(outcome);
    inImmediateTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT r.phase, c.status, c.summary, n.notification_id FROM tasks t
        JOIN task_revisions r ON r.task_id = t.task_id AND r.revision = ?
        LEFT JOIN task_conclusions c ON c.task_id = r.task_id AND c.revision = r.revision
        LEFT JOIN task_notifications n ON n.task_id = c.task_id AND n.revision = c.revision
          AND n.recipient_owner = t.owner AND n.purpose = 'automatic'
        WHERE t.owner = ? AND t.task_id = ?`).get(revision, owner, taskId) as (ConclusionRow & { notification_id: number | null }) | undefined;
      if (!row) throw new TaskCoordinatorError('not_found', 'Task revision not found.');
      const conclusion = readConclusion(row);
      if (conclusion) {
        if (row.notification_id === null) throw new Error('Task conclusion has no automatic notification intent.');
        if (conclusion.status === proposed.status && conclusion.summary === proposed.summary) return;
        throw new TaskCoordinatorError('conflict', 'Task revision already has a different conclusion.');
      }

      if (row.phase === 'running' || row.phase === 'reconciling') {
        throw new TaskCoordinatorError('invalid_state', 'An active task must be settled by its assigned attempt.');
      }
      closeTaskRevision(this.db, owner, { taskId, revision }, proposed, row.phase, Date.now());
    });
  }

  setDependencies(owner: string, receipt: TaskReceipt, dependencies: readonly TaskDependency[]): void {
    boundedText(owner, 'owner', MAX_OWNER_BYTES);
    const taskId = boundedText(receipt.taskId, 'task ID', MAX_TASK_ID_BYTES);
    const revision = positiveInteger(receipt.revision, 'revision');
    const snapshot = validateDependencies(dependencies);
    inImmediateTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT r.phase, r.dependencies_locked FROM task_revisions r JOIN tasks t USING (task_id)
        WHERE r.task_id = ? AND r.revision = ? AND t.owner = ?`).get(taskId, revision, owner);
      if (!row) throw new TaskCoordinatorError('not_found', 'Task revision not found.');
      if (row.dependencies_locked || row.phase !== 'queued') {
        throw new TaskCoordinatorError('invalid_state', 'Task dependencies are already frozen.');
      }
      this.writeDependencies(owner, { taskId, revision }, snapshot);
    });
  }

  close(): void {
    this.db.close();
  }

  private enqueue(owner: string, { taskId, revision }: TaskReceipt): void {
    this.db.prepare('INSERT INTO task_dispatch_queue (owner, task_id, revision) VALUES (?, ?, ?)').run(owner, taskId, revision);
  }

  private readDependencies(taskId: string, revision: number): TaskDependency[] {
    const rows = this.db.prepare(`SELECT prerequisite_id, prerequisite_revision, allow_partial FROM task_dependencies
      WHERE task_id = ? AND revision = ? ORDER BY rowid`).all(taskId, revision);
    return rows.map(row => ({ taskId: String(row.prerequisite_id), revision: Number(row.prerequisite_revision),
      ...(row.allow_partial === null ? {} : { allowPartial: row.allow_partial === 1 }) }));
  }

  private writeDependencies(owner: string, { taskId, revision }: TaskReceipt, dependencies: readonly TaskDependency[]): void {
    for (const dependency of dependencies) {
      const prerequisite = this.db.prepare(`SELECT 1 FROM task_revisions r JOIN tasks t USING (task_id)
        WHERE r.task_id = ? AND r.revision = ? AND t.owner = ?`).get(dependency.taskId, dependency.revision, owner);
      if (!prerequisite) throw new TaskCoordinatorError('not_found', 'Prerequisite revision not found.');
      const cycle = this.db.prepare(`WITH RECURSIVE ancestors(id, rev) AS (
        VALUES (?, ?)
        UNION
        SELECT d.prerequisite_id, d.prerequisite_revision FROM task_dependencies d
          JOIN ancestors a ON d.task_id = a.id AND d.revision = a.rev
      ) SELECT 1 FROM ancestors WHERE id = ? AND rev = ? LIMIT 1`)
        .get(dependency.taskId, dependency.revision, taskId, revision);
      if (cycle) throw new TaskCoordinatorError('invalid_request', 'Task dependency would create a cycle.');
      this.db.prepare(`INSERT INTO task_dependencies (task_id, revision, prerequisite_id, prerequisite_revision, allow_partial)
        VALUES (?, ?, ?, ?, ?)`).run(taskId, revision, dependency.taskId, dependency.revision,
        dependency.allowPartial === undefined ? null : Number(dependency.allowPartial));
    }
    this.db.prepare(`UPDATE task_revisions SET dependencies_locked = 1,
      phase = CASE WHEN phase = 'waiting_input' THEN phase ELSE ? END WHERE task_id = ? AND revision = ?`)
      .run(dependencies.length ? 'waiting_dependency' : 'queued', taskId, revision);
  }

  private readRequest(owner: string, sourceKey: string, expectedHash?: string): TaskReceipt | undefined {
    const row = this.db.prepare('SELECT task_id, revision, request_hash FROM task_requests WHERE owner = ? AND source_key = ?')
      .get(owner, sourceKey) as { task_id: string; revision: number; request_hash: string } | undefined;
    if (!row) return undefined;
    if (expectedHash !== undefined && row.request_hash !== expectedHash) {
      throw new TaskCoordinatorError('conflict', 'Source key already belongs to a different request.');
    }
    return { taskId: row.task_id, revision: row.revision };
  }

  private insertRequest(owner: string, sourceKey: string, operation: RequestOperation, hash: string, receipt: TaskReceipt, now: number): void {
    this.db.prepare(`INSERT INTO task_requests (owner, source_key, operation, request_hash, task_id, revision, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(owner, sourceKey, operation, hash, receipt.taskId, receipt.revision, now);
  }
}
