import { createHash } from 'node:crypto';
import { imageTokenPayload, IMAGE_TOKENS, MAX_REQUEST_IMAGES } from './image-context.js';

// Keep the scope key stable so existing successful measurements remain discoverable.
const KEY_VERSION = 1;
const VERSION = 2;
const CHUNK_BYTES = 8192;
const LEGACY_MAX_BLOCKS = 2048;
const MAX_BLOCKS = 32768;
const MAX_PARTS = 131072;
const MAX_EMBEDDED_LINES = 8192;
const MAX_EMBEDDED_DEPTH = 64;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export interface ContextFootprint {
  bytes: number;
  blocks: { hash: string; bytes: number; count: number }[];
  imageIds?: string[];
}
export interface ContextCalibration {
  version: 1 | 2;
  key: string;
  footprint: ContextFootprint;
}
export interface CalibratedInput {
  inputTokens: number;
  calibration: { sampleInputTokens: number; retainedBytes: number; newBytes: number };
}

/** No endpoint, credentials, scope identifiers or message text are persisted. */
export function contextCalibrationKey(provider: string, model: string, api: string, baseUrl: string, scope: string): string {
  return hash(JSON.stringify([KEY_VERSION, provider, model, api, baseUrl, scope]));
}

/** Fingerprint an exact partition of the serialized wire bytes, never normalized text. */
export function contextFootprint(payload: unknown, version: 1 | 2 = VERSION): ContextFootprint | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const visual = imageTokenPayload(payload);
  if (visual.imageIds.length > MAX_REQUEST_IMAGES) return undefined;
  const { messages, ...envelope } = visual.text as Record<string, unknown>;
  if (!Array.isArray(messages)) return undefined;
  const blocks = new Map<string, { hash: string; bytes: number; count: number }>();
  let bytes = 0, count = 0, invalid = false;
  const add = (value: string) => {
    const data = Buffer.from(value, 'utf8');
    for (let offset = 0; offset < data.length && !invalid; offset += CHUNK_BYTES) {
      if (++count > (version === 1 ? LEGACY_MAX_BLOCKS : MAX_PARTS)) { invalid = true; break; }
      const chunk = data.subarray(offset, offset + CHUNK_BYTES);
      const digest = hash(chunk);
      const key = `${digest}:${chunk.length}`;
      const previous = blocks.get(key);
      if (previous) previous.count++;
      else blocks.set(key, { hash: digest, bytes: chunk.length, count: 1 });
      if (blocks.size > (version === 1 ? LEGACY_MAX_BLOCKS : MAX_BLOCKS)) invalid = true;
    }
  };
  const escaped = (value: string) => JSON.stringify(value).slice(1, -1);
  // Strings can themselves hold JSON/JSONL history (including inside content[].text).
  // Parse only to locate boundaries; retain original spelling, whitespace and every
  // layer of escaping. Property additions cannot shift unrelated field fingerprints.
  const splitJson = (source: string, encode: (value: string) => string, depth: number) => {
    // A repeated-alternation regex can overflow V8's regexp stack near 16 MiB.
    const quoted = (start: number) => {
      let end = start;
      while ((end = source.indexOf('"', end + 1)) >= 0) {
        let slashes = 0;
        for (let cursor = end - 1; source[cursor] === '\\'; cursor--) slashes++;
        if (slashes % 2 === 0) return source.slice(start, end + 1);
      }
      throw new Error('Invalid serialized context string.');
    };
    let offset = 0;
    const stringPart = (token: string) => {
      const decoded: unknown = JSON.parse(token);
      // Nested JSON may spell characters as \uXXXX or \/. Re-escaping those
      // spellings would change the byte partition, so keep that token intact.
      if (typeof decoded === 'string' && token === JSON.stringify(decoded) && depth < 8) {
        const lines = embedded(decoded);
        if (lines) {
          add(encode('"'));
          for (const line of lines) {
            if (line.json) splitJson(line.text, value => encode(escaped(value)), depth + 1);
            else add(encode(escaped(line.text)));
          }
          add(encode('"'));
          return;
        }
      }
      add(encode(token));
    };
    while (offset < source.length && !invalid) {
      if (source[offset] === '"') {
        const token = quoted(offset);
        offset += token.length;
        const tail = /^\s*:\s*/.exec(source.slice(offset));
        if (tail) {
          const prefix = token + tail[0];
          offset += tail[0].length;
          add(encode(prefix));
          if (source[offset] === '"') {
            const value = quoted(offset);
            offset += value.length;
            stringPart(value);
          } else {
            const value = /^[^\s,\[\]{}]+/.exec(source.slice(offset))?.[0] ?? source[offset]!;
            add(encode(value));
            offset += value.length;
          }
        } else stringPart(token);
      } else {
        const token = /^(?:\s+|[^"\s,\[\]{}]+|[\s\S])/.exec(source.slice(offset))![0];
        add(encode(token));
        offset += token.length;
      }
    }
  };
  function embedded(text: string): { text: string; json: boolean }[] | undefined {
    const isJson = (value: string) => {
      if (!/^[\s]*[\[{]/.test(value)) return false;
      // JSON.parse builds the entire candidate before the fingerprint budget
      // can stop it. Bound structure first without allocating an object tree.
      let depth = 0, nodes = 0, quoted = false;
      const limit = MAX_PARTS - count;
      for (let index = 0; index < value.length; index++) {
        const char = value[index];
        if (quoted) {
          if (char === '\\') index++;
          else if (char === '"') quoted = false;
        } else if (char === '"') {
          quoted = true;
          nodes++;
        } else if (char === '[' || char === '{') {
          if (++depth > MAX_EMBEDDED_DEPTH) return false;
          nodes++;
        } else if (char === ']' || char === '}') {
          if (--depth < 0) return false;
        } else if (char === ',' || char === ':') nodes++;
        if (nodes > limit) return false;
      }
      if (quoted || depth !== 0) return false;
      try { JSON.parse(value); return true; } catch { return false; }
    };
    if (isJson(text)) return [{ text, json: true }];
    if (!text.includes('\n')) return undefined;
    const lines: { text: string; json: boolean }[] = [];
    const limit = Math.min(MAX_EMBEDDED_LINES, MAX_PARTS - count);
    let hasJson = false;
    for (let start = 0; start < text.length;) {
      // Decide before materializing another line. If splitting exceeds the
      // budget, stringPart fingerprints the complete original token instead.
      if (lines.length >= limit) return undefined;
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline + 1;
      const line = text.slice(start, end);
      const json = isJson(line);
      lines.push({ text: line, json });
      hasJson ||= json;
      start = end;
    }
    return hasJson ? lines : undefined;
  }
  for (const part of version === 1 ? [envelope, ...messages] : [visual.text]) {
    const serialized = JSON.stringify(part);
    bytes += Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_BYTES) return undefined;
    if (version === 1) add(serialized);
    else splitJson(serialized, value => value, 0);
    if (invalid) return undefined;
  }
  const footprint = { bytes, blocks: [...blocks.values()], ...(visual.imageIds.length ? { imageIds: visual.imageIds.map(hash) } : {}) };
  return JSON.stringify(footprint).length <= MAX_METADATA_BYTES - 256 ? footprint : undefined;
}

export function validContextCalibration(value: unknown): value is ContextCalibration {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as ContextCalibration;
  if (Object.keys(metadata).some(key => !['version', 'key', 'footprint'].includes(key))) return false;
  if (![1, VERSION].includes(metadata.version) || typeof metadata.key !== 'string' || !HASH.test(metadata.key)) return false;
  const maxBlocks = metadata.version === 1 ? LEGACY_MAX_BLOCKS : MAX_BLOCKS;
  const maxParts = metadata.version === 1 ? LEGACY_MAX_BLOCKS : MAX_PARTS;
  const fp = metadata.footprint;
  if (!fp || !Number.isSafeInteger(fp.bytes) || fp.bytes <= 0 || fp.bytes > MAX_BYTES
    || !Array.isArray(fp.blocks) || !fp.blocks.length || fp.blocks.length > maxBlocks) return false;
  if (Object.keys(fp).some(key => !['bytes', 'blocks', 'imageIds'].includes(key))) return false;
  if (fp.imageIds !== undefined && (!Array.isArray(fp.imageIds) || fp.imageIds.length > MAX_REQUEST_IMAGES
    || fp.imageIds.some(id => typeof id !== 'string' || !HASH.test(id)))) return false;
  let bytes = 0, count = 0;
  const seen = new Set<string>();
  for (const block of fp.blocks) {
    if (!block || typeof block.hash !== 'string' || !HASH.test(block.hash)
      || !Number.isSafeInteger(block.bytes) || block.bytes <= 0 || block.bytes > CHUNK_BYTES
      || !Number.isSafeInteger(block.count) || block.count <= 0 || block.count > maxParts) return false;
    if (Object.keys(block).some(key => !['hash', 'bytes', 'count'].includes(key))) return false;
    const key = `${block.hash}:${block.bytes}`;
    if (seen.has(key)) return false;
    seen.add(key);
    bytes += block.bytes * block.count;
    count += block.count;
  }
  return bytes === fp.bytes && count <= maxParts && JSON.stringify(metadata).length <= MAX_METADATA_BYTES;
}

/** Upgrade only when the complete saved request reproduces its original hashes. */
export function upgradeContextCalibration(metadata: unknown, payload: unknown): ContextCalibration | undefined {
  if (!validContextCalibration(metadata)) return undefined;
  const actual = contextFootprint(payload, metadata.version);
  const expected = metadata.footprint;
  if (!actual || actual.bytes !== expected.bytes || actual.blocks.length !== expected.blocks.length) return undefined;
  const blocks = new Map(actual.blocks.map(block => [`${block.hash}:${block.bytes}`, block.count]));
  if (expected.blocks.some(block => blocks.get(`${block.hash}:${block.bytes}`) !== block.count)) return undefined;
  const images = [...(actual.imageIds ?? [])].sort();
  if (JSON.stringify(images) !== JSON.stringify([...(expected.imageIds ?? [])].sort())) return undefined;
  const footprint = metadata.version === VERSION ? actual : contextFootprint(payload);
  return footprint ? { version: VERSION, key: metadata.key, footprint } : undefined;
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
  private samples: { version: 1 | 2; footprint: ContextFootprint; inputTokens: number }[] = [];
  constructor(readonly key: string) {}

  learn(metadata: unknown, usage: unknown): boolean {
    const inputTokens = normalizedInputTokens(usage);
    if (!validContextCalibration(metadata) || metadata.key !== this.key || inputTokens === undefined) return false;
    this.samples.push({ version: metadata.version, footprint: structuredClone(metadata.footprint), inputTokens });
    this.samples = this.samples.slice(-8);
    return true;
  }

  metadata(payload: unknown): ContextCalibration | undefined {
    const footprint = contextFootprint(payload);
    return footprint ? { version: VERSION, key: this.key, footprint } : undefined;
  }

  estimate(payload: unknown): CalibratedInput | undefined {
    const footprints = new Map<1 | 2, ContextFootprint | undefined>();
    for (const sample of this.samples.toReversed()) {
      if (!footprints.has(sample.version)) footprints.set(sample.version, contextFootprint(payload, sample.version));
      const current = footprints.get(sample.version);
      if (!current) continue;
      const blocks = new Map(current.blocks.map(block => [`${block.hash}:${block.bytes}`, block]));
      const remaining = [...(current.imageIds ?? [])];
      let missingImage = false;
      for (const id of sample.footprint.imageIds ?? []) {
        const index = remaining.indexOf(id);
        if (index < 0) { missingImage = true; break; }
        remaining.splice(index, 1);
      }
      if (missingImage) continue;
      let retainedBytes = 0, retainedParts = 0;
      for (const block of sample.footprint.blocks) {
        const count = Math.min(block.count, blocks.get(`${block.hash}:${block.bytes}`)?.count ?? 0);
        retainedBytes += block.bytes * count;
        retainedParts += count;
      }
      // Shrinking/summary replacement does not justify proportional token discounts.
      if (retainedBytes < sample.footprint.bytes * 0.9) continue;
      const newBytes = current.bytes - retainedBytes;
      // Keep the full observed input even when some old blocks were removed.
      // New bytes receive no learned density discount. Reserve separators and token
      // boundaries even when a large number of tiny messages is appended/reordered.
      const newParts = current.blocks.reduce((sum, block) => sum + block.count, 0) - retainedParts;
      const inputTokens = sample.inputTokens + newBytes + remaining.length * IMAGE_TOKENS + 64 + newParts * 2;
      return {
        inputTokens, calibration: { sampleInputTokens: sample.inputTokens, retainedBytes, newBytes },
      };
    }
    return undefined;
  }
}
