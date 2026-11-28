import type { WorkerRegistry } from './registry.js';
import type { RecoveryEvidence, RecoveryProbe, SchedulingLimits, SchedulingRound, SchedulingUsage } from './scheduler-store.js';
import type { TaskCoordinatorStore } from './store.js';
import { positiveWorkerInteger, validWorkerName } from './worker-contract.js';
import type { WorkerAttemptKey, WorkerDeclaration } from './worker-contract.js';
import { WorkerEndpoint } from './worker-endpoint.js';
import type { StartDisposition } from './worker-endpoint.js';

const maxScanLimit = 1_024;
const noPermissions: ReadonlySet<string> = new Set();

export interface SchedulerOptions {
  readonly store: TaskCoordinatorStore;
  readonly registry: WorkerRegistry;
  readonly connectionSecrets: ReadonlyMap<string, string>;
  readonly maxConcurrent: number;
  readonly maxConcurrentPerOwner?: number;
  readonly poolLimits: ReadonlyMap<string, number>;
  readonly scanLimit?: number;
  /** Synchronous policy lookup. It must not perform I/O or write to the coordinator. */
  readonly allowedPermissions?: (owner: string) => ReadonlySet<string>;
  readonly isHealthy?: (worker: WorkerDeclaration) => boolean;
  readonly now?: () => number;
  readonly recoveryGraceMs?: number;
  readonly recoveryIntervalMs?: number;
  readonly recoveryLimit?: number;
}

export interface SchedulerRound extends SchedulingRound {
  readonly dispatches: readonly Promise<StartDisposition>[];
  readonly recoveries: readonly Promise<void>[];
}

export function validateSchedulingInterval(intervalMs: number): void {
  if (!positiveWorkerInteger(intervalMs) || intervalMs > 2_147_483_647) throw new Error('invalid_scheduler_interval');
}

export class TaskScheduler {
  readonly endpoint: WorkerEndpoint;
  readonly #limits: SchedulingLimits;
  readonly #scanLimit: number;
  readonly #now: () => number;
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #dispatching = new Set<string>();
  readonly #recovering = new Set<string>();
  readonly #recoveryGrace: number;
  readonly #recoveryInterval: number;
  readonly #recoveryLimit: number;
  #workers: readonly WorkerDeclaration[];
  #timer: NodeJS.Timeout | undefined;
  #closing: Promise<void> | undefined;
  #failure: { cause: unknown } | undefined;

