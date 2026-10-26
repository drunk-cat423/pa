import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readRecordedTurns, type RecordedTurn } from './transcript.js';
import { SessionIntegrityStore, type SessionCheckpoint } from './session-integrity-store.js';

export class SessionIntegrityError extends Error {
  constructor(message: string, readonly conversationId: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionIntegrityError';
  }
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const changed = '会话在核对期间发生变化，请稍后重新核对。';

export class SessionIntegrity {
  constructor(private readonly store: SessionIntegrityStore, private readonly conversationId: string,
    private readonly conversationKey: string, private readonly canonicalFile: string) {}

  assertHealthy(): void {
    const problem = this.store.problem(this.conversationId);
    if (problem) throw new SessionIntegrityError(problem.error ?? '任务会话核对失败。',this.conversationId);
  }

  private reject(entry: SessionCheckpoint, message: string): never {
    if (!this.store.corrupt(entry,message)) throw new SessionIntegrityError(changed,this.conversationId);
    throw new SessionIntegrityError(message,this.conversationId);
  }

  // Read on-disk JSONL, never the runtime's in-memory branch. The strict reader rejects
  // invalid lines/IDs/parents; surrounding hashes detect a file changing during parsing.
  async read(entry: SessionCheckpoint): Promise<{ turns: RecordedTurn[]; hash: string }> {
    const directory = join(dirname(dirname(this.canonicalFile)),createHash('sha256')
      .update(`${this.conversationKey}:task:${entry.inputMessageId}`).digest('hex'));
    if (entry.file !== join(directory,'session.jsonl')) return this.reject(entry,'任务记录关联了不同的 Pi 会话路径。');
    let before: Buffer;
    let after: Buffer;
    let turns: RecordedTurn[];
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('会话目录越界或使用了符号链接。');
      try {
        const fileStat = await lstat(entry.file);
        if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) throw new Error('会话文件必须是无链接的普通文件。');
        before = await readFile(entry.file);
      }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        // An interrupted request may never have created JSONL. SQL validation below
        // still rejects missing transcripts for successful or already linked records.
        return { turns: [], hash: 'missing' };
      }
      turns = await readRecordedTurns(entry.file);
      after = await readFile(entry.file);
      if (hash(before) !== hash(after)) throw new Error(changed);
    } catch {
      return this.reject(entry,'任务 Pi 会话文件损坏、不可读或在核对期间变化。');
    }
    return { turns, hash: hash(after) };
  }

  async verify(entry: SessionCheckpoint): Promise<RecordedTurn[]> {
    // Keep SQLite errors outside the file-error conversion: they are globally fatal.
    const row = this.store.snapshot(entry);
    const recorded = await this.read(entry);
    const current = this.store.forFile(entry.file);
    if (!current || current.revision !== entry.revision) throw new SessionIntegrityError(changed,this.conversationId);
    if (!row || row.conversation_id !== entry.conversationId || row.pi_session_file !== entry.file
      || row.input_message_id !== entry.inputMessageId || row.user_id !== entry.inputMessageId
      || row.user_conversation !== entry.conversationId || row.user_role !== 'user') {
      return this.reject(entry,'任务 SQLite 关联已删除或发生不一致。');
    }
    const turns = recorded.turns.filter(turn => turn.runId === entry.runId);
    const turn = turns[0];
    if (recorded.turns.some(item => item.runId !== entry.runId) || turns.length > 1
      || (turn?.user && turn.user.text !== row.user_text)
      || (row.user_entry !== null && turn?.user?.entryId !== row.user_entry)) {
      return this.reject(entry,'SQLite 与 Pi 任务输入或运行标记不一致。');
    }
    if (row.status === 'completed' && (!turn?.user || !turn.assistant
      || !['stop','length'].includes(turn.assistant.stopReason)
      || row.user_entry !== turn.user.entryId || row.assistant_entry !== turn.assistant.entryId
      || row.assistant_role !== 'assistant' || row.assistant_conversation !== entry.conversationId
      || row.assistant_text !== turn.assistant.text)) {
      return this.reject(entry,'SQLite 与 Pi 已完成任务回复不一致。');
    }
    if (entry.hash !== null && entry.hash !== recorded.hash) return this.reject(entry,'已核对任务 Pi 会话文件的哈希发生变化。');
    if (row.status === 'running') return recorded.turns; // Recovery must finish SQL before checkpointing.
    const sqlHash=hash(Buffer.from(JSON.stringify(row)));
    if(entry.sqlHash!==null&&entry.sqlHash!==sqlHash) return this.reject(entry,'已核对任务 SQLite 关联内容发生变化。');
    if (!this.store.verified(entry,recorded.hash,sqlHash)) throw new SessionIntegrityError(changed,this.conversationId);
    return recorded.turns;
  }

  async dirty(excluded: ReadonlySet<string> = new Set()): Promise<void> {
    this.assertHealthy();
    let after = 0;
    for (;;) {
      const page = this.store.pending(this.conversationId,after);
      if (!page.length) return;
      for (const entry of page) {
        after = entry.id;
        if (!excluded.has(entry.file)) await this.verify(entry);
      }
    }
  }

  // Full maintenance is explicit; normal sweeps retain a durable keyset cursor and
  // touch at most `limit` files. No stat/read of verified history occurs at startup.
  async audit(options: { full?: boolean; limit?: number; recheckCorrupt?: boolean } = {}, excluded: ReadonlySet<string> = new Set()): Promise<number> {
    // Explicit local maintenance: restored bytes/SQL must still match original
    // checkpoints. Chat and automatic sweeps never set this flag.
    if (!options.recheckCorrupt) this.assertHealthy();
    const limit = options.limit ?? 1;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new Error('核对分页大小必须为1至1024。');
    let after = options.full || options.recheckCorrupt ? 0 : this.store.sweepCursor(this.conversationId);
    let count = 0;
    for (;;) {
      const page = this.store.page(this.conversationId,after,options.full ? 64 : limit);
      if (!page.length) { this.store.advanceSweep(this.conversationId,0); return count; }
      for (const entry of page) {
        if (!excluded.has(entry.file)) { await this.verify(entry); count++; }
        after = entry.id;
        this.store.advanceSweep(this.conversationId,after);
      }
      if (!options.full) return count;
    }
  }
}
