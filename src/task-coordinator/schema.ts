import type { DatabaseSync } from 'node:sqlite';

export const TASK_PHASES = ['waiting_input', 'waiting_dependency', 'queued', 'running', 'reconciling', 'closed'] as const;
export const OUTCOME_STATUSES = ['succeeded', 'partial', 'failed', 'cancelled', 'timed_out', 'dependency_failed', 'outcome_unknown'] as const;

const APPLICATION_ID = 0x50415443;
const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE tasks (
    task_id TEXT NOT NULL PRIMARY KEY,
    owner TEXT NOT NULL,
    origin_source_key TEXT NOT NULL,
    head_revision INTEGER NOT NULL CHECK (head_revision > 0),
    created_at INTEGER NOT NULL,
    UNIQUE (task_id, owner),
    FOREIGN KEY (task_id, head_revision) REFERENCES task_revisions(task_id, revision) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE TABLE task_revisions (
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    goal TEXT NOT NULL,
    capability TEXT NOT NULL,
    materials_json TEXT NOT NULL CHECK (json_valid(materials_json) AND json_type(materials_json) = 'array'),
    deadline_at INTEGER NOT NULL CHECK (deadline_at > 0),
    budget REAL NOT NULL CHECK (budget >= 0 AND budget <= 1.7976931348623157e308),
    phase TEXT NOT NULL CHECK (phase IN ('${TASK_PHASES.join("','")}')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, revision)
  ) STRICT;

  CREATE TABLE task_requests (
    owner TEXT NOT NULL,
    source_key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('submit', 'revise')),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner, source_key),
    FOREIGN KEY (task_id, owner) REFERENCES tasks(task_id, owner),
    FOREIGN KEY (task_id, revision) REFERENCES task_revisions(task_id, revision)
  ) STRICT;

  CREATE TABLE task_conclusions (
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('${OUTCOME_STATUSES.join("','")}')),
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, revision),
    FOREIGN KEY (task_id, revision) REFERENCES task_revisions(task_id, revision)
  ) STRICT;

  CREATE TABLE task_notifications (
    notification_id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    recipient_owner TEXT NOT NULL,
    purpose TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'rejected', 'unknown')),
    created_at INTEGER NOT NULL,
    UNIQUE (task_id, revision, recipient_owner, purpose),
    FOREIGN KEY (task_id, revision) REFERENCES task_conclusions(task_id, revision),
    FOREIGN KEY (task_id, recipient_owner) REFERENCES tasks(task_id, owner)
  ) STRICT;
`;

export function inImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Task coordinator transaction rollback failed.'); }
    }
    throw error;
  }
}

export function initializeTaskCoordinatorSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
  inImmediateTransaction(db, () => {
    const applicationId = db.prepare('PRAGMA application_id').get()?.application_id;
    const schemaVersion = db.prepare('PRAGMA user_version').get()?.user_version;
    if (applicationId === APPLICATION_ID && schemaVersion === SCHEMA_VERSION) return;
    const empty = !db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get();
    if (applicationId !== 0 || schemaVersion !== 0 || !empty) {
      throw new Error(`Incompatible task coordinator database (application ID ${applicationId}, schema ${schemaVersion}).`);
    }
    db.exec(SCHEMA);
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
  });
}