  constructor(private readonly options: SchedulerOptions) {
    const { store, registry, connectionSecrets, maxConcurrent, maxConcurrentPerOwner = maxConcurrent,
      scanLimit = 32, now = Date.now, recoveryGraceMs = 30_000, recoveryIntervalMs = 1_000, recoveryLimit = 16 } = options;
    const poolLimits = new Map(options.poolLimits);
    if (!positiveWorkerInteger(maxConcurrent) || !positiveWorkerInteger(maxConcurrentPerOwner)
      || !positiveWorkerInteger(scanLimit) || scanLimit > maxScanLimit
      || !positiveWorkerInteger(recoveryLimit) || recoveryLimit > maxScanLimit
      || [...poolLimits].some(([poolId, units]) => !validWorkerName(poolId) || !positiveWorkerInteger(units))) {
      throw new Error('invalid_scheduler_limits');
    }
    this.#limits = { maxConcurrent, maxConcurrentPerOwner, poolLimits };
    this.#scanLimit = scanLimit;
    this.#now = now;
    validateSchedulingInterval(recoveryGraceMs);
    validateSchedulingInterval(recoveryIntervalMs);
    this.#recoveryGrace = recoveryGraceMs;
    this.#recoveryInterval = recoveryIntervalMs;
    this.#recoveryLimit = recoveryLimit;
    this.#workers = registry.describe();
    this.endpoint = new WorkerEndpoint(registry, store.scheduling.workerPort(now), connectionSecrets);
    store.scheduling.configure(this.#limits, this.#workers);
  }

  tick(): SchedulerRound {
    if (this.#closing) throw new Error('scheduler_closed');
    if (this.#failure) throw this.#failure.cause;
    const { store, registry, allowedPermissions, isHealthy } = this.options;
    const workers = registry.describe();
    if (workers.length !== this.#workers.length) {
      store.scheduling.configure(this.#limits, workers.slice(this.#workers.length));
      this.#workers = workers;
    }
    const healthy = new Set(workers.filter(worker => isHealthy?.(worker) ?? true).map(worker => worker.workerId));
    const now = this.#now();
    const timeouts = new Map(workers.map(worker => [worker.workerId, worker.limits.operationTimeoutMs]));
    const probes = store.scheduling.recover(now, this.#recoveryGrace, this.#recoveryLimit,
      this.#recoveryInterval, timeouts, this.#recovering);
    const recoveries = probes.map(probe => this.#recover(probe));
    const unsent = store.scheduling.unsent(now, healthy, this.#recoveryLimit)
      .filter(attempt => !this.#dispatching.has(attempt.attemptKey));
    const round = healthy.size ? store.scheduling.claimRound({
      limits: this.#limits, scanLimit: this.#scanLimit, now, recoveryGraceMs: this.#recoveryGrace,
      permissions: allowedPermissions ?? (() => noPermissions),
      select(requirements, permissions, hasCapacity) {
        const selected = registry.select(requirements, permissions, {
          isHealthy: worker => healthy.has(worker.workerId), hasCapacity,
        });
        return 'workerId' in selected ? registry.declaration(selected.workerId) : undefined;
      },
    }) : { examined: 0, attempts: [] };
    const attempts = [...unsent, ...round.attempts];
    return { ...round, attempts, dispatches: attempts.map(attempt => this.#dispatch(attempt)), recoveries };
  }

  now(): number {
    return this.#now();
  }

  start(intervalMs: number): void {
    validateSchedulingInterval(intervalMs);
    if (this.#closing || this.#timer || this.#failure) throw new Error('scheduler_unavailable');
    this.tick();
    this.#timer = setInterval(() => {
      try { this.tick(); }
      catch (cause) { this.#fail(cause); }
    }, intervalMs);
    this.#timer.unref();
  }

  usage(): SchedulingUsage {
    return this.options.store.scheduling.usage();
  }

  // Wait for start receipts currently outstanding. Running attempts remain durable for reconciliation.
  close(): Promise<void> {
    clearInterval(this.#timer);
    this.#closing ??= Promise.allSettled(this.#inFlight).then(() => {
      if (this.#failure) throw this.#failure.cause;
    });
    return this.#closing;
  }

  #dispatch(attempt: WorkerAttemptKey): Promise<StartDisposition> {
    this.#dispatching.add(attempt.attemptKey);
    const pending = Promise.resolve().then(async () => {
      const result = await this.endpoint.start(attempt);
      this.options.store.scheduling.finishStart(attempt, result, this.#now());
      return result;
    });
    this.#track(pending, () => this.#dispatching.delete(attempt.attemptKey));
    return pending;
  }

  #recover(probe: RecoveryProbe): Promise<void> {
    this.#recovering.add(probe.attempt.attemptKey);
    const pending = Promise.resolve().then(async () => {
      const result = probe.operation === 'stop'
        ? await this.endpoint.stop(probe.attempt) : await this.endpoint.inspect(probe.attempt);
      // Unobserved starts may still arrive after an inspection finds no running operation.
      const evidence: RecoveryEvidence = result.disposition === 'stopped' || result.disposition === 'finished'
        ? result.disposition : 'unconfirmed';
      this.options.store.scheduling.finishRecovery(probe, evidence, this.#now(), this.#recoveryInterval);
    });
    this.#track(pending, () => this.#recovering.delete(probe.attempt.attemptKey));
    return pending;
  }

  #track(pending: Promise<unknown>, release: () => void): void {
    this.#inFlight.add(pending);
    const clear = () => { this.#inFlight.delete(pending); release(); };
    void pending.then(clear, cause => { clear(); this.#fail(cause); });
  }

  #fail(cause: unknown): void {
    this.#failure ??= { cause };
    clearInterval(this.#timer);
  }
}
