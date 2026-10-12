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
}

export interface MemoryRef { id: string; revision: number }
export interface MemoryInput { content: string; kind?: MemoryKind; sourceMessageId?: string }
export interface MemoryChange { memory: MemoryRecord; contextResetRequired: boolean }
export interface MemoryDeletion { id: string; revision: number; deleted: boolean; contextResetRequired: boolean }

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryError';
  }
}
