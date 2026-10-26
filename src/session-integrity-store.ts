import type { DatabaseSync } from 'node:sqlite';

export type SessionCheckpoint = {
  id: number; conversationId: string; file: string; runId: string; inputMessageId: string;
  status: 'dirty' | 'verified' | 'corrupt'; revision: number; verifiedRevision: number | null;
  hash: string | null; sqlHash: string | null; error: string | null;
};

const register = (prefix: 'OLD' | 'NEW') => `
  INSERT INTO session_integrity(conversation_id,file,run_id,input_message_id,status,revision,changed_at)
  SELECT ${prefix}.conversation_id,${prefix}.pi_session_file,${prefix}.id,${prefix}.input_message_id,'dirty',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE ${prefix}.pi_session_file IS NOT NULL
  ON CONFLICT(file) DO UPDATE SET revision=revision+1,
    status=CASE WHEN status='corrupt' THEN status ELSE 'dirty' END,changed_at=excluded.changed_at;
  DELETE FROM session_integrity_canonical_messages WHERE message_id IN (${prefix}.input_message_id,${prefix}.response_message_id)
    AND ${prefix}.pi_session_file IS NOT NULL;`;

// Export exact DDL so offline maintenance can verify this known, ledger-only side effect.
export const SESSION_INTEGRITY_TRIGGER_SQL = [
  `CREATE TRIGGER session_integrity_runs_insert AFTER INSERT ON agent_runs BEGIN ${register('NEW')} END`,
  `CREATE TRIGGER session_integrity_runs_update AFTER UPDATE ON agent_runs BEGIN ${register('OLD')} ${register('NEW')} END`,
  `CREATE TRIGGER session_integrity_runs_delete BEFORE DELETE ON agent_runs BEGIN ${register('OLD')} END`,
  ...(['INSERT', 'UPDATE', 'DELETE'] as const).map(event => {
    const ids = event === 'INSERT' ? 'NEW.id' : event === 'DELETE' ? 'OLD.id' : 'OLD.id,NEW.id';
    return `CREATE TRIGGER session_integrity_messages_${event.toLowerCase()} AFTER ${event} ON messages BEGIN
      ${event !== 'INSERT' ? 'DELETE FROM session_integrity_canonical_messages WHERE message_id=OLD.id;' : ''}
      ${event !== 'DELETE' ? `INSERT INTO session_integrity_canonical_messages(message_id,conversation_id,message_rowid)
        SELECT NEW.id,NEW.conversation_id,NEW.rowid WHERE NEW.pi_entry_id IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM agent_runs WHERE pi_session_file IS NOT NULL AND (input_message_id=NEW.id OR response_message_id=NEW.id))
        ON CONFLICT(message_id) DO UPDATE SET conversation_id=excluded.conversation_id,message_rowid=excluded.message_rowid;` : ''}
      UPDATE session_integrity SET revision=revision+1,status=CASE WHEN status='corrupt' THEN status ELSE 'dirty' END,
        changed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE file IN
        (SELECT pi_session_file FROM agent_runs WHERE input_message_id IN (${ids}) OR response_message_id IN (${ids})); END`;
  }),
];

export function migrateSessionIntegrity(db: DatabaseSync): void {
  db.exec(`CREATE TABLE session_integrity (
    id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, file TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL, input_message_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('dirty','verified','corrupt')), revision INTEGER NOT NULL,
    verified_revision INTEGER, hash TEXT, sql_hash TEXT, changed_at TEXT NOT NULL, verified_at TEXT, audited_at TEXT, error TEXT
  );
  CREATE INDEX session_integrity_pending ON session_integrity(conversation_id,status,id);
  CREATE INDEX session_integrity_pages ON session_integrity(conversation_id,id);
  CREATE INDEX session_integrity_runs ON session_integrity(run_id);
  CREATE INDEX session_integrity_messages ON session_integrity(input_message_id);
  CREATE INDEX session_integrity_run_messages ON agent_runs(conversation_id,pi_session_file,input_message_id,response_message_id);
  CREATE INDEX session_integrity_linked_messages ON messages(conversation_id,pi_entry_id);
  CREATE TABLE session_integrity_sweeps(conversation_id TEXT PRIMARY KEY,last_id INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
  CREATE TABLE session_integrity_canonical_messages(message_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,message_rowid INTEGER NOT NULL);
  CREATE INDEX session_integrity_canonical_page ON session_integrity_canonical_messages(conversation_id,message_rowid);
  INSERT INTO session_integrity_canonical_messages SELECT m.id,m.conversation_id,m.rowid FROM messages m
    WHERE m.pi_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.pi_session_file IS NOT NULL
      AND (r.input_message_id=m.id OR r.response_message_id=m.id));
  INSERT INTO session_integrity(conversation_id,file,run_id,input_message_id,status,revision,changed_at)
    SELECT conversation_id,pi_session_file,id,input_message_id,'dirty',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM agent_runs WHERE pi_session_file IS NOT NULL;
  ${SESSION_INTEGRITY_TRIGGER_SQL.join(';')};`);
}

