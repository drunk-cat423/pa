import type { ChannelRoute } from './channel-types.js';

export type MemoryKind = 'fact' | 'preference' | 'episode';

export interface MemoryRecord {
  id: string;
  conversationId: string;
  kind: MemoryKind;
  content: string;
  revision: number;
  origin: 'explicit_user';
  sourceEventId: string;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  subjectActorId?: string;
  writerActorId?: string;
  /** Historical metadata retained when reading migrated rows. */
  profileField?: string;
  scope?: 'legacy' | 'room' | 'actor';
  readonly personId?: string;
  occurredAt?: string | null;
  expiresAt?: string | null;
}

export interface PrimaryPerson { id: string; bindings: { route: ChannelRoute; senderId: string }[] }
export interface MemoryRef { id: string; revision: number }
export interface MemoryInput {
  content: string; kind?: MemoryKind; sourceMessageId?: string;
  occurredAt?: string | null; expiresAt?: string | null;
}
export interface MemoryChange { memory: MemoryRecord; contextResetRequired: boolean }

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryError';
  }
}
