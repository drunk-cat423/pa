import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute } from "node:path";
import { ArtifactUnavailableError } from "./artifacts.js";
import type { TaskDeliveryStore } from "./delivery-store.js";
import type { TaskDeliveryWorker } from "./delivery.js";
import { validateSchedulingInterval } from "./scheduler.js";
import type { TaskScheduler } from "./scheduler.js";
import { TaskCoordinatorError } from "./store.js";
import type { TaskCoordinatorStore, TaskSpec } from "./store.js";

const protocolVersion = 1;
const maxBodyBytes = 64 * 1024;
const tokenPattern = /^[!-~]{32,256}$/;

type RequestBody = Record<string, unknown>;

type CoordinatorOptions = {
  socketPath: string;
  owner: string;
  token: string;
  store: TaskCoordinatorStore;
  scheduler?: TaskScheduler;
  schedulingIntervalMs?: number;
  deliveryStore?: TaskDeliveryStore;
  deliveryWorker?: TaskDeliveryWorker;
  deliveryIntervalMs?: number;
};

const errorStatuses = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  invalid_state: 409,
  artifact_unavailable: 409,
  request_too_large: 413,
  unsupported_media_type: 415,
  unsupported_version: 426,
  internal_error: 500,
} as const;

type ErrorCode = keyof typeof errorStatuses;

class RequestError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

function respond(response: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify({ protocolVersion, ...body });
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
  });
  response.end(payload);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(request: IncomingMessage, tokenDigest: Buffer): boolean {
  const authorization = request.headersDistinct.authorization;
  const header = authorization?.[0];
  if (authorization?.length !== 1 || !header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length);
  return tokenPattern.test(token) && timingSafeEqual(digest(token), tokenDigest);
}

async function readBody(request: IncomingMessage): Promise<RequestBody> {
  const contentType = request.headers["content-type"];
  if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new RequestError("unsupported_media_type");
  }
  if (Number(request.headers["content-length"]) > maxBodyBytes) {
    throw new RequestError("request_too_large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBodyBytes) throw new RequestError("request_too_large");
    chunks.push(chunk);
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
  } catch {
    throw new RequestError("invalid_request");
  }
  const body = readObject(value);
  const version = readNumber(body.protocolVersion);
  if (version !== protocolVersion) throw new RequestError("unsupported_version");
  return body;
}

function readObject(value: unknown): RequestBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RequestError("invalid_request");
  return value as RequestBody;
}

function fields(body: RequestBody, ...allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new RequestError("invalid_request");
}

function readString(value: unknown): string {
  if (typeof value !== "string") throw new RequestError("invalid_request");
  return value;
}

function readNumber(value: unknown): number {
  if (typeof value !== "number") throw new RequestError("invalid_request");
  return value;
}

function readList<T>(value: unknown, readItem: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new RequestError("invalid_request");
  return value.map(readItem);
}

function parseSpec(value: unknown): TaskSpec {
  const spec = readObject(value);
  fields(spec, "goal", "capability", "materials", "deadlineAt", "budget", "workspaceKey", "inputFormats", "outputFormats",
    "dependencies", "waitingForInput", "notBeforeAt", "requiredArtifactFormats");
  const { waitingForInput } = spec;
  if (waitingForInput !== undefined && typeof waitingForInput !== "boolean") throw new RequestError("invalid_request");
  return {
    goal: readString(spec.goal),
    capability: readString(spec.capability),
    materials: readList(spec.materials, readString),
    deadlineAt: readNumber(spec.deadlineAt),
    budget: readNumber(spec.budget),
    ...(waitingForInput === undefined ? {} : { waitingForInput }),
    ...(spec.notBeforeAt === undefined ? {} : { notBeforeAt: readNumber(spec.notBeforeAt) }),
    ...(spec.workspaceKey === undefined ? {} : { workspaceKey: readString(spec.workspaceKey) }),
    ...(spec.inputFormats === undefined ? {} : { inputFormats: readList(spec.inputFormats, readString) }),
    ...(spec.outputFormats === undefined ? {} : { outputFormats: readList(spec.outputFormats, readString) }),
    ...(spec.requiredArtifactFormats === undefined ? {} : { requiredArtifactFormats: readList(spec.requiredArtifactFormats, readString) }),
    ...(spec.dependencies === undefined ? {} : { dependencies: readList(spec.dependencies, value => {
      const dependency = readObject(value);
      fields(dependency, "taskId", "revision", "allowPartial");
      const { allowPartial } = dependency;
      if (allowPartial !== undefined && typeof allowPartial !== "boolean") throw new RequestError("invalid_request");
      return { taskId: readString(dependency.taskId), revision: readNumber(dependency.revision),
        ...(allowPartial === undefined ? {} : { allowPartial }) };
    }) }),
  };
}

function readId(value: unknown, min = 1): number {
  const id = readNumber(value);
  if (!Number.isSafeInteger(id) || id < min) throw new RequestError("invalid_request");
  return id;
}

function readReceipt(body: RequestBody): { taskId: string; revision: number } {
  const taskId = readString(body.taskId);
  if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new RequestError("invalid_request");
  return { taskId, revision: readId(body.revision) };
}

