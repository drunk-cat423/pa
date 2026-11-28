import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { splitMarkdown } from '../markdown-chunks.js';
import { ArtifactUnavailableError, listFrozenArtifacts, readFrozenArtifact } from './artifacts.js';
import type { ArtifactMetadata, TaskArtifact } from './artifacts.js';
import { initializeTaskCoordinatorSchema, inImmediateTransaction } from './schema.js';
import { TaskCoordinatorError } from './store.js';
import type { TaskOutcome, TaskReceipt } from './store.js';

export interface ChannelRoute {
  readonly roomKey: string;
  readonly recipientKey: string;
}

export interface DeliverySource {
  readonly owner: string;
  readonly sourceKey: string;
}

export interface DeliveryIntent extends TaskReceipt {
  readonly owner: string;
  readonly sourceKey: string | null;
  readonly notificationId: number;
}

export interface DeliveryClaim extends DeliveryIntent {
  readonly token: string;
  readonly route: ChannelRoute;
}

type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'rejected' | 'unknown';
export type DeliveryDetail = 'route_revoked' | 'artifact_unavailable' | 'sender_rejected' | 'receipt_unknown' | 'sender_lost';
export type DeliveryBody = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'artifact'; readonly artifact: TaskArtifact };
export type DeliveryReceipt = { readonly status: 'sent'; readonly receipt: string } | { readonly status: 'rejected' | 'unknown' };

export interface DeliveryPart {
  readonly partNumber: number;
  readonly totalParts: number;
  readonly body: DeliveryBody;
}

type DeliveryInfo = {
  notificationId: number;
  status: DeliveryStatus;
  purpose: 'automatic' | 'reclaim';
  detail: DeliveryDetail | null;
};

type PartInfo = { partNumber: number; status: DeliveryStatus; receipt: string | null };
type PendingRow = {
  notification_id: number;
  task_id: string;
  revision: number;
  recipient_owner: string;
  source_key: string | null;
};

interface RevisionResult {
  readonly conclusion: TaskOutcome;
  readonly artifacts: readonly (ArtifactMetadata & { available: boolean })[];
  readonly deliveries: readonly DeliveryInfo[];
  readonly nextAfterNotificationId?: number;
}

const scanLimit = 32;

function nonemptyText(value: string, maxBytes: number): boolean {
  return typeof value === 'string' && value.length <= maxBytes && !!value.trim()
    && !value.includes('\0') && Buffer.byteLength(value) <= maxBytes && Buffer.from(value).toString() === value;
}

export function validChannelRoute(route: ChannelRoute | undefined): route is ChannelRoute {
  return !!route && nonemptyText(route.roomKey, 1024) && nonemptyText(route.recipientKey, 1024);
}

function readIntent(row: PendingRow): DeliveryIntent {
  return {
    notificationId: row.notification_id, taskId: row.task_id, revision: row.revision,
    owner: row.recipient_owner, sourceKey: row.source_key,
  };
}

function assertArtifact(db: DatabaseSync, owner: string, receipt: TaskReceipt, reference: string): TaskArtifact {
  const artifact = readFrozenArtifact(db, owner, receipt, reference);
  if (!artifact) throw new ArtifactUnavailableError();
  return artifact;
}

