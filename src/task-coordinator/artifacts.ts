import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { inImmediateTransaction } from './schema.js';
import { TaskCoordinatorError } from './store.js';
import type { TaskOutcome, TaskReceipt } from './store.js';
import type { WorkerAttemptFence, WorkerEvent } from './worker-contract.js';

const maxArtifactBytes = 4 * 1024 * 1024;
const maxAttemptBytes = 8 * 1024 * 1024;
const maxArtifacts = 32;
const artifactReference = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const supportedFormats = new Set([
  'text/plain', 'text/markdown', 'application/json', 'image/png', 'image/jpeg', 'image/webp', 'application/pdf',
]);

export interface ArtifactReference {
  readonly reference: string;
  readonly format: string;
}

export interface ArtifactMetadata extends ArtifactReference {
  readonly sha256: string;
  readonly byteCount: number;
}

export interface ArtifactUpload extends ArtifactReference {
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface TaskArtifact extends ArtifactMetadata {
  readonly bytes: Uint8Array;
}

type ArtifactRow = {
  attempt_key: string;
  reference: string;
  format: string;
  sha256: string;
  byte_count: number;
  bytes: Uint8Array;
};

export class ArtifactUnavailableError extends Error {
  constructor() {
    super('A stored task artifact failed verification.');
    this.name = 'ArtifactUnavailableError';
  }
}

function contentMatches(format: string, bytes: Buffer): boolean {
  switch (format) {
    case 'text/plain':
    case 'text/markdown':
    case 'application/json':
      try {
        const text = utf8.decode(bytes);
        if (format === 'application/json') JSON.parse(text);
        return !text.includes('\0');
      } catch {
        return false;
      }
    case 'image/png':
      return bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && bytes.subarray(12, 16).toString() === 'IHDR' && bytes.subarray(-8, -4).toString() === 'IEND';
    case 'image/jpeg':
      return bytes.length >= 6 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        && bytes.subarray(-2).equals(Buffer.from([255, 217]));
    case 'image/webp':
      return bytes.length >= 20 && bytes.subarray(0, 4).toString() === 'RIFF'
        && bytes.readUInt32LE(4) + 8 === bytes.length && bytes.subarray(8, 12).toString() === 'WEBP'
        && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString());
    case 'application/pdf':
      return bytes.subarray(0, 5).toString() === '%PDF-'
        && bytes.subarray(-1024).toString('latin1').trimEnd().endsWith('%%EOF');
    default:
      return false;
  }
}

function verified(format: string, sha256: string, bytes: Uint8Array): boolean {
  if (!bytes.byteLength || bytes.byteLength > maxArtifactBytes || !sha256Pattern.test(sha256)) return false;
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return createHash('sha256').update(data).digest('hex') === sha256 && contentMatches(format, data);
}

function metadata(row: Pick<ArtifactRow, 'reference' | 'format' | 'sha256' | 'byte_count'>): ArtifactMetadata {
  return { reference: row.reference, format: row.format, sha256: row.sha256, byteCount: row.byte_count };
}

function validRow(row: ArtifactRow): boolean {
  return row.byte_count === row.bytes.byteLength && verified(row.format, row.sha256, row.bytes);
}

export function isSupportedArtifactFormat(value: unknown): value is string {
  return typeof value === 'string' && supportedFormats.has(value);
}