async function dispatch(
  request: IncomingMessage,
  owner: string,
  store: TaskCoordinatorStore,
  scheduler: TaskScheduler | undefined,
  deliveryStore: TaskDeliveryStore | undefined,
): Promise<unknown> {
  if (request.method !== "POST") throw new RequestError("method_not_allowed");
  const body = await readBody(request);
  switch (request.url) {
    case "/v1/submit":
      fields(body, "protocolVersion", "sourceKey", "spec");
      return store.submit(owner, readString(body.sourceKey), parseSpec(body.spec));
    case "/v1/revise":
      fields(body, "protocolVersion", "sourceKey", "taskId", "expectedRevision", "newGoal", "materials", "deadlineAt");
      return store.revise(
        owner, readString(body.sourceKey), readString(body.taskId), readNumber(body.expectedRevision), readString(body.newGoal),
        {
          ...(body.materials === undefined ? {} : { materials: readList(body.materials, readString) }),
          ...(body.deadlineAt === undefined ? {} : { deadlineAt: readNumber(body.deadlineAt) }),
        },
      );
    case "/v1/cancel":
      fields(body, "protocolVersion", "taskId", "revision");
      return store.cancel(owner, readString(body.taskId), readNumber(body.revision), scheduler?.now());
    case "/v1/lookup":
      fields(body, "protocolVersion", "sourceKey");
      return store.lookupRequest(owner, readString(body.sourceKey));
    case "/v1/result":
      fields(body, "protocolVersion", "taskId", "revision", "afterNotificationId");
      return deliveryStore?.result(owner, readReceipt(body),
        body.afterNotificationId === undefined ? 0 : readId(body.afterNotificationId, 0));
    case "/v1/artifact": {
      fields(body, "protocolVersion", "taskId", "revision", "reference");
      const reference = readString(body.reference);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(reference)) throw new RequestError("invalid_request");
      const artifact = deliveryStore?.readArtifact(owner, readReceipt(body), reference);
      if (!artifact) return undefined;
      const { bytes, ...metadata } = artifact;
      return { ...metadata, bytesBase64: Buffer.from(bytes).toString("base64") };
    }
    case "/v1/reclaim":
      fields(body, "protocolVersion", "taskId", "revision", "sourceKey");
      return deliveryStore && { notificationId: deliveryStore.reclaim(owner, readString(body.sourceKey), readReceipt(body)) };
    case "/v1/delivery":
      fields(body, "protocolVersion", "notificationId");
      return deliveryStore?.delivery(owner, readId(body.notificationId));
    case "/v1/status":
      fields(body, "protocolVersion", "taskId", "revision");
      return store.status(owner, readString(body.taskId), body.revision === undefined ? undefined : readNumber(body.revision));
    default:
      throw new RequestError("not_found");
  }
}

export function privateDirectory(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    const entry = lstatSync(path);
    const uid = process.getuid?.();
    return entry.isDirectory() && (uid === undefined || (entry.uid === uid && (entry.mode & 0o077) === 0));
  } catch {
    return false;
  }
}

function validateEndpoint(socketPath: string): void {
  if (typeof socketPath !== "string") throw new Error("invalid_endpoint");
  if (process.platform === "win32") {
    if (!/^\\\\\.\\pipe\\[a-z0-9._-]{1,240}$/i.test(socketPath)) throw new Error("invalid_endpoint");
    return;
  }

  const maxPathBytes = process.platform === "linux" ? 107 : 103;
  if (!privateDirectory(dirname(socketPath)) || socketPath.includes("\0") ||
      Buffer.byteLength(socketPath) > maxPathBytes) {
    throw new Error("invalid_endpoint");
  }
  try {
    lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("invalid_endpoint");
  }
  throw new Error("endpoint_in_use");
}

export async function startCoordinator({
  socketPath, owner, token, store, scheduler, schedulingIntervalMs = 100,
  deliveryStore, deliveryWorker, deliveryIntervalMs = 100,
}: CoordinatorOptions): Promise<{ close(): Promise<void> }> {
  if (typeof owner !== "string" || owner.trim() !== owner || owner.length === 0 || owner.length > 256 ||
      typeof token !== "string" || !tokenPattern.test(token)) {
    throw new Error("invalid_credential");
  }
  if (scheduler) validateSchedulingInterval(schedulingIntervalMs);
  if (deliveryWorker) validateSchedulingInterval(deliveryIntervalMs);
  validateEndpoint(socketPath);
  const tokenDigest = digest(token);
  const server = createServer({
    maxHeaderSize: 8 * 1024,
    headersTimeout: 5_000,
    requestTimeout: 10_000,
    connectionsCheckingInterval: 1_000,
  }, (request, response) => {
    void (async () => {
      try {
        if (!authorized(request, tokenDigest)) throw new RequestError("unauthorized");
        const result = await dispatch(request, owner, store, scheduler, deliveryStore);
        if (result === undefined) throw new RequestError("not_found");
        respond(response, 200, { result });
      } catch (error) {
        if (response.destroyed) return;
        const code = error instanceof RequestError || error instanceof TaskCoordinatorError
          ? error.code
          : error instanceof ArtifactUnavailableError ? "artifact_unavailable" : "internal_error";
        respond(response, errorStatuses[code], { error: code });
      }
    })();
  });
  server.maxConnections = 64;

  await new Promise<void>((resolve, reject) => {
    function onStartupError(error: NodeJS.ErrnoException): void {
      reject(new Error(error.code === "EADDRINUSE" ? "endpoint_in_use" : "endpoint_unavailable"));
    }
    server.once("error", onStartupError);
    server.listen(socketPath, () => {
      server.removeListener("error", onStartupError);
      resolve();
    });
  });

  const closeServer = () => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(new Error("endpoint_close_failed"));
      else resolve();
    });
  });
  try {
    scheduler?.start(schedulingIntervalMs);
    deliveryWorker?.start(deliveryIntervalMs);
  } catch (error) {
    await Promise.allSettled([closeServer(), scheduler?.close()]);
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= Promise.allSettled([closeServer(), scheduler?.close(), deliveryWorker?.close()]).then(results => {
        for (const result of results) if (result.status === "rejected") throw result.reason;
      });
      return closing;
    },
  };
}
