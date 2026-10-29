import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import type { PaConfig } from './config.js';
import { isBailianDeepSeek, supportsImageInput } from './model-capabilities.js';

export interface ImageSource { url: string; contentType?: string; width?: number; height?: number; size?: number }
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export interface StoredImage {
  imageId: string; fileId: string; mimeType: ImageMime; bytes: number;
  width?: number; height?: number; tokenEstimate: 1024;
}
export const IMAGE_MAX_BYTES = 32 * 1024 * 1024;
// A fixed limit also satisfies DeepSeek's lower per-side limit for >=15 images,
// so accumulating history never requires resizing an already-cached image.
export const IMAGE_MAX_SIDE = 4096;
const ID = /^[0-9a-f]{64}$/;
const FILE_ID = /^file-api-[A-Za-z0-9_-]{1,200}$/;
const HOSTS = new Set(['gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'qpic.cn']);
const pending = new Map<string, Promise<StoredImage>>();
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type ImageFailure = 'unsupported_model' | 'source' | 'download' | 'too_large' | 'format' | 'upload' | 'cancelled' | 'persistence';
const messages: Record<ImageFailure, string> = {
  unsupported_model: '当前模型尚未接通图片理解，请使用已支持的 DeepSeek Flash 配置。',
  source: '图片地址不是已验证的 QQ 附件地址。', download: '图片下载失败，请重新引用图片再试。',
  too_large: '图片超过大小或尺寸限制，请发送较小的图片。', format: '图片格式或文件内容无效，支持 JPEG、PNG、GIF 和 WebP。',
  upload: '图片提交给模型服务失败，本次未识别图片，请稍后重新提问。',
  cancelled: '图片处理已取消。', persistence: '图片持久化或读取失败，已停止使用不完整的图片记录。',
};
export class ImageAssetError extends Error {
  constructor(readonly code: ImageFailure) { super(messages[code]); this.name = 'ImageAssetError'; }
}
function fail(code: ImageFailure): never { throw new ImageAssetError(code); }

function inspectPath(path: string): void {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  const components = absolute.slice(cursor.length).split(sep).filter(Boolean);
  for (let index = 0; index < components.length; index++) {
    cursor = join(cursor, components[index]!);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory())) fail('persistence');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
function readPrivate(path: string, limit: number): Buffer {
  inspectPath(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) fail('persistence');
    const result = readFileSync(fd);
    if (result.length > limit) fail('persistence');
    return result;
  } finally { closeSync(fd); }
}
function immutableWrite(path: string, data: Buffer): void {
  inspectPath(path);
  if (existsSync(path)) {
    if (!readPrivate(path, Math.max(4096, IMAGE_MAX_BYTES)).equals(data)) fail('persistence');
    return;
  }
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !readPrivate(path, Math.max(4096, IMAGE_MAX_BYTES)).equals(data)) throw error;
    }
  } finally { unlinkSync(temp); }
}
function dimensions(data: Buffer): { mimeType: ImageMime; width: number; height: number } {
  let mimeType: ImageMime | undefined, width = 0, height = 0;
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.subarray(12, 16).toString() === 'IHDR') {
    mimeType = 'image/png'; width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (data.length >= 10 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) {
    mimeType = 'image/gif'; width = data.readUInt16LE(6); height = data.readUInt16LE(8);
  } else if (data.length > 4 && data[0] === 255 && data[1] === 216 && data[2] === 255) {
    mimeType = 'image/jpeg'; let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) break;
      while (offset < data.length && data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda || marker === undefined) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += size;
    }
  } else if (data.length >= 25 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') {
    mimeType = 'image/webp';
    const type = data.subarray(12, 16).toString();
    if (type === 'VP8X' && data.length >= 30) { width = data.readUIntLE(24, 3) + 1; height = data.readUIntLE(27, 3) + 1; }
    else if (type === 'VP8L' && data[20] === 0x2f) {
      width = 1 + (data[21]! | ((data[22]! & 0x3f) << 8));
      height = 1 + ((data[22]! >> 6) | (data[23]! << 2) | ((data[24]! & 0x0f) << 10));
    } else if (type === 'VP8 ' && data.length >= 30 && data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff;
    }
  }
  if (!mimeType || !width || !height) fail('format');
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) fail('too_large');
  return { mimeType, width, height };
}
function sourceUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) fail('source');
  let url: URL; try { url = new URL(value.startsWith('//') ? `https:${value}` : value); } catch { return fail('source'); }
  if (!['http:', 'https:'].includes(url.protocol) || !HOSTS.has(url.hostname) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port)) || url.hash) fail('source');
  return url;
}
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await response.body?.cancel(); fail('too_large'); }
  if (!response.body) fail('download');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) fail('too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** Content-addressed local originals and stable provider handles. Callers enforce room access. */
export class ImageAssets {
  private readonly root: string;
  private readonly providerKey: string;
  private readonly uploadUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly config: PaConfig, dependencies: { fetch?: typeof fetch } = {}) {
    this.root = resolve(config.dataDir, 'images');
    const base = (config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.uploadUrl = `${base}/files`;
    this.providerKey = digest(JSON.stringify([config.provider, base, config.apiKey]));
    this.fetchImpl = dependencies.fetch ?? fetch;
  }
  private supported(): void {
    if (!supportsImageInput(this.config)) fail('unsupported_model');
  }
  private persist<T>(operation: () => T): T {
    try { return operation(); } catch (error) { if (error instanceof ImageAssetError) throw error; return fail('persistence'); }
  }
  private initialize(): void {
    this.persist(() => { inspectPath(this.root); mkdirSync(this.root, { recursive: true, mode: 0o700 }); inspectPath(this.root); chmodSync(this.root, 0o700); });
  }
  private metadataPath(imageId: string): string { return join(this.root, `${imageId}.${this.providerKey}.json`); }
  get(imageId: string): StoredImage | undefined {
    this.supported();
    if (!ID.test(imageId)) fail('persistence');
    return this.persist(() => {
      // Bailian's Files API does not supply DeepSeek vision handles. Derive a
      // stable local reference from the original, including images saved before
      // the provider switch; never send the previous provider's file_id.
      if (isBailianDeepSeek(this.config)) {
        return this.readOriginal(imageId)?.image;
      }
      const path = this.metadataPath(imageId); inspectPath(path);
      if (!existsSync(path)) return undefined;
      const image = JSON.parse(readPrivate(path, 4096).toString('utf8')) as StoredImage;
      if (!image || Object.keys(image).some(key => !['imageId', 'fileId', 'mimeType', 'bytes', 'width', 'height', 'tokenEstimate'].includes(key))
        || image.imageId !== imageId || !FILE_ID.test(image.fileId) || image.tokenEstimate !== 1024
        || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mimeType)
        || !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > IMAGE_MAX_BYTES
        || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
        || image.width! <= 0 || image.height! <= 0 || image.width! > IMAGE_MAX_SIDE || image.height! > IMAGE_MAX_SIDE) fail('persistence');
      const local = join(this.root, `${imageId}.bin`); inspectPath(local);
      const stat = lstatSync(local);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== image.bytes) fail('persistence');
      return image;
    });
  }
  private readOriginal(imageId: string): { image: StoredImage; data: Buffer } | undefined {
    this.supported();
    if (!ID.test(imageId)) fail('persistence');
    return this.persist(() => {
      const local = join(this.root, `${imageId}.bin`);
      if (isBailianDeepSeek(this.config)) {
        inspectPath(local);
        if (!existsSync(local)) return undefined;
        const data = readPrivate(local, IMAGE_MAX_BYTES);
        if (digest(data) !== imageId) fail('persistence');
        return { image: { imageId, fileId: `local-${imageId}`, ...dimensions(data), bytes: data.length, tokenEstimate: 1024 }, data };
      }
      const image = this.get(imageId);
      if (!image) return undefined;
      const data = readPrivate(local, IMAGE_MAX_BYTES);
      if (data.length !== image.bytes || digest(data) !== imageId) fail('persistence');
      return { image, data };
    });
  }
  read(imageId: string): Buffer {
    const loaded = this.readOriginal(imageId);
    if (!loaded) fail('persistence');
    return loaded.data;
  }
  /** A construction-local verified snapshot; no original Buffer survives in a cache. */
  loadContent(imageId: string): { image: StoredImage; content: ReturnType<ImageAssets['content']> } | undefined {
    const loaded = this.readOriginal(imageId);
    if (!loaded) return undefined;
    return { image: loaded.image, content: this.projectContent(loaded.image, loaded.data) };
  }
  content(image: StoredImage): { type: 'file'; file_id: string; bytes: number }
    | { type: 'image_url'; image_url: { url: string }; bytes: number } {
    if (!isBailianDeepSeek(this.config)) return { type: 'file', file_id: image.fileId, bytes: image.bytes };
    // The input original remains stored up to 32 MiB. Wire limits belong to
    // the selected provider and must not silently discard or resize history.
    if (image.bytes > 10 * 1024 * 1024) fail('too_large');
    const data = this.read(image.imageId);
    return this.projectContent(image, data);
  }
  private projectContent(image: StoredImage, data: Buffer): ReturnType<ImageAssets['content']> {
    if (!isBailianDeepSeek(this.config)) return { type: 'file', file_id: image.fileId, bytes: image.bytes };
    if (image.bytes > 10 * 1024 * 1024) fail('too_large');
    return { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${data.toString('base64')}` }, bytes: data.length };
  }
  async prepare(source: ImageSource, signal?: AbortSignal): Promise<StoredImage> {
    this.supported();
    const url = sourceUrl(source?.url);
    if (signal?.aborted) fail('cancelled');
    const key = `${this.root}:${this.providerKey}:url:${digest(url.href)}`;
    const existing = pending.get(key); if (existing) return existing;
    const operation = this.downloadAndUpload(url, signal);
    pending.set(key, operation);
    try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  private async downloadAndUpload(url: URL, signal?: AbortSignal): Promise<StoredImage> {
    const downloadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
    let data: Buffer;
    try {
      const response = await this.fetchImpl(url, { redirect: 'error', headers: { Accept: 'image/*' }, signal: downloadSignal });
      if (response.status !== 200) { await response.body?.cancel(); fail('download'); }
      data = await boundedBody(response, IMAGE_MAX_BYTES);
    } catch (error) {
      if (signal?.aborted) return fail('cancelled');
      if (error instanceof ImageAssetError) throw error;
      return fail('download');
    }
    const info = dimensions(data), imageId = digest(data);
    this.initialize();
    this.persist(() => immutableWrite(join(this.root, `${imageId}.bin`), data));
    if (isBailianDeepSeek(this.config) && data.length > 10 * 1024 * 1024) fail('too_large');
    const saved = this.get(imageId); if (saved) return saved;
    const key = `${this.root}:${this.providerKey}:asset:${imageId}`;
    const existing = pending.get(key); if (existing) return existing;
    const operation = this.upload(imageId, info, data, signal);
    pending.set(key, operation);
    try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  private async upload(imageId: string, info: { mimeType: ImageMime; width: number; height: number }, data: Buffer, signal?: AbortSignal): Promise<StoredImage> {
    if (signal?.aborted) fail('cancelled');
    const body = new FormData();
    body.append('purpose', 'user_data');
    body.append('file', new Blob([new Uint8Array(data)], { type: info.mimeType }), `${imageId}.${info.mimeType.split('/')[1]}`);
    const uploadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    let fileId: string;
    try {
      const response = await this.fetchImpl(this.uploadUrl, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.config.apiKey}` }, body, signal: uploadSignal });
      if (response.status < 200 || response.status >= 300) { await response.body?.cancel(); fail('upload'); }
      const result = JSON.parse((await boundedBody(response, 64 * 1024)).toString('utf8')) as { id?: unknown };
      if (!result || typeof result.id !== 'string' || !FILE_ID.test(result.id)) fail('upload');
      fileId = result.id;
    } catch (error) {
      if (signal?.aborted) return fail('cancelled');
      if (error instanceof ImageAssetError && error.code === 'upload') throw error;
      return fail('upload');
    }
    const image: StoredImage = { imageId, fileId, ...info, bytes: data.length, tokenEstimate: 1024 };
    this.persist(() => immutableWrite(this.metadataPath(imageId), Buffer.from(JSON.stringify(image))));
    return image;
  }
}