export class TaskDeliveryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    try { initializeTaskCoordinatorSchema(this.db); }
    catch (error) { this.db.close(); throw error; }
  }

  result(owner: string, receipt: TaskReceipt, afterNotificationId = 0): RevisionResult | undefined {
    const conclusion = this.readConclusion(owner, receipt);
    if (!conclusion) return undefined;
    const artifacts = listFrozenArtifacts(this.db, owner, receipt).map(artifact => {
      let available = false;
      try { available = !!readFrozenArtifact(this.db, owner, receipt, artifact.reference); }
      catch (error) { if (!(error instanceof ArtifactUnavailableError)) throw error; }
      return { ...artifact, available };
    });
    const deliveries = this.db.prepare(`SELECT notification_id AS notificationId, status, detail,
      CASE WHEN purpose = 'automatic' THEN 'automatic' ELSE 'reclaim' END AS purpose
      FROM task_notifications WHERE recipient_owner = ? AND task_id = ? AND revision = ? AND notification_id > ?
      ORDER BY notification_id LIMIT ?`).all(owner, receipt.taskId, receipt.revision, afterNotificationId, scanLimit + 1) as DeliveryInfo[];
    const page = deliveries.slice(0, scanLimit);
    return { conclusion, artifacts, deliveries: page,
      ...(deliveries.length > scanLimit ? { nextAfterNotificationId: page.at(-1)!.notificationId } : {}) };
  }

  readArtifact(owner: string, receipt: TaskReceipt, reference: string): TaskArtifact | undefined {
    return readFrozenArtifact(this.db, owner, receipt, reference);
  }

  delivery(owner: string, notificationId: number): (DeliveryInfo & { parts: PartInfo[] }) | undefined {
    const info = this.db.prepare(`SELECT notification_id AS notificationId, status, detail,
      CASE WHEN purpose = 'automatic' THEN 'automatic' ELSE 'reclaim' END AS purpose
      FROM task_notifications WHERE recipient_owner = ? AND notification_id = ?`).get(owner, notificationId) as DeliveryInfo | undefined;
    return info && { ...info, parts: this.readParts(owner, notificationId) };
  }

  readParts(owner: string, notificationId: number): PartInfo[] {
    return this.db.prepare(`SELECT part_number AS partNumber, p.status, p.receipt FROM task_delivery_parts p
      JOIN task_notifications n USING (notification_id) WHERE n.recipient_owner = ? AND p.notification_id = ?
      ORDER BY part_number`).all(owner, notificationId) as PartInfo[];
  }

  /** The caller obtains owner and sourceKey from the authorized inbound channel event. */
  reclaim(owner: string, sourceKey: string, receipt: TaskReceipt): number {
    const { taskId, revision } = receipt;
    if (!nonemptyText(owner, 256) || !nonemptyText(sourceKey, 4096) || !nonemptyText(taskId, 128)
      || !Number.isSafeInteger(revision) || revision < 1) {
      throw new TaskCoordinatorError('invalid_request', 'Invalid task result request.');
    }
    return inImmediateTransaction(this.db, () => {
      const previous = this.db.prepare(`SELECT n.notification_id, n.task_id, n.revision FROM task_delivery_reclaims r
        JOIN task_notifications n USING (notification_id) WHERE r.owner = ? AND r.source_key = ?`).get(owner, sourceKey);
      if (previous) {
        if (previous.task_id !== taskId || previous.revision !== revision) {
          throw new TaskCoordinatorError('conflict', 'Source key already belongs to another task result request.');
        }
        return Number(previous.notification_id);
      }
      if (!this.readConclusion(owner, receipt)) throw new TaskCoordinatorError('not_found', 'Task result not found.');
      const purpose = 'reclaim:' + createHash('sha256').update(sourceKey).digest('hex');
      const inserted = this.db.prepare(`INSERT INTO task_notifications
        (task_id, revision, recipient_owner, purpose, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(taskId, revision, owner, purpose, Date.now());
      this.db.prepare('INSERT INTO task_delivery_reclaims (owner, source_key, notification_id) VALUES (?, ?, ?)')
        .run(owner, sourceKey, inserted.lastInsertRowid);
      return Number(inserted.lastInsertRowid);
    });
  }

  pending(afterNotificationId = 0): DeliveryIntent[] {
    const rows = this.db.prepare(`SELECT n.notification_id, n.task_id, n.revision, n.recipient_owner,
      coalesce(r.source_key, q.source_key) AS source_key
      FROM task_notifications n LEFT JOIN task_delivery_reclaims r USING (notification_id)
      LEFT JOIN task_requests q ON q.task_id = n.task_id AND q.revision = n.revision AND q.owner = n.recipient_owner
      WHERE n.status = 'pending' AND n.notification_id > ? ORDER BY n.notification_id LIMIT ?`).all(afterNotificationId, scanLimit) as PendingRow[];
    return rows.map(readIntent);
  }

  rejectPending(intent: DeliveryIntent, detail: DeliveryDetail): void {
    this.db.prepare(`UPDATE task_notifications SET status = 'rejected', detail = ?
      WHERE notification_id = ? AND status = 'pending'`).run(detail, intent.notificationId);
  }

  claim(intent: DeliveryIntent, route: ChannelRoute, now: number, leaseMs: number): DeliveryClaim | undefined {
    return inImmediateTransaction(this.db, () => {
      const { notificationId, owner } = intent;
      const selected = this.db.prepare(`SELECT room_key, recipient_key FROM task_notifications
        WHERE notification_id = ? AND recipient_owner = ? AND task_id = ? AND revision = ? AND status = 'pending'`)
        .get(notificationId, owner, intent.taskId, intent.revision);
      if (!selected) return undefined;
      if (selected.room_key !== null && (selected.room_key !== route.roomKey || selected.recipient_key !== route.recipientKey)) {
        this.rejectPending(intent, 'route_revoked');
        return undefined;
      }
      if (selected.room_key === null) {
        this.db.prepare(`UPDATE task_notifications SET room_key = ?, recipient_key = ? WHERE notification_id = ?`)
          .run(route.roomKey, route.recipientKey, notificationId);
      }
      if (this.db.prepare(`SELECT 1 FROM task_notifications WHERE room_key = ? AND status = 'sending' LIMIT 1`).get(route.roomKey)
        || this.db.prepare(`SELECT 1 FROM task_notifications
          WHERE room_key = ? AND status = 'pending' AND notification_id < ? LIMIT 1`).get(route.roomKey, notificationId)) {
        return undefined;
      }
      const token = randomUUID();
      this.db.prepare(`UPDATE task_notifications SET status = 'sending', room_key = ?, recipient_key = ?,
        claim_token = ?, claim_until = ? WHERE notification_id = ?`)
        .run(route.roomKey, route.recipientKey, token, now + leaseMs, notificationId);
      const claim = { ...intent, token, route: { ...route } };
      try {
        const artifacts = listFrozenArtifacts(this.db, owner, intent);
        for (const artifact of artifacts) assertArtifact(this.db, owner, intent, artifact.reference);
        if (!this.db.prepare('SELECT 1 FROM task_delivery_parts WHERE notification_id = ? LIMIT 1').get(notificationId)) {
          const conclusion = this.readConclusion(owner, intent);
          if (!conclusion) throw new Error('Delivery has no conclusion.');
          const text = `任务 ${intent.taskId}（第 ${intent.revision} 版） · ${conclusion.status}\n\n${conclusion.summary}`;
          const insert = this.db.prepare(`INSERT INTO task_delivery_parts
            (notification_id, part_number, kind, body, status) VALUES (?, ?, ?, ?, 'pending')`);
          let partNumber = 0;
          for (const part of splitMarkdown(text)) insert.run(notificationId, ++partNumber, 'text', part);
          for (const artifact of artifacts) insert.run(notificationId, ++partNumber, 'artifact', artifact.reference);
        }
      } catch (error) {
        if (!(error instanceof ArtifactUnavailableError)) throw error;
        this.endClaim(claim, 'rejected', 'artifact_unavailable');
        return undefined;
      }
      return claim;
    });
  }

  // Reserve the exact next part before an external send. Each claim is fenced even between parts.
  reservePart(claim: DeliveryClaim, now: number, leaseMs: number): DeliveryPart | undefined {
    return inImmediateTransaction(this.db, () => {
      if (!this.hasClaim(claim, now)) return undefined;
      const { notificationId } = claim;
      const part = this.db.prepare(`SELECT part_number, kind, body, (
        SELECT count(*) FROM task_delivery_parts WHERE notification_id = ?) AS total_parts
        FROM task_delivery_parts WHERE notification_id = ? AND status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM task_delivery_parts WHERE notification_id = ? AND status = 'sending')
        ORDER BY part_number LIMIT 1`)
        .get(notificationId, notificationId, notificationId);
      if (!part) return undefined;
      try {
        const body: DeliveryBody = part.kind === 'artifact'
          ? { kind: 'artifact', artifact: assertArtifact(this.db, claim.owner, claim, String(part.body)) }
          : { kind: 'text', text: String(part.body) };
        this.db.prepare(`UPDATE task_delivery_parts SET status = 'sending' WHERE notification_id = ? AND part_number = ?`)
          .run(notificationId, part.part_number!);
        this.db.prepare('UPDATE task_notifications SET claim_until = ? WHERE notification_id = ?').run(now + leaseMs, notificationId);
        return { partNumber: Number(part.part_number), totalParts: Number(part.total_parts), body };
      } catch (error) {
        if (!(error instanceof ArtifactUnavailableError)) throw error;
        this.endClaim(claim, 'rejected', 'artifact_unavailable');
        return undefined;
      }
    });
  }

  deferClaim(claim: DeliveryClaim): void {
    this.db.prepare(`UPDATE task_notifications SET status = 'pending', claim_token = NULL, claim_until = NULL
      WHERE notification_id = ? AND status = 'sending' AND claim_token = ?
      AND NOT EXISTS (SELECT 1 FROM task_delivery_parts WHERE notification_id = ? AND status = 'sending')`)
      .run(claim.notificationId, claim.token, claim.notificationId);
  }

  rejectClaim(claim: DeliveryClaim, now: number): void {
    inImmediateTransaction(this.db, () => {
      if (!this.hasClaim(claim, now)) return;
      this.db.prepare(`UPDATE task_delivery_parts SET status = 'rejected'
        WHERE notification_id = ? AND status = 'sending'`).run(claim.notificationId);
      this.endClaim(claim, 'rejected', 'route_revoked');
    });
  }

  recordReceipt(claim: DeliveryClaim, partNumber: number, result: DeliveryReceipt, now: number): boolean {
    return inImmediateTransaction(this.db, () => {
      if (!this.hasClaim(claim, now)) return false;
      const receipt = result.status === 'sent' && nonemptyText(result.receipt, 2048) ? result.receipt : null;
      const status = receipt ? 'sent' : result.status === 'rejected' ? 'rejected' : 'unknown';
      const update = this.db.prepare(`UPDATE task_delivery_parts SET status = ?, receipt = ?
        WHERE notification_id = ? AND part_number = ? AND status = 'sending'`)
        .run(status, receipt, claim.notificationId, partNumber);
      if (update.changes !== 1) return false;
      if (status !== 'sent') {
        this.endClaim(claim, status, status === 'unknown' ? 'receipt_unknown' : 'sender_rejected');
        return false;
      }
      if (this.db.prepare(`SELECT 1 FROM task_delivery_parts WHERE notification_id = ? AND status = 'pending' LIMIT 1`)
        .get(claim.notificationId)) return true;
      this.endClaim(claim, 'sent', null);
      return false;
    });
  }

  recoverExpired(now: number): void {
    inImmediateTransaction(this.db, () => {
      const candidates = this.db.prepare(`SELECT notification_id FROM task_notifications
        WHERE status = 'sending' AND claim_until <= ? ORDER BY claim_until, notification_id LIMIT ?`).all(now, scanLimit);
      const abandonPart = this.db.prepare(`UPDATE task_delivery_parts SET status = 'unknown'
        WHERE notification_id = ? AND status = 'sending'`);
      const release = this.db.prepare(`UPDATE task_notifications SET status = ?, detail = ?, claim_token = NULL, claim_until = NULL
        WHERE notification_id = ?`);
      for (const row of candidates) {
        const abandoned = abandonPart.run(row.notification_id!).changes !== 0;
        release.run(abandoned ? 'unknown' : 'pending', abandoned ? 'sender_lost' : null, row.notification_id!);
      }
    });
  }

  close(): void {
    this.db.close();
  }

  private readConclusion(owner: string, { taskId, revision }: TaskReceipt): TaskOutcome | undefined {
    return this.db.prepare(`SELECT c.status, c.summary FROM task_conclusions c JOIN tasks t USING (task_id)
      WHERE t.owner = ? AND c.task_id = ? AND c.revision = ?`).get(owner, taskId, revision) as TaskOutcome | undefined;
  }

  private hasClaim(claim: DeliveryClaim, now: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM task_notifications WHERE notification_id = ? AND status = 'sending'
      AND claim_token = ? AND claim_until > ?`).get(claim.notificationId, claim.token, now);
  }

  private endClaim(claim: DeliveryClaim, status: 'sent' | 'rejected' | 'unknown', detail: DeliveryDetail | null): void {
    this.db.prepare(`UPDATE task_notifications SET status = ?, detail = ?, claim_token = NULL, claim_until = NULL
      WHERE notification_id = ? AND claim_token = ?`).run(status, detail, claim.notificationId, claim.token);
  }
}
