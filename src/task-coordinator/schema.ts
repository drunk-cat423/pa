import type { DatabaseSync } from 'node:sqlite';
import { DELIVERY_SCHEMA } from './delivery-schema.js';

export const TASK_PHASES = ['waiting_input', 'waiting_dependency', 'queued', 'running', 'reconciling', 'closed'] as const;
export const OUTCOME_STATUSES = ['succeeded', 'partial', 'failed', 'cancelled', 'timed_out', 'dependency_failed', 'outcome_unknown'] as const;

const APPLICATION_ID = 0x50415443;
const SCHEMA_VERSION = 4;

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

const SCHEDULING_SCHEMA = `
  ALTER TABLE task_revisions ADD COLUMN dispatch_json TEXT CHECK (dispatch_json IS NULL OR json_valid(dispatch_json));
  ALTER TABLE task_revisions ADD COLUMN dependencies_locked INTEGER NOT NULL DEFAULT 0 CHECK (dependencies_locked IN (0, 1));

  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    prerequisite_id TEXT NOT NULL,
    prerequisite_revision INTEGER NOT NULL,
    allow_partial INTEGER CHECK (allow_partial IN (0, 1)),
    PRIMARY KEY (task_id, revision, prerequisite_id, prerequisite_revision),
    FOREIGN KEY (task_id, revision) REFERENCES task_revisions(task_id, revision),
    FOREIGN KEY (prerequisite_id, prerequisite_revision) REFERENCES task_revisions(task_id, revision)
  ) STRICT;

  CREATE TABLE task_dispatch_queue (
    queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    UNIQUE (task_id, revision),
    FOREIGN KEY (task_id, owner) REFERENCES tasks(task_id, owner),
    FOREIGN KEY (task_id, revision) REFERENCES task_revisions(task_id, revision)
  ) STRICT;
  CREATE INDEX task_dispatch_queue_owner ON task_dispatch_queue(owner, queue_id);
  INSERT INTO task_dispatch_queue (owner, task_id, revision)
    SELECT t.owner, r.task_id, r.revision FROM task_revisions r JOIN tasks t USING (task_id)
    WHERE r.phase IN ('queued', 'waiting_dependency') ORDER BY r.created_at, r.rowid;

  CREATE TABLE task_scheduler_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    limits_json TEXT NOT NULL CHECK (json_valid(limits_json)),
    last_owner TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE TABLE task_scheduler_cursors (
    owner TEXT PRIMARY KEY,
    queue_id INTEGER NOT NULL,
    scan_end_id INTEGER NOT NULL CHECK (scan_end_id >= queue_id)
  ) STRICT;
  CREATE TABLE task_scheduler_workers (
    worker_id TEXT PRIMARY KEY,
    capacity_json TEXT NOT NULL CHECK (json_valid(capacity_json))
  ) STRICT;

  CREATE TABLE task_attempts (
    attempt_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    worker_id TEXT NOT NULL REFERENCES task_scheduler_workers(worker_id),
    lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
    attempt_token TEXT NOT NULL,
    can_resume INTEGER NOT NULL CHECK (can_resume IN (0, 1)),
    permissions_json TEXT NOT NULL CHECK (json_type(permissions_json) = 'array'),
    dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('unsent', 'possibly_sent', 'accepted', 'rejected')),
    external_id TEXT,
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    UNIQUE (task_id, revision, lease_generation),
    FOREIGN KEY (task_id, revision) REFERENCES task_revisions(task_id, revision)
  ) STRICT;
  CREATE UNIQUE INDEX task_attempts_active ON task_attempts(task_id, revision) WHERE ended_at IS NULL;
  CREATE INDEX task_attempts_continuation ON task_attempts(task_id, revision DESC, lease_generation DESC)
    WHERE dispatch_state IN ('possibly_sent', 'accepted');
  ALTER TABLE task_revisions ADD COLUMN resume_attempt_key TEXT REFERENCES task_attempts(attempt_key);

  CREATE TABLE task_reservations (
    attempt_key TEXT NOT NULL REFERENCES task_attempts(attempt_key),
    resource_kind TEXT NOT NULL CHECK (resource_kind IN ('global', 'owner', 'worker', 'pool', 'workspace')),
    resource_key TEXT NOT NULL,
    units INTEGER NOT NULL CHECK (units > 0),
    acquired_at INTEGER NOT NULL,
    released_at INTEGER,
    release_reason TEXT,
    PRIMARY KEY (attempt_key, resource_kind, resource_key),
    CHECK ((released_at IS NULL) = (release_reason IS NULL))
  ) STRICT;
  CREATE INDEX task_live_reservations ON task_reservations(resource_kind, resource_key, units) WHERE released_at IS NULL;
  CREATE UNIQUE INDEX task_workspace_writer ON task_reservations(resource_key)
    WHERE resource_kind = 'workspace' AND released_at IS NULL;

  CREATE TABLE task_attempt_events (
    attempt_key TEXT NOT NULL REFERENCES task_attempts(attempt_key),
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    late INTEGER NOT NULL CHECK (late IN (0, 1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (attempt_key, event_seq)
  ) STRICT;
`;

