import { createHash } from 'node:crypto';
import type { ImageAssets, StoredImage } from './image-assets.js';
import { isBailianDeepSeek } from './model-capabilities.js';

export interface MessageImage extends StoredImage {
  quoted?: boolean;
  sourceSenderId?: string;
  referenceHash?: string;
}
export type ImageContent = { type: 'text'; text: string } | { type: 'file'; file_id: string; bytes?: number }
  | { type: 'image_url'; image_url: { url: string }; bytes?: number };
export interface ImageProjection {
  text: string; content: ImageContent[];
  /** Trusted original metadata, kept off the provider wire for pre-load budgets. */
  sourceImages?: readonly Pick<MessageImage, 'imageId' | 'bytes'>[];
}
export const IMAGE_TOKENS = 1024;
export const MAX_REQUEST_IMAGES = 600;
export const MAX_REQUEST_IMAGE_BYTES = 200 * 1024 * 1024;
export const BAILIAN_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
export const IMAGE_MAX_PROVIDER_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_PLATFORM_BYTES = 32 * 1024 * 1024;
export interface ImageMetadataPreflightOptions {
  provider?: { provider: string; model: string };
  /** Known non-image serialized request bytes before originals are loaded. */
  knownRequestBytes?: number;
  /** Allowance for JSON/provider framing and metadata not included above. */
  requestHeadroomBytes?: number;
}
export interface ImageMetadataPreflight {
  fits: boolean;
  reason?: 'invalid_metadata' | 'too_many_images' | 'image_too_large' | 'total_image_bytes' | 'request_bytes';
  imageCount: number;
  originalBytes: number;
  estimatedBase64Bytes: number;
  estimatedRequestBytes: number;
}
const imageIdentity = (block: Exclude<ImageContent, { type: 'text' }>) => block.type === 'file' ? block.file_id
  : `data-${createHash('sha256').update(block.image_url.url).digest('hex')}`;

/** Reject obviously oversized current-turn images using metadata, before reading originals. */
export function preflightImageMetadata(images: readonly Pick<MessageImage, 'imageId' | 'bytes'>[], options: ImageMetadataPreflightOptions = {}): ImageMetadataPreflight {
  const byId = new Map<string, number>();
  for (const image of images) {
    if (typeof image.imageId !== 'string' || !image.imageId || !Number.isSafeInteger(image.bytes) || image.bytes <= 0)
      return { fits: false, reason: 'invalid_metadata', imageCount: byId.size, originalBytes: 0, estimatedBase64Bytes: 0, estimatedRequestBytes: 0 };
    const old = byId.get(image.imageId);
    if (old !== undefined && old !== image.bytes)
      return { fits: false, reason: 'invalid_metadata', imageCount: byId.size, originalBytes: 0, estimatedBase64Bytes: 0, estimatedRequestBytes: 0 };
    byId.set(image.imageId, image.bytes);
  }
  const imageCount = byId.size, originalBytes = [...byId.values()].reduce((sum, bytes) => sum + bytes, 0);
  const estimatedBase64Bytes = [...byId.values()].reduce((sum, bytes) => sum + Math.ceil(bytes / 3) * 4, 0);
  const knownRequestBytes = options.knownRequestBytes ?? 0, requestHeadroomBytes = options.requestHeadroomBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(knownRequestBytes) || knownRequestBytes < 0 || !Number.isSafeInteger(requestHeadroomBytes) || requestHeadroomBytes < 0)
    return { fits: false, reason: 'invalid_metadata', imageCount, originalBytes, estimatedBase64Bytes, estimatedRequestBytes: 0 };
  const estimatedRequestBytes = knownRequestBytes + estimatedBase64Bytes + requestHeadroomBytes;
  let reason: ImageMetadataPreflight['reason'];
  if (imageCount > MAX_REQUEST_IMAGES) reason = 'too_many_images';
  else if ([...byId.values()].some(bytes => bytes > (options.provider && isBailianDeepSeek(options.provider)
    ? IMAGE_MAX_PROVIDER_BYTES : IMAGE_MAX_PLATFORM_BYTES))) reason = 'image_too_large';
  else if (originalBytes > MAX_REQUEST_IMAGE_BYTES) reason = 'total_image_bytes';
  else if (options.provider && isBailianDeepSeek(options.provider) && estimatedRequestBytes > BAILIAN_MAX_REQUEST_BYTES) reason = 'request_bytes';
  return { fits: reason === undefined, ...(reason ? { reason } : {}), imageCount, originalBytes, estimatedBase64Bytes, estimatedRequestBytes };
}

export function imageContent(assets: ImageAssets, image: MessageImage): ImageContent { return assets.content(image); }

export function imageRequestFits(payload: unknown, projections: readonly ImageProjection[]): boolean {
  const sizes = new Map(projections.flatMap(item => item.content.filter(block => block.type !== 'text').map(block => [imageIdentity(block),block.bytes ?? 0] as const)));
  const { imageIds } = imageTokenPayload(payload);
  if (imageIds.some(id=>id.startsWith('data-')) && Buffer.byteLength(JSON.stringify(payload),'utf8') > BAILIAN_MAX_REQUEST_BYTES) return false;
  return imageIds.length <= MAX_REQUEST_IMAGES && imageIds.every(id=>Number.isSafeInteger(sizes.get(id)) && sizes.get(id)! > 0)
    && imageIds.reduce((sum,id)=>sum+sizes.get(id)!,0) <= MAX_REQUEST_IMAGE_BYTES;
}

/** Only harness-owned projections can add provider files; user text is never parsed as a file reference. */
export function projectImagePayload(payload: unknown, projections: readonly ImageProjection[]): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const object = payload as Record<string, unknown>;
  if (!Array.isArray(object.messages)) return payload;
  const messages: Record<string, unknown>[] = [];
  let pendingToolImages: ImageContent[] = [];
  const flush = () => { if (pendingToolImages.length) messages.push({ role: 'user', content: pendingToolImages }); pendingToolImages = []; };
  for (const message of object.messages as Record<string, unknown>[]) {
    if (message.role !== 'tool') flush();
    if (message.role !== 'user' && message.role !== 'tool') { messages.push(message); continue; }
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      && message.content.every(block => block.type === 'text') ? message.content.map(block => block.text).join('') : undefined;
    const projection = projections.find(item => item.text === text);
    const content = projection?.content.map(block => block.type === 'file' ? { type: 'file' as const, file_id: block.file_id }
      : block.type === 'image_url' ? { type: 'image_url' as const, image_url: block.image_url } : block);
    if (content && message.role === 'tool') { messages.push(message); pendingToolImages.push(...content); }
    else messages.push(content ? { ...message, content } : message);
  }
  flush();
  return { ...object, messages };
}

/** Visual bytes/file-id lengths are not image token estimates. */
export function imageTokenPayload(payload: unknown): { text: unknown; imageIds: string[] } {
  const imageIds: string[] = [];
  const text = JSON.parse(JSON.stringify(payload, (_key, value) => {
    if (value && typeof value === 'object' && value.type === 'file' && typeof value.file_id === 'string') {
      imageIds.push(value.file_id);
      return { type: 'file' };
    }
    if (value && typeof value === 'object' && value.type === 'image_url' && typeof value.image_url?.url === 'string') {
      imageIds.push(imageIdentity(value));
      return { type: 'image_url' };
    }
    return value;
  }));
  return { text, imageIds };
}

export function imageMetadata(image: MessageImage) {
  const { fileId: _fileId, ...metadata } = image;
  return metadata;
}
