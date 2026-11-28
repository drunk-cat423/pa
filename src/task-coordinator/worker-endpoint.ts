import { createHash, timingSafeEqual } from 'node:crypto';
import { WORKER_PROTOCOL_VERSION, positiveWorkerInteger, validWorkerFormat, validWorkerName } from './worker-contract.js';
import type {
  AuthenticatedWorkerReport, WorkerAttemptFence, WorkerAttemptKey, WorkerEvent, WorkerInspection,
  WorkerRecordDisposition, WorkerStart, WorkerStartReceipt, WorkerStopReceipt,
} from './worker-contract.js';
import type { WorkerMismatch, WorkerRegistry } from './registry.js';

export interface StoredWorkerAttempt extends WorkerStart {
  readonly allowedPermissions: ReadonlySet<string>;
}

export interface WorkerAttemptPort {
  getAttempt(attemptKey: string): StoredWorkerAttempt | undefined;
  // Atomically confirm this fence can start and durably mark the attempt as possibly sent.
  claimStart(fence: WorkerAttemptFence): boolean;
  // Atomically recheck the fence and adjudicate sequence, duplicate payloads and late evidence.
  recordReport(report: AuthenticatedWorkerReport): WorkerRecordDisposition;
}

export type StartDisposition = Exclude<WorkerStartReceipt, { disposition: 'rejected' }> | {
  readonly disposition: 'rejected';
  readonly reason: WorkerMismatch | 'stale_attempt' | 'dispatch_not_claimed' | 'adapter_rejected';
};

export type ReportDisposition = {
  readonly disposition: WorkerRecordDisposition | 'invalid_report' | 'unsupported_version' | 'unauthorized';
};

export interface WorkerConnection {
  report(payload: Uint8Array): ReportDisposition;
}

const connectionSecretPattern = /^[a-f0-9]{64}$/;
const attemptTokenPattern = /^[!-~]{32,256}$/;
const artifactReferencePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
const resultOutcomes = ['succeeded', 'partial', 'failed', 'cancelled'] as const;
const inspectDispositions = ['running', 'finished', 'never_started', 'unknown', 'unsupported'] as const;
const stopDispositions = ['stopped', 'requested', 'unknown', 'unsupported'] as const;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function fields(value: unknown, ...keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function boundedText(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length > maxBytes || !value.trim() || value.includes('\0')) return false;
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes && bytes.toString('utf8') === value;
}

function parseEvent(value: unknown): WorkerEvent | undefined {
  if (fields(value, 'kind', 'message') && value.kind === 'progress' && boundedText(value.message, 4_096)) {
    return { kind: 'progress', message: value.message };
  }
  if (!fields(value, 'kind', 'outcome', 'summary', 'evidence', 'artifacts') || value.kind !== 'result'
    || !boundedText(value.summary, 8_192)
    || !Array.isArray(value.evidence) || value.evidence.length > 32
    || !value.evidence.every(item => boundedText(item, 1_024))
    || !Array.isArray(value.artifacts) || value.artifacts.length > 32) return undefined;
  const outcome = resultOutcomes.find(outcome => outcome === value.outcome);
  if (!outcome) return undefined;
  const artifacts: { reference: string; format: string }[] = [];
  for (const artifact of value.artifacts) {
    if (!fields(artifact, 'reference', 'format')
      || typeof artifact.reference !== 'string' || !artifactReferencePattern.test(artifact.reference)
      || !validWorkerFormat(artifact.format)) return undefined;
    artifacts.push({ reference: artifact.reference, format: artifact.format });
  }
  if (new Set(artifacts.map(artifact => artifact.reference)).size !== artifacts.length) return undefined;
  return { kind: 'result', outcome, summary: value.summary, evidence: value.evidence, artifacts };
}

function fenceFor(attempt: StoredWorkerAttempt): WorkerAttemptFence {
  return {
    attemptKey: attempt.attemptKey, workerId: attempt.workerId,
    leaseGeneration: attempt.leaseGeneration, attemptToken: attempt.attemptToken,
  };
}

function validFence(attempt: StoredWorkerAttempt | undefined, key: WorkerAttemptKey): attempt is StoredWorkerAttempt {
  return !!attempt && attempt.attemptKey === key.attemptKey && attempt.workerId === key.workerId
    && attempt.leaseGeneration === key.leaseGeneration && attemptTokenPattern.test(attempt.attemptToken);
}

