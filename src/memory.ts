import { join } from 'node:path';
import { acquireConversationLock } from './conversation-lock.js';
import { MemoryError, type MemoryChange, type MemoryInput, type MemoryRecord } from './memory-types.js';
import { ConversationStore } from './store.js';

export interface MemorySession {
  remember(input: MemoryInput): MemoryChange;
  query(query?: string, limit?: number): MemoryRecord[];
  correct(id: string, input: MemoryInput, expectedRevision?: number): MemoryChange;
  close(): Promise<void>;
}

// This path only opens the business database. It never creates a model runtime.
export async function openMemory(dataDir: string, conversationKey: string): Promise<MemorySession> {
  const lock = await acquireConversationLock(dataDir, conversationKey);
  let store: ConversationStore | undefined;
  try {
    const openedStore = new ConversationStore(join(dataDir, 'pa.sqlite'));
    store = openedStore;
    const conversation = openedStore.ensureConversation(conversationKey, join(lock.directory, 'session.jsonl'));
    let closed = false;
    let broken = false;
    let closePromise: Promise<void> | undefined;
    function operate<T>(operation: () => T): T {
      if (closed) throw new Error('记忆会话已关闭。');
      if (broken) throw new Error('记忆持久化已失败，请关闭并重新打开会话。');
      try { return operation(); } catch (error) {
        if (error instanceof MemoryError) throw error;
        broken = true;
        throw new Error('记忆持久化失败，请关闭并重新打开会话。', { cause: error });
      }
    }
    return {
      remember: (input) => operate(() => openedStore.rememberMemory(conversation.id, input)),
      query: (query, limit) => operate(() => openedStore.queryMemories(conversation.id, query, limit)),
      correct: (id, input, revision) => operate(() => openedStore.correctMemory(conversation.id, id, input, revision)),
      close() {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = (async () => {
          try { openedStore.close(); } finally { await lock.release(); }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    try { store?.close(); } finally { await lock.release(); }
    throw error;
  }
}
