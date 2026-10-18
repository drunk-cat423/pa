import type { StoredImage } from './image-assets.js';

export interface MessageImage extends StoredImage {
  quoted?: boolean;
  sourceSenderId?: string;
  referenceHash?: string;
}
export type ImageContent = { type: 'text'; text: string } | { type: 'file'; file_id: string; bytes?: number };
export interface ImageProjection { text: string; content: ImageContent[] }
export const IMAGE_TOKENS = 1024;
export const MAX_REQUEST_IMAGES = 600;
export const MAX_REQUEST_IMAGE_BYTES = 200 * 1024 * 1024;

export function imageRequestFits(payload: unknown, projections: readonly ImageProjection[]): boolean {
  const sizes = new Map(projections.flatMap(item => item.content.filter(block => block.type === 'file').map(block => [block.file_id,block.bytes ?? 0] as const)));
  const { imageIds } = imageTokenPayload(payload);
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
    const content = projection?.content.map(block => block.type === 'file' ? { type: 'file' as const, file_id: block.file_id } : block);
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
    return value;
  }));
  return { text, imageIds };
}

export function imageMetadata(image: MessageImage) {
  const { fileId: _fileId, ...metadata } = image;
  return metadata;
}