async function invoke(timeoutMs: number, operation: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>(resolve => {
    timeout = setTimeout(() => {
      resolve(undefined);
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([expired, operation(controller.signal)]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export class WorkerEndpoint {
  readonly #secrets = new Map<string, Buffer>();

  constructor(
    private readonly registry: WorkerRegistry,
    private readonly attempts: WorkerAttemptPort,
    connectionSecrets: ReadonlyMap<string, string>,
  ) {
    const used = new Set<string>();
    for (const [workerId, secret] of connectionSecrets) {
      if (!registry.declaration(workerId) || !connectionSecretPattern.test(secret) || used.has(secret)) {
        throw new Error('invalid_worker_connection_secret');
      }
      used.add(secret);
      this.#secrets.set(workerId, digest(secret));
    }
  }

  authenticate(workerId: string, secret: string): WorkerConnection | undefined {
    const expected = this.#secrets.get(workerId);
    const declaration = this.registry.declaration(workerId);
    if (!expected || !declaration || !connectionSecretPattern.test(secret)
      || !timingSafeEqual(digest(secret), expected)) return undefined;
    return { report: payload => this.#report(workerId, declaration.limits.reportBytes, payload) };
  }

  // Called by the trusted scheduler. Worker connections can only submit reports.
  async start(key: WorkerAttemptKey): Promise<StartDisposition> {
    const attempt = this.attempts.getAttempt(key.attemptKey);
    if (!validFence(attempt, key)) return { disposition: 'rejected', reason: 'stale_attempt' };
    const match = this.registry.match(key.workerId, attempt.requirements, attempt.allowedPermissions);
    if ('reason' in match) return { disposition: 'rejected', reason: match.reason };

    const adapter = this.registry.adapter(key.workerId);
    if (!adapter) return { disposition: 'rejected', reason: 'unavailable_worker' };
    const fence = fenceFor(attempt);
    const { taskId, revision, requirements, goal, materials, deadlineAt, budget, workspaceKey, resumeFrom } = attempt;
    const start = { ...fence, taskId, revision, requirements: structuredClone(requirements), goal, materials: [...materials],
      deadlineAt, budget, ...(workspaceKey === undefined ? {} : { workspaceKey }),
      ...(resumeFrom === undefined ? {} : { resumeFrom: { ...resumeFrom } }) };
    if (!this.attempts.claimStart(fence)) return { disposition: 'rejected', reason: 'dispatch_not_claimed' };

    const result = await invoke(adapter.declaration.limits.operationTimeoutMs, signal => adapter.start(start, signal));
    if (fields(result, 'disposition') && result.disposition === 'rejected') {
      return { disposition: 'rejected', reason: 'adapter_rejected' };
    }
    if ((fields(result, 'disposition') || fields(result, 'disposition', 'externalId'))
      && (result.disposition === 'accepted' || result.disposition === 'unknown')) {
      if (validWorkerName(result.externalId)) return { disposition: result.disposition, externalId: result.externalId };
      if (!Object.hasOwn(result, 'externalId')) return { disposition: result.disposition };
    }
    return { disposition: 'unknown' };
  }

  async inspect(key: WorkerAttemptKey): Promise<WorkerInspection> {
    return { disposition: await this.#observe(key, 'inspect', inspectDispositions) };
  }

  async stop(key: WorkerAttemptKey): Promise<WorkerStopReceipt> {
    return { disposition: await this.#observe(key, 'stop', stopDispositions) };
  }

  async #observe<T extends string>(
    key: WorkerAttemptKey, operation: 'inspect' | 'stop', dispositions: readonly T[],
  ): Promise<T | 'unknown' | 'unsupported'> {
    const attempt = this.attempts.getAttempt(key.attemptKey);
    if (!validFence(attempt, key)) return 'unknown';
    const adapter = this.registry.adapter(key.workerId);
    const observe = adapter?.[operation];
    if (!adapter || !observe) return 'unsupported';
    const result = await invoke(adapter.declaration.limits.operationTimeoutMs,
      signal => observe(fenceFor(attempt), signal));
    if (!fields(result, 'disposition')) return 'unknown';
    return dispositions.find(disposition => disposition === result.disposition) ?? 'unknown';
  }

  #report(workerId: string, maxBytes: number, payload: Uint8Array): ReportDisposition {
    if (!(payload instanceof Uint8Array) || payload.byteLength > maxBytes) return { disposition: 'invalid_report' };
    let body: unknown;
    try {
      body = JSON.parse(utf8.decode(payload));
    } catch {
      return { disposition: 'invalid_report' };
    }
    if (!fields(body, 'protocolVersion', 'attemptKey', 'leaseGeneration', 'attemptToken', 'eventSeq', 'event')) {
      return { disposition: 'invalid_report' };
    }
    if (body.protocolVersion !== WORKER_PROTOCOL_VERSION) return { disposition: 'unsupported_version' };
    if (!validWorkerName(body.attemptKey) || !positiveWorkerInteger(body.leaseGeneration)
      || !positiveWorkerInteger(body.eventSeq)
      || typeof body.attemptToken !== 'string' || !attemptTokenPattern.test(body.attemptToken)) {
      return { disposition: 'invalid_report' };
    }
    const event = parseEvent(body.event);
    if (!event) return { disposition: 'invalid_report' };

    const attempt = this.attempts.getAttempt(body.attemptKey);
    if (!attempt || attempt.workerId !== workerId
      || !timingSafeEqual(digest(body.attemptToken), digest(attempt.attemptToken))) {
      return { disposition: 'unauthorized' };
    }
    if (body.leaseGeneration !== attempt.leaseGeneration) return { disposition: 'stale_attempt' };
    return { disposition: this.attempts.recordReport({ ...fenceFor(attempt), eventSeq: body.eventSeq, event }) };
  }
}
