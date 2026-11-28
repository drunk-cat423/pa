export const DELIVERY_SCHEMA = `
  CREATE UNIQUE INDEX task_delivery_revision_source ON task_requests(task_id, revision);
  CREATE UNIQUE INDEX task_artifact_attempt_scope ON task_attempts(task_id, revision, attempt_key);
  CREATE TABLE task_artifact_staging (
    attempt_key TEXT NOT NULL REFERENCES task_attempts(attempt_key),
    reference TEXT NOT NULL,
    format TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK (byte_count > 0 AND byte_count <= 4194304),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    bytes BLOB NOT NULL CHECK (length(bytes) = byte_count),
    PRIMARY KEY (attempt_key, reference)
  ) STRICT;

  CREATE TABLE task_artifacts (
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    reference TEXT NOT NULL,
    attempt_key TEXT NOT NULL,
    PRIMARY KEY (task_id, revision, reference),
    FOREIGN KEY (task_id, revision) REFERENCES task_conclusions(task_id, revision),
    FOREIGN KEY (task_id, revision, attempt_key) REFERENCES task_attempts(task_id, revision, attempt_key),
    FOREIGN KEY (attempt_key, reference) REFERENCES task_artifact_staging(attempt_key, reference)
  ) STRICT;

  ALTER TABLE task_notifications ADD COLUMN room_key TEXT;
  ALTER TABLE task_notifications ADD COLUMN recipient_key TEXT;
  ALTER TABLE task_notifications ADD COLUMN claim_token TEXT;
  ALTER TABLE task_notifications ADD COLUMN claim_until INTEGER;
  ALTER TABLE task_notifications ADD COLUMN detail TEXT;
  CREATE UNIQUE INDEX task_delivery_active_room ON task_notifications(room_key)
    WHERE status = 'sending';
  CREATE INDEX task_delivery_pending ON task_notifications(notification_id) WHERE status = 'pending';
  CREATE INDEX task_delivery_pending_room ON task_notifications(room_key, notification_id)
    WHERE status = 'pending' AND room_key IS NOT NULL;
  CREATE INDEX task_delivery_expiring ON task_notifications(claim_until, notification_id) WHERE status = 'sending';

  CREATE TABLE task_delivery_reclaims (
    owner TEXT NOT NULL,
    source_key TEXT NOT NULL,
    notification_id INTEGER NOT NULL UNIQUE REFERENCES task_notifications(notification_id),
    PRIMARY KEY (owner, source_key)
  ) STRICT;

  CREATE TABLE task_delivery_parts (
    notification_id INTEGER NOT NULL REFERENCES task_notifications(notification_id),
    part_number INTEGER NOT NULL CHECK (part_number > 0),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'artifact')),
    body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'rejected', 'unknown')),
    receipt TEXT CHECK ((status = 'sent') = (receipt IS NOT NULL)),
    PRIMARY KEY (notification_id, part_number)
  ) STRICT;
  CREATE UNIQUE INDEX task_delivery_one_part_inflight ON task_delivery_parts(notification_id) WHERE status = 'sending';
`;