function checkpoint(row: Record<string, unknown>): SessionCheckpoint {
  return { id: Number(row.id), conversationId: String(row.conversation_id), file: String(row.file),
    runId: String(row.run_id), inputMessageId: String(row.input_message_id),
    status: row.status as SessionCheckpoint['status'], revision: Number(row.revision),
    verifiedRevision: row.verified_revision === null ? null : Number(row.verified_revision),
    hash: row.hash === null ? null : String(row.hash), sqlHash:row.sql_hash===null?null:String(row.sql_hash),
    error: row.error === null ? null : String(row.error) };
}

export class SessionIntegrityStore {
  constructor(private readonly db: DatabaseSync) {}

  pending(conversationId: string, afterId = 0, limit = 64): SessionCheckpoint[] {
    return this.db.prepare(`SELECT * FROM session_integrity WHERE conversation_id=? AND status='dirty' AND id>? ORDER BY id LIMIT ?`)
      .all(conversationId, afterId, limit).map(checkpoint);
  }

  page(conversationId: string, afterId = 0, limit = 64): SessionCheckpoint[] {
    return this.db.prepare('SELECT * FROM session_integrity WHERE conversation_id=? AND id>? ORDER BY id LIMIT ?')
      .all(conversationId, afterId, limit).map(checkpoint);
  }

  problem(conversationId: string): SessionCheckpoint | undefined {
    const row = this.db.prepare("SELECT * FROM session_integrity WHERE conversation_id=? AND status='corrupt' ORDER BY id LIMIT 1").get(conversationId);
    return row ? checkpoint(row) : undefined;
  }

  forFile(file: string): SessionCheckpoint | undefined {
    const row = this.db.prepare('SELECT * FROM session_integrity WHERE file=?').get(file);
    return row ? checkpoint(row) : undefined;
  }

  snapshot(entry: SessionCheckpoint) {
    return this.db.prepare(`SELECT r.id,r.conversation_id,r.pi_session_file,r.input_message_id,r.status,
      u.id AS user_id,u.conversation_id AS user_conversation,u.role AS user_role,u.pi_entry_id AS user_entry,
      coalesce(u.model_input_text,u.text) AS user_text,u.text AS raw_user_text,r.response_message_id,
      a.id AS assistant_id,a.conversation_id AS assistant_conversation,a.role AS assistant_role,
      a.pi_entry_id AS assistant_entry,a.text AS assistant_text
      FROM agent_runs r LEFT JOIN messages u ON u.id=r.input_message_id LEFT JOIN messages a ON a.id=r.response_message_id
      WHERE r.id=?`).get(entry.runId);
  }

  canonicalMessages(conversationId: string, afterRowid = 0, limit = 64) {
    return this.db.prepare(`SELECT m.rowid,m.role,m.pi_entry_id,coalesce(m.model_input_text,m.text) AS text
      FROM session_integrity_canonical_messages link JOIN messages m ON m.rowid=link.message_rowid AND m.id=link.message_id
      WHERE link.conversation_id=? AND link.message_rowid>? ORDER BY link.message_rowid LIMIT ?`).all(conversationId,afterRowid,limit);
  }

  verified(entry: SessionCheckpoint, hash: string, sqlHash: string): boolean {
    return this.db.prepare(`UPDATE session_integrity SET status='verified',verified_revision=revision,hash=?,sql_hash=?,
      verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),audited_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error=NULL
      WHERE id=? AND revision=? AND status=?`).run(hash,sqlHash,entry.id,entry.revision,entry.status).changes === 1;
  }

  corrupt(entry: SessionCheckpoint, error: string): boolean {
    return this.db.prepare(`UPDATE session_integrity SET status='corrupt',error=?,audited_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=?`)
      .run(error,entry.id,entry.revision).changes === 1;
  }

  sweepCursor(conversationId: string): number {
    return Number(this.db.prepare('SELECT last_id FROM session_integrity_sweeps WHERE conversation_id=?').get(conversationId)?.last_id ?? 0);
  }

  advanceSweep(conversationId: string, lastId: number): void {
    this.db.prepare(`INSERT INTO session_integrity_sweeps VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(conversation_id) DO UPDATE SET last_id=excluded.last_id,updated_at=excluded.updated_at`).run(conversationId,lastId);
  }
}