/** Accepts bytes from the authenticated worker connection. */
export function stageWorkerArtifact(
  db: DatabaseSync, fence: WorkerAttemptFence, artifact: ArtifactUpload,
): ArtifactMetadata {
  if (!artifact || typeof artifact.reference !== 'string' || !artifactReference.test(artifact.reference)
    || !isSupportedArtifactFormat(artifact.format) || typeof artifact.sha256 !== 'string'
    || !(artifact.bytes instanceof Uint8Array) || artifact.bytes.byteLength > maxArtifactBytes) {
    throw new TaskCoordinatorError('invalid_request', 'Invalid task artifact.');
  }
  const bytes = Buffer.from(artifact.bytes);
  if (!verified(artifact.format, artifact.sha256, bytes)) {
    throw new TaskCoordinatorError('invalid_request', 'Task artifact bytes do not match the declared format or digest.');
  }

  const { attemptKey, workerId, leaseGeneration, attemptToken } = fence;
  return inImmediateTransaction(db, () => {
    const attempt = db.prepare(`SELECT a.ended_at, r.phase, a.dispatch_state
      FROM task_attempts a JOIN task_revisions r USING (task_id, revision)
      WHERE a.attempt_key = ? AND a.worker_id = ? AND a.lease_generation = ? AND a.attempt_token = ?`)
      .get(attemptKey, workerId, leaseGeneration, attemptToken);
    if (!attempt || attempt.dispatch_state === 'unsent' || attempt.dispatch_state === 'rejected') {
      throw new TaskCoordinatorError('not_found', 'Task attempt not found.');
    }

    const original = db.prepare('SELECT * FROM task_artifact_staging WHERE attempt_key = ? AND reference = ?')
      .get(attemptKey, artifact.reference) as ArtifactRow | undefined;
    if (original) {
      if (original.sha256 !== artifact.sha256 || original.format !== artifact.format) {
        throw new TaskCoordinatorError('conflict', 'Artifact reference is already bound to different bytes or format.');
      }
      if (!validRow(original)) throw new ArtifactUnavailableError();
      return metadata(original);
    }
    if (attempt.ended_at !== null || (attempt.phase !== 'running' && attempt.phase !== 'reconciling')) {
      throw new TaskCoordinatorError('invalid_state', 'Task attempt is closed to new artifacts.');
    }

    const totals = db.prepare(`SELECT count(*) AS count, coalesce(sum(byte_count), 0) AS size
      FROM task_artifact_staging WHERE attempt_key = ?`).get(attemptKey)!;
    if (Number(totals.count) >= maxArtifacts || Number(totals.size) + bytes.byteLength > maxAttemptBytes) {
      throw new TaskCoordinatorError('invalid_request', 'Task attempt artifact limit reached.');
    }
    db.prepare(`INSERT INTO task_artifact_staging (attempt_key, reference, format, byte_count, sha256, bytes)
      VALUES (?, ?, ?, ?, ?, ?)`).run(attemptKey, artifact.reference, artifact.format, bytes.byteLength, artifact.sha256, bytes);
    return { reference: artifact.reference, format: artifact.format, sha256: artifact.sha256, byteCount: bytes.byteLength };
  });
}

type WorkerResult = Extract<WorkerEvent, { kind: 'result' }>;

/** Run inside authenticated result adjudication with the same SQLite write transaction as closure. */
export function prepareWorkerResult(
  db: DatabaseSync, attemptKey: string, requiredFormats: readonly string[], event: WorkerResult,
): { outcome: TaskOutcome; references: readonly string[] } {
  if (!db.isTransaction) throw new Error('Worker result verification requires a transaction.');
  const read = db.prepare('SELECT * FROM task_artifact_staging WHERE attempt_key = ? AND reference = ?');
  const references: string[] = [];
  const formats = new Set<string>();
  for (const declared of event.artifacts) {
    const row = read.get(attemptKey, declared.reference) as ArtifactRow | undefined;
    if (!row || row.format !== declared.format || !validRow(row)) continue;
    references.push(row.reference);
    formats.add(row.format);
  }
  const incomplete = references.length !== event.artifacts.length || requiredFormats.some(format => !formats.has(format));
  let outcome: TaskOutcome = { status: event.outcome, summary: event.summary };
  if (incomplete && (event.outcome === 'succeeded' || event.outcome === 'partial')) {
    outcome = {
      status: references.length ? 'partial' : 'failed',
      summary: references.length ? '部分产物通过校验，另有产物缺失或损坏。' : '未能核验任务产物。部分产物缺失或损坏。',
    };
  }
  return { outcome, references };
}

export function freezeWorkerArtifacts(
  db: DatabaseSync, { taskId, revision }: TaskReceipt, attemptKey: string, references: readonly string[],
): void {
  if (!db.isTransaction) throw new Error('Freezing task artifacts requires the conclusion transaction.');
  const insert = db.prepare(`INSERT INTO task_artifacts (task_id, revision, reference, attempt_key)
    VALUES (?, ?, ?, ?)`);
  for (const reference of references) insert.run(taskId, revision, reference, attemptKey);
}

export function listFrozenArtifacts(db: DatabaseSync, owner: string, receipt: TaskReceipt): ArtifactMetadata[] {
  return db.prepare(`SELECT s.reference, s.format, s.sha256, s.byte_count FROM task_artifacts a
    JOIN tasks t USING (task_id) JOIN task_artifact_staging s USING (attempt_key, reference)
    WHERE t.owner = ? AND a.task_id = ? AND a.revision = ? ORDER BY s.reference`)
    .all(owner, receipt.taskId, receipt.revision).map(row => metadata(row as ArtifactRow));
}

export function readFrozenArtifact(
  db: DatabaseSync, owner: string, { taskId, revision }: TaskReceipt, reference: string,
): TaskArtifact | undefined {
  const row = db.prepare(`SELECT s.* FROM task_artifacts a
    JOIN tasks t USING (task_id) JOIN task_artifact_staging s USING (attempt_key, reference)
    WHERE t.owner = ? AND a.task_id = ? AND a.revision = ? AND a.reference = ?`)
    .get(owner, taskId, revision, reference) as ArtifactRow | undefined;
  if (!row) return undefined;
  if (!validRow(row)) throw new ArtifactUnavailableError();
  return { ...metadata(row), bytes: row.bytes };
}