const RECOVERY_SCHEMA = `
  ALTER TABLE task_revisions ADD COLUMN not_before_at INTEGER CHECK (not_before_at > 0);
  ALTER TABLE task_revisions ADD COLUMN cancel_requested_at INTEGER;
  ALTER TABLE task_attempts ADD COLUMN next_recovery_at INTEGER;
  ALTER TABLE task_attempts ADD COLUMN recovery_lease_until INTEGER;
  ALTER TABLE task_attempts ADD COLUMN recovery_grace_ms INTEGER CHECK (recovery_grace_ms > 0);
  ALTER TABLE task_attempts ADD COLUMN stop_requested_at INTEGER;
  ALTER TABLE task_scheduler_policy ADD COLUMN dependency_recovery_cursor INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE task_scheduler_policy ADD COLUMN dependency_recovery_end INTEGER NOT NULL DEFAULT 0;

  UPDATE task_attempts SET next_recovery_at = 0
    WHERE ended_at IS NULL AND dispatch_state IN ('possibly_sent', 'accepted');

  CREATE INDEX task_revisions_expiry ON task_revisions(deadline_at, task_id, revision)
    WHERE phase IN ('waiting_input', 'waiting_dependency', 'queued');
  CREATE INDEX task_revisions_waiting_dependencies ON task_revisions(phase) WHERE phase = 'waiting_dependency';
  CREATE INDEX task_attempts_recovery ON task_attempts(next_recovery_at, attempt_key)
    WHERE next_recovery_at IS NOT NULL;
  CREATE INDEX task_attempts_unsent ON task_attempts(created_at, attempt_key)
    WHERE dispatch_state = 'unsent' AND ended_at IS NULL;
  CREATE INDEX task_reservations_attempt_live ON task_reservations(attempt_key) WHERE released_at IS NULL;
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
    if (applicationId === APPLICATION_ID && (schemaVersion === 1 || schemaVersion === 2 || schemaVersion === 3)) {
      if (schemaVersion === 1) db.exec(SCHEDULING_SCHEMA);
      if (schemaVersion <= 2) db.exec(RECOVERY_SCHEMA);
      db.exec(DELIVERY_SCHEMA);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
      return;
    }
    const empty = !db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get();
    if (applicationId !== 0 || schemaVersion !== 0 || !empty) {
      throw new Error(`Incompatible task coordinator database (application ID ${applicationId}, schema ${schemaVersion}).`);
    }
    db.exec(SCHEMA);
    db.exec(SCHEDULING_SCHEMA);
    db.exec(RECOVERY_SCHEMA);
    db.exec(DELIVERY_SCHEMA);
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
  });
}
