export const WORKER_PROTOCOL_VERSION = 1;
export const MAX_WORKER_REPORT_BYTES = 64 * 1024;

export interface WorkerRequirements {
  readonly protocolVersion: number;
  readonly capability: string;
  readonly inputFormats: readonly string[];
  readonly outputFormats: readonly string[];
}

export interface WorkerCapability {
  readonly name: string;
  readonly inputFormats: readonly string[];
  readonly outputFormats: readonly string[];
  readonly requiredPermissions: readonly string[];
}

export interface WorkerDeclaration {
  readonly workerId: string;
  readonly protocolVersion: number;
  readonly capabilities: readonly WorkerCapability[];
  readonly resources: readonly { readonly poolId: string; readonly units: number }[];
  readonly limits: { readonly maxConcurrent: number; readonly operationTimeoutMs: number; readonly reportBytes: number };
  readonly idempotentStart: boolean;
  readonly canResume: boolean;
  readonly canInspect: boolean;
  readonly canStop: boolean;
  readonly effects: 'none' | 'external';
}

export interface WorkerAttemptKey {
  readonly attemptKey: string;
  readonly workerId: string;
  readonly leaseGeneration: number;
}

export interface WorkerAttemptFence extends WorkerAttemptKey {
  readonly attemptToken: string;
}

export interface WorkerStart extends WorkerAttemptFence {
  readonly taskId: string;
  readonly revision: number;
  readonly requirements: WorkerRequirements;
  readonly goal: string;
  readonly materials: readonly string[];
  readonly deadlineAt: number;
  readonly budget: number;
  readonly workspaceKey?: string;
  readonly resumeFrom?: {
    readonly attemptKey: string;
    readonly revision: number;
    readonly externalId?: string;
  };
}

export type WorkerStartReceipt =
  | { readonly disposition: 'accepted' | 'unknown'; readonly externalId?: string }
  | { readonly disposition: 'rejected' };

export type WorkerInspection =
  | { readonly disposition: 'running' | 'finished' | 'never_started' | 'unknown' | 'unsupported' };

export type WorkerStopReceipt =
  | { readonly disposition: 'stopped' | 'requested' | 'unknown' | 'unsupported' };

export interface WorkerAdapter {
  readonly declaration: WorkerDeclaration;
  start(attempt: WorkerStart, signal: AbortSignal): Promise<WorkerStartReceipt>;
  inspect?(attempt: WorkerAttemptFence, signal: AbortSignal): Promise<WorkerInspection>;
  stop?(attempt: WorkerAttemptFence, signal: AbortSignal): Promise<WorkerStopReceipt>;
}

export type WorkerEvent =
  | { readonly kind: 'progress'; readonly message: string }
  | {
    readonly kind: 'result';
    readonly outcome: 'succeeded' | 'partial' | 'failed' | 'cancelled';
    readonly summary: string;
    readonly evidence: readonly string[];
    readonly artifacts: readonly { readonly reference: string; readonly format: string }[];
  };

export interface AuthenticatedWorkerReport extends WorkerAttemptFence {
  readonly eventSeq: number;
  readonly event: WorkerEvent;
}

export type WorkerRecordDisposition = 'recorded' | 'duplicate' | 'conflict' | 'out_of_order' | 'late' | 'stale_attempt';

export function validWorkerName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
}

export function validWorkerFormat(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.+_/-]{0,127}$/.test(value);
}

export function positiveWorkerInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
