import { createHash } from 'node:crypto';
import { imageTokenPayload, IMAGE_TOKENS, MAX_REQUEST_IMAGES } from './image-context.js';

const VERSION = 1;
const CHUNK_BYTES = 8192;
const MAX_BLOCKS = 2048;
const MAX_BYTES = 16 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export interface ContextFootprint {
  bytes: number;
  blocks: { hash: string; bytes: number; count: number }[];
  imageIds?: string[];
}
export interface ContextCalibration {
  version: 1;
  key: string;
  footprint: ContextFootprint;
}
export interface CalibratedInput {
  inputTokens: number;
  calibration: { sampleInputTokens: number; retainedBytes: number; newBytes: number };
}

/** No endpoint, credentials, scope identifiers or message text are persisted. */
export function contextCalibrationKey(provider: string, model: string, api: string, baseUrl: string, scope: string): string {
  return hash(JSON.stringify([VERSION, provider, model, api, baseUrl, scope]));
}

/** Chunk each message independently so phase/envelope changes do not invalidate history. */
export function contextFootprint(payload: unknown): ContextFootprint | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const visual = imageTokenPayload(payload);
  const { messages, ...envelope } = visual.text as Record<string, unknown>;
  if (!Array.isArray(messages)) return undefined;
  const blocks = new Map<string, { hash: string; bytes: number; count: number }>();
  let bytes = 0, count = 0;
  for (const part of [envelope, ...messages]) {
    const data = Buffer.from(JSON.stringify(part), 'utf8');
    bytes += data.length;
    if (bytes > MAX_BYTES) return undefined;
    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
      if (++count > MAX_BLOCKS) return undefined;
      const chunk = data.subarray(offset, offset + CHUNK_BYTES);
      const digest = hash(chunk);
      const key = `${digest}:${chunk.length}`;
      const previous = blocks.get(key);
      if (previous) previous.count++;
      else blocks.set(key, { hash: digest, bytes: chunk.length, count: 1 });
    }
  }
  return { bytes, blocks: [...blocks.values()], ...(visual.imageIds.length ? { imageIds: visual.imageIds.map(hash) } : {}) };
}

export function validContextCalibration(value: unknown): value is ContextCalibration {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as ContextCalibration;
  if (Object.keys(metadata).some(key => !['version', 'key', 'footprint'].includes(key))) return false;
  if (metadata.version !== VERSION || typeof metadata.key !== 'string' || !HASH.test(metadata.key)) return false;
  const fp = metadata.footprint;
  if (!fp || !Number.isSafeInteger(fp.bytes) || fp.bytes <= 0 || fp.bytes > MAX_BYTES
    || !Array.isArray(fp.blocks) || !fp.blocks.length || fp.blocks.length > MAX_BLOCKS) return false;
  if (Object.keys(fp).some(key => !['bytes', 'blocks', 'imageIds'].includes(key))) return false;
  if (fp.imageIds !== undefined && (!Array.isArray(fp.imageIds) || fp.imageIds.length > MAX_REQUEST_IMAGES
    || fp.imageIds.some(id => typeof id !== 'string' || !HASH.test(id)))) return false;
  let bytes = 0, count = 0;
  const seen = new Set<string>();
  for (const block of fp.blocks) {
    if (!block || typeof block.hash !== 'string' || !HASH.test(block.hash)
      || !Number.isSafeInteger(block.bytes) || block.bytes <= 0 || block.bytes > CHUNK_BYTES
      || !Number.isSafeInteger(block.count) || block.count <= 0 || block.count > MAX_BLOCKS) return false;
    if (Object.keys(block).some(key => !['hash', 'bytes', 'count'].includes(key))) return false;
    const key = `${block.hash}:${block.bytes}`;
    if (seen.has(key)) return false;
    seen.add(key);
    bytes += block.bytes * block.count;
    count += block.count;
  }
  return bytes === fp.bytes && count <= MAX_BLOCKS;
}

/** Pi's input excludes cache reads/writes; output (including reasoning) is separate. */
export function normalizedInputTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const counters = usage as Record<string, unknown>;
  const keys = ['input', 'cacheRead', 'cacheWrite', 'output', 'totalTokens'] as const;
  if (!keys.every(key => Number.isSafeInteger(counters[key]) && (counters[key] as number) >= 0)) return undefined;
  const input = (counters.input as number) + (counters.cacheRead as number) + (counters.cacheWrite as number);
  if (!Number.isSafeInteger(input) || input <= 0 || input + (counters.output as number) !== counters.totalTokens) return undefined;
  return input;
}

export class ContextTokenEstimator {
  private samples: { footprint: ContextFootprint; inputTokens: number }[] = [];
  constructor(readonly key: string) {}

  learn(metadata: unknown, usage: unknown): boolean {
    const inputTokens = normalizedInputTokens(usage);
    if (!validContextCalibration(metadata) || metadata.key !== this.key || inputTokens === undefined) return false;
    this.samples.push({ footprint: structuredClone(metadata.footprint), inputTokens });
    this.samples = this.samples.slice(-8);
    return true;
  }

  metadata(payload: unknown): ContextCalibration | undefined {
    const footprint = contextFootprint(payload);
    return footprint ? { version: VERSION, key: this.key, footprint } : undefined;
  }

  estimate(payload: unknown): CalibratedInput | undefined {
    const current = contextFootprint(payload);
    if (!current) return undefined;
    const blocks = new Map(current.blocks.map(block => [`${block.hash}:${block.bytes}`, block]));
    for (const sample of this.samples.toReversed()) {
      const remaining = [...(current.imageIds ?? [])];
      let missingImage = false;
      for (const id of sample.footprint.imageIds ?? []) {
        const index = remaining.indexOf(id);
        if (index < 0) { missingImage = true; break; }
        remaining.splice(index, 1);
      }
      if (missingImage) continue;
      let retainedBytes = 0;
      for (const block of sample.footprint.blocks) {
        retainedBytes += block.bytes * Math.min(block.count, blocks.get(`${block.hash}:${block.bytes}`)?.count ?? 0);
      }
      // Shrinking/summary replacement does not justify proportional token discounts.
      if (retainedBytes < sample.footprint.bytes * 0.9) continue;
      const newBytes = current.bytes - retainedBytes;
      // Keep the full observed input even when some old blocks were removed.
      // New bytes receive no learned density discount. Reserve separators and token
      // boundaries even when a large number of tiny messages is appended/reordered.
      const inputTokens = sample.inputTokens + newBytes + remaining.length * IMAGE_TOKENS + 64 + current.blocks.reduce((sum, block) => sum + block.count * 2, 0);
      return {
        inputTokens, calibration: { sampleInputTokens: sample.inputTokens, retainedBytes, newBytes },
      };
    }
    return undefined;
  }
}
