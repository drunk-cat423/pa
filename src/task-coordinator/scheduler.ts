import type { WorkerRegistry } from './registry.js';
import type { SchedulingLimits, SchedulingRound, SchedulingUsage } from './scheduler-store.js';
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
}

export interface SchedulerRound extends SchedulingRound {
  readonly dispatches: readonly Promise<StartDisposition>[];
}

export function validateSchedulingInterval(intervalMs: number): void {
  if (!positiveWorkerInteger(intervalMs) || intervalMs > 2_147_483_647) throw new Error('invalid_scheduler_interval');
}

export class TaskScheduler {
  readonly endpoint: WorkerEndpoint;
  readonly #limits: SchedulingLimits;
  readonly #scanLimit: number;
  readonly #now: () => number;
  readonly #inFlight = new Set<Promise<StartDisposition>>();
  #workers: readonly WorkerDeclaration[];
  #timer: NodeJS.Timeout | undefined;
  #closing: Promise<void> | undefined;
  #failure: { cause: unknown } | undefined;

  constructor(private readonly options: SchedulerOptions) {
    const { store, registry, connectionSecrets, maxConcurrent, maxConcurrentPerOwner = maxConcurrent,
      scanLimit = 32, now = Date.now } = options;
    const poolLimits = new Map(options.poolLimits);
    if (!positiveWorkerInteger(maxConcurrent) || !positiveWorkerInteger(maxConcurrentPerOwner)
      || !positiveWorkerInteger(scanLimit) || scanLimit > maxScanLimit
      || [...poolLimits].some(([poolId, units]) => !validWorkerName(poolId) || !positiveWorkerInteger(units))) {
      throw new Error('invalid_scheduler_limits');
    }
    this.#limits = { maxConcurrent, maxConcurrentPerOwner, poolLimits };
    this.#scanLimit = scanLimit;
    this.#now = now;
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
    if (!healthy.size) return { examined: 0, attempts: [], dispatches: [] };
    const round = store.scheduling.claimRound({
      limits: this.#limits, scanLimit: this.#scanLimit, now: this.#now(),
      permissions: allowedPermissions ?? (() => noPermissions),
      select(requirements, permissions, hasCapacity) {
        const selected = registry.select(requirements, permissions, {
          isHealthy: worker => healthy.has(worker.workerId), hasCapacity,
        });
        return 'workerId' in selected ? registry.declaration(selected.workerId) : undefined;
      },
    });
    return { ...round, dispatches: round.attempts.map(attempt => this.#dispatch(attempt)) };
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
    const pending = Promise.resolve().then(async () => {
      const result = await this.endpoint.start(attempt);
      this.options.store.scheduling.finishStart(attempt, result, this.#now());
      return result;
    });
    this.#inFlight.add(pending);
    void pending.then(() => this.#inFlight.delete(pending), cause => {
      this.#inFlight.delete(pending);
      this.#fail(cause);
    });
    return pending;
  }

  #fail(cause: unknown): void {
    this.#failure ??= { cause };
    clearInterval(this.#timer);
  }
}
