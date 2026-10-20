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
export interface SharedFactAttributionInput {
  kind: 'statement' | 'correction';
  subjectSenderIds: string[];
  excludedSenderIds: string[];
  correctsMessageIds: string[];
}
export interface FactPerson {
  senderId: string;
  personId?: string;
  displayName?: string;
}
export interface SharedFactContext {
  id: string;
  revision: number;
  kind: MemoryKind;
  content: string;
  sourceMessageId: string | null;
  sourceSpeaker: FactPerson | null;
  sourceTime: string;
  attribution: 'statement' | 'correction';
  subjects: FactPerson[];
  excludedSubjects: FactPerson[];
  correctsMessageIds: string[];
}
export interface AttributionCorrection {
  memoryId: string;
  sourceMessageId: string;
  speakerSenderId: string;
  subjectSenderIds: string[];
  excludedSenderIds: string[];
  correctsMessageIds: string[];
}
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
