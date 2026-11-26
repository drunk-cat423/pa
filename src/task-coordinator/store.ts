import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initializeTaskCoordinatorSchema, inImmediateTransaction, OUTCOME_STATUSES, TASK_PHASES } from './schema.js';

export interface TaskSpec {
  readonly goal: string;
  readonly capability: string;
  readonly materials: readonly string[];
  readonly deadlineAt: number;
  readonly budget: number;
}

export interface TaskReceipt {
  taskId: string;
  revision: number;
}

export type TaskPhase = typeof TASK_PHASES[number];
export type TaskOutcomeStatus = typeof OUTCOME_STATUSES[number];

export interface TaskOutcome {
  status: TaskOutcomeStatus;
  summary: string;
}

export type TaskStatus = TaskReceipt & { spec: TaskSpec } & (
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
  const input = exactRecord(value, ['goal', 'capability', 'materials', 'deadlineAt', 'budget'], 'spec');
  const goal = boundedText(input.goal, 'goal', MAX_TEXT_BYTES);
  const capability = boundedText(input.capability, 'capability', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(capability)) invalid('capability');
  if (!Array.isArray(input.materials) || input.materials.length > MAX_MATERIALS) invalid('materials');
  const materials = Array.from(input.materials, (value: unknown) => {
    const reference = boundedText(value, 'material reference', 256);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]+)?$/.test(reference) || /^[A-Za-z]:/.test(reference)) {
      invalid('material reference');
    }
    return reference;
  });
  const deadlineAt = positiveInteger(input.deadlineAt, 'deadlineAt');
  const budget = input.budget;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) invalid('budget');
  return { goal, capability, materials, deadlineAt, budget };
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

  constructor(dbPath: string) {
    const db = new DatabaseSync(dbPath);
    try { initializeTaskCoordinatorSchema(db); }
    catch (error) { db.close(); throw error; }
    this.db = db;
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
      this.db.prepare('INSERT INTO tasks (task_id, owner, origin_source_key, head_revision, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(receipt.taskId, owner, sourceKey, receipt.revision, now);
      this.db.prepare(`INSERT INTO task_revisions
        (task_id, revision, goal, capability, materials_json, deadline_at, budget, phase, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
        .run(receipt.taskId, receipt.revision, snapshot.goal, snapshot.capability, JSON.stringify(snapshot.materials),
          snapshot.deadlineAt, snapshot.budget, now);
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
        r.phase, c.status, c.summary
      FROM tasks t JOIN task_revisions r ON r.task_id = t.task_id AND r.revision = COALESCE(?, t.head_revision)
      LEFT JOIN task_conclusions c ON c.task_id = r.task_id AND c.revision = r.revision
      WHERE t.owner = ? AND t.task_id = ?`).get(revision ?? null, owner, taskId) as StatusRow | undefined;
    if (!row) return undefined;
    const spec = {
      goal: row.goal, capability: row.capability, materials: JSON.parse(row.materials_json) as string[],
      deadlineAt: row.deadline_at, budget: row.budget,
    };
    const receipt = { taskId, revision: row.revision, spec };
    const conclusion = readConclusion(row);
    if (row.phase === 'closed' && conclusion) return { ...receipt, phase: row.phase, conclusion };
    if (row.phase !== 'closed') return { ...receipt, phase: row.phase, conclusion: null };
    throw new Error('Closed task revision has no conclusion.');
  }

  revise(owner: string, sourceKey: string, taskId: string, expectedRevision: number, newGoal: string): TaskReceipt {
    boundedText(owner, 'owner', MAX_OWNER_BYTES);
    boundedText(sourceKey, 'source key', MAX_SOURCE_KEY_BYTES);
    boundedText(taskId, 'task ID', MAX_TASK_ID_BYTES);
    positiveInteger(expectedRevision, 'expected revision');
    boundedText(newGoal, 'goal', MAX_TEXT_BYTES);
    const hash = hashRequest('revise', taskId, expectedRevision, newGoal);
    return inImmediateTransaction(this.db, () => {
      const original = this.readRequest(owner, sourceKey, hash);
      if (original) return original;

      const head = this.db.prepare(`SELECT t.head_revision, r.phase, c.status, c.summary FROM tasks t
        JOIN task_revisions r ON r.task_id = t.task_id AND r.revision = t.head_revision
        LEFT JOIN task_conclusions c ON c.task_id = r.task_id AND c.revision = r.revision
        WHERE t.owner = ? AND t.task_id = ?`).get(owner, taskId) as (ConclusionRow & { head_revision: number }) | undefined;
      if (!head) throw new TaskCoordinatorError('not_found', 'Task not found.');
      if (head.head_revision !== expectedRevision) throw new TaskCoordinatorError('conflict', 'Task revision changed.');
      if (!readConclusion(head)) throw new TaskCoordinatorError('invalid_state', 'Current task revision is still open.');

      const receipt = { taskId, revision: positiveInteger(expectedRevision + 1, 'next revision') };
      const now = Date.now();
      const update = this.db.prepare('UPDATE tasks SET head_revision = ? WHERE task_id = ? AND owner = ? AND head_revision = ?')
        .run(receipt.revision, taskId, owner, expectedRevision);
      if (update.changes !== 1) throw new Error('Task head revision compare-and-set failed.');
      const insertion = this.db.prepare(`INSERT INTO task_revisions
        (task_id, revision, goal, capability, materials_json, deadline_at, budget, phase, created_at)
        SELECT task_id, ?, ?, capability, materials_json, deadline_at, budget, 'queued', ? FROM task_revisions
        WHERE task_id = ? AND revision = ?`).run(receipt.revision, newGoal, now, taskId, expectedRevision);
      if (insertion.changes !== 1) throw new Error('Task revision snapshot was not copied.');
      this.insertRequest(owner, sourceKey, 'revise', hash, receipt, now);
      return receipt;
    });
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

      const now = Date.now();
      const update = this.db.prepare("UPDATE task_revisions SET phase = 'closed' WHERE task_id = ? AND revision = ? AND phase = ?")
        .run(taskId, revision, row.phase);
      if (update.changes !== 1) throw new Error('Task phase compare-and-set failed.');
      this.db.prepare('INSERT INTO task_conclusions (task_id, revision, status, summary, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(taskId, revision, proposed.status, proposed.summary, now);
      this.db.prepare(`INSERT INTO task_notifications (task_id, revision, recipient_owner, purpose, status, created_at)
        VALUES (?, ?, ?, 'automatic', 'pending', ?)`).run(taskId, revision, owner, now);
    });
  }

  close(): void {
    this.db.close();
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
