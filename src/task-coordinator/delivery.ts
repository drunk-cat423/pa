import { validChannelRoute } from './delivery-store.js';
import type {
  ChannelRoute, DeliveryPart, DeliveryReceipt, DeliverySource, TaskDeliveryStore,
} from './delivery-store.js';

export interface ChannelDeliveryPart extends DeliveryPart, DeliverySource {
  readonly route: ChannelRoute;
  readonly notificationId: number;
}

export interface TaskDeliveryAdapter {
  /** Resolve the trusted inbound source and check the recipient's current owner binding. */
  resolveRoute(source: DeliverySource): ChannelRoute | undefined;
  /**
   * Enforce the supplied route at the actual channel send, including after any adapter queue wait.
   * Stop initiating sends when aborted. Report sent only with a genuine channel receipt.
   */
  sendPart(part: ChannelDeliveryPart, signal: AbortSignal): Promise<DeliveryReceipt>;
}

interface DeliveryWorkerOptions {
  readonly now?: () => number;
  readonly sendTimeoutMs?: number;
  readonly leaseMs?: number;
  readonly maxConcurrent?: number;
}

export class TaskDeliveryWorker {
  private readonly now: () => number;
  private readonly sendTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly maxConcurrent: number;
  private readonly active = new Set<Promise<boolean>>();
  private cursor = 0;
  private timer: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;
  private failure: { cause: unknown } | undefined;

  constructor(
    private readonly store: TaskDeliveryStore,
    private readonly adapter: TaskDeliveryAdapter,
    { now = Date.now, sendTimeoutMs = 30_000, leaseMs = 60_000, maxConcurrent = 4 }: DeliveryWorkerOptions = {},
  ) {
    if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 2_147_483_647
      || !Number.isSafeInteger(leaseMs) || leaseMs <= sendTimeoutMs || leaseMs > 2_147_483_647
      || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) {
      throw new Error('Invalid task delivery timeout or lease.');
    }
    this.now = now;
    this.sendTimeoutMs = sendTimeoutMs;
    this.leaseMs = leaseMs;
    this.maxConcurrent = maxConcurrent;
  }

  start(intervalMs: number): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647
      || this.timer || this.closing || this.failure) throw new Error('Invalid task delivery lifecycle.');
    const pump = (): void => {
      const available = this.maxConcurrent - this.active.size;
      for (let slot = 0; slot < available; slot++) void this.tick().catch(() => { /* tick retains the failure for close() */ });
    };
    this.timer = setInterval(pump, intervalMs);
    this.timer.unref();
    pump();
  }

  close(): Promise<void> {
    clearInterval(this.timer);
    this.closing ??= Promise.allSettled(this.active).then(() => {
      if (this.failure) throw this.failure.cause;
    });
    return this.closing;
  }

  /** Handle at most one whole result. Separate consumers may run in parallel across rooms. */
  async tick(): Promise<boolean> {
    if (this.closing) throw new Error('Task delivery worker is closed.');
    if (this.failure) throw this.failure.cause;
    if (this.active.size >= this.maxConcurrent) return false;
    const pending = this.deliver();
    this.active.add(pending);
    void pending.then(() => this.active.delete(pending), cause => {
      this.active.delete(pending);
      this.failure ??= { cause };
      clearInterval(this.timer);
    });
    return pending;
  }

  private async deliver(): Promise<boolean> {
    this.store.recoverExpired(this.now());
    let pending = this.store.pending(this.cursor);
    if (pending.length === 0 && this.cursor > 0) {
      this.cursor = 0;
      pending = this.store.pending();
    }
    for (const intent of pending) {
      this.cursor = intent.notificationId;
      if (intent.sourceKey === null) {
        this.store.rejectPending(intent, 'route_revoked');
        continue;
      }
      const source = { owner: intent.owner, sourceKey: intent.sourceKey };
      const route = this.resolveRoute(source);
      if (route === 'unavailable') continue;
      if (!route) {
        this.store.rejectPending(intent, 'route_revoked');
        continue;
      }
      const claim = this.store.claim(intent, route, this.now(), this.leaseMs);
      if (!claim) continue;
      while (true) {
        if (this.closing) {
          this.store.deferClaim(claim);
          break;
        }
        const current = this.resolveRoute(source);
        if (current === 'unavailable') {
          this.store.deferClaim(claim);
          break;
        }
        if (!current || current.roomKey !== claim.route.roomKey || current.recipientKey !== claim.route.recipientKey) {
          this.store.rejectClaim(claim, this.now());
          break;
        }
        const part = this.store.reservePart(claim, this.now(), this.leaseMs);
        if (!part) break;
        const receipt = await this.send({ ...source, ...part, route: claim.route, notificationId: claim.notificationId });
        if (!this.store.recordReceipt(claim, part.partNumber, receipt, this.now())) break;
      }
      return true;
    }
    return false;
  }

  private resolveRoute(source: DeliverySource): ChannelRoute | undefined | 'unavailable' {
    try {
      const route = this.adapter.resolveRoute(source);
      return validChannelRoute(route) ? route : undefined;
    } catch {
      return 'unavailable';
    }
  }

  private async send(part: ChannelDeliveryPart): Promise<DeliveryReceipt> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<DeliveryReceipt>(resolve => {
      timer = setTimeout(() => {
        resolve({ status: 'unknown' });
        controller.abort();
      }, this.sendTimeoutMs);
    });
    try {
      const result = await Promise.race([expiry, this.adapter.sendPart(part, controller.signal)]);
      return result?.status === 'sent' || result?.status === 'rejected' ? result : { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    } finally {
      clearTimeout(timer);
    }
  }
}
