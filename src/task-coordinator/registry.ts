import {
  MAX_WORKER_REPORT_BYTES, WORKER_PROTOCOL_VERSION, positiveWorkerInteger, validWorkerFormat, validWorkerName,
} from './worker-contract.js';
import type { WorkerAdapter, WorkerCapability, WorkerDeclaration, WorkerRequirements } from './worker-contract.js';

export type WorkerMismatch =
  | 'unsupported_version'
  | 'unsupported_capability'
  | 'unsupported_format'
  | 'permission_denied'
  | 'unavailable_worker';

export type WorkerSelection = { readonly workerId: string } | { readonly reason: WorkerMismatch };

export interface WorkerAvailability {
  isHealthy?(worker: WorkerDeclaration): boolean;
  hasCapacity?(worker: WorkerDeclaration): boolean;
}

function unique<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}

function validFormats(items: unknown): items is readonly string[] {
  return Array.isArray(items) && items.length <= 64 && Array.from(items).every(validWorkerFormat);
}

function validList(items: unknown, isValid: (item: unknown) => boolean): boolean {
  return Array.isArray(items) && items.length <= 64 && Array.from(items).every(isValid)
    && new Set(items).size === items.length;
}

function validCapability(value: WorkerCapability): boolean {
  return !!value && validWorkerName(value.name)
    && validList(value.inputFormats, validWorkerFormat)
    && validList(value.outputFormats, validWorkerFormat)
    && validList(value.requiredPermissions, validWorkerName);
}

function includesFormats(capability: WorkerCapability, requirements: WorkerRequirements): boolean {
  return requirements.inputFormats.every(format => capability.inputFormats.includes(format))
    && requirements.outputFormats.every(format => capability.outputFormats.includes(format));
}

export class WorkerRegistry {
  readonly #workers = new Map<string, WorkerAdapter>();

  register(adapter: WorkerAdapter): void {
    const declaration = adapter.declaration;
    if (!declaration || declaration.protocolVersion !== WORKER_PROTOCOL_VERSION
      || !validWorkerName(declaration.workerId)
      || !Array.isArray(declaration.capabilities) || !declaration.capabilities.length
      || declaration.capabilities.length > 64 || !Array.from(declaration.capabilities).every(validCapability)
      || !unique(declaration.capabilities, capability => capability.name)
      || !Array.isArray(declaration.resources) || declaration.resources.length > 64
      || !Array.from(declaration.resources).every(resource =>
        !!resource && validWorkerName(resource.poolId) && positiveWorkerInteger(resource.units))
      || !unique(declaration.resources, resource => resource.poolId)
      || !positiveWorkerInteger(declaration.limits?.maxConcurrent)
      || !positiveWorkerInteger(declaration.limits.operationTimeoutMs)
      || declaration.limits.operationTimeoutMs > 300_000
      || !positiveWorkerInteger(declaration.limits.reportBytes)
      || declaration.limits.reportBytes > MAX_WORKER_REPORT_BYTES
      || typeof declaration.idempotentStart !== 'boolean'
      || (declaration.effects !== 'none' && declaration.effects !== 'external')
      || typeof adapter.start !== 'function'
      || typeof declaration.canResume !== 'boolean'
      || typeof declaration.canInspect !== 'boolean'
      || (declaration.canInspect ? typeof adapter.inspect !== 'function' : adapter.inspect !== undefined)
      || typeof declaration.canStop !== 'boolean'
      || (declaration.canStop ? typeof adapter.stop !== 'function' : adapter.stop !== undefined)) {
      throw new Error('invalid_worker_declaration');
    }
    if (this.#workers.has(declaration.workerId)) throw new Error('duplicate_worker_id');

    this.#workers.set(declaration.workerId, Object.freeze({
      declaration: Object.freeze({
        workerId: declaration.workerId,
        protocolVersion: declaration.protocolVersion,
        capabilities: Object.freeze(declaration.capabilities.map(capability => Object.freeze({
          name: capability.name,
          inputFormats: Object.freeze([...capability.inputFormats]),
          outputFormats: Object.freeze([...capability.outputFormats]),
          requiredPermissions: Object.freeze([...capability.requiredPermissions]),
        }))),
        resources: Object.freeze(declaration.resources.map(resource => Object.freeze({
          poolId: resource.poolId, units: resource.units,
        }))),
        limits: Object.freeze({
          maxConcurrent: declaration.limits.maxConcurrent,
          operationTimeoutMs: declaration.limits.operationTimeoutMs,
          reportBytes: declaration.limits.reportBytes,
        }),
        idempotentStart: declaration.idempotentStart,
        canResume: declaration.canResume,
        canInspect: declaration.canInspect,
        canStop: declaration.canStop,
        effects: declaration.effects,
      }),
      start: adapter.start.bind(adapter),
      ...(adapter.inspect ? { inspect: adapter.inspect.bind(adapter) } : {}),
      ...(adapter.stop ? { stop: adapter.stop.bind(adapter) } : {}),
    }));
  }

  describe(): readonly WorkerDeclaration[] {
    return Array.from(this.#workers.values(), worker => worker.declaration);
  }

  declaration(workerId: string): WorkerDeclaration | undefined {
    return this.#workers.get(workerId)?.declaration;
  }

  adapter(workerId: string): WorkerAdapter | undefined {
    const worker = this.#workers.get(workerId);
    return worker && { ...worker };
  }

  select(
    requirements: WorkerRequirements,
    allowedPermissions: ReadonlySet<string>,
    availability: WorkerAvailability = {},
  ): WorkerSelection {
    return this.#select(requirements, allowedPermissions, this.describe(), availability);
  }

  match(
    workerId: string,
    requirements: WorkerRequirements,
    allowedPermissions: ReadonlySet<string>,
  ): WorkerSelection {
    const worker = this.declaration(workerId);
    return this.#select(requirements, allowedPermissions, worker ? [worker] : [], {});
  }

  #select(
    requirements: WorkerRequirements,
    allowedPermissions: ReadonlySet<string>,
    declarations: readonly WorkerDeclaration[],
    availability: WorkerAvailability,
  ): WorkerSelection {
    if (requirements.protocolVersion !== WORKER_PROTOCOL_VERSION) return { reason: 'unsupported_version' };
    if (!declarations.length) return { reason: 'unavailable_worker' };
    const matches = declarations.flatMap(worker => {
      const capability = worker.capabilities.find(capability => capability.name === requirements.capability);
      return capability ? [{ worker, capability }] : [];
    });
    if (!matches.length) return { reason: 'unsupported_capability' };
    if (!validFormats(requirements.inputFormats) || !validFormats(requirements.outputFormats)) {
      return { reason: 'unsupported_format' };
    }
    const compatible = matches.filter(({ capability }) => includesFormats(capability, requirements));
    if (!compatible.length) return { reason: 'unsupported_format' };
    const authorized = compatible.filter(({ capability }) =>
      capability.requiredPermissions.every(permission => allowedPermissions.has(permission)));
    if (!authorized.length) return { reason: 'permission_denied' };
    const available = authorized.find(({ worker }) =>
      (availability.isHealthy?.(worker) ?? true) && (availability.hasCapacity?.(worker) ?? true));
    return available ? { workerId: available.worker.workerId } : { reason: 'unavailable_worker' };
  }
}
