import assert from 'node:assert/strict';
import { TaskDeliveryStore } from '../../dist/task-coordinator/delivery-store.js';
import { TaskDeliveryWorker } from '../../dist/task-coordinator/delivery.js';

const [dbPath, at] = process.argv.slice(2);
const store = new TaskDeliveryStore(dbPath);
const parts = [];
process.on('disconnect', () => process.exit(1));
process.on('message', command => {
  assert.equal(command, 'interrupt');
  process.exit(42);
});
const sender = new TaskDeliveryWorker(store, {
  resolveRoute() { return { roomKey: 'controlled-room', recipientKey: 'controlled-recipient' }; },
  async sendPart(part) {
    parts.push(part.partNumber);
    if (part.partNumber === 1) return { status: 'sent', receipt: 'child-first-part' };
    process.send({ pid: process.pid, parts, notificationId: part.notificationId, totalParts: part.totalParts });
    return new Promise(() => {});
  },
}, { now: () => Number(at), leaseMs: 60_000, sendTimeoutMs: 30_000 });

await sender.tick();
throw new Error('Interrupted sender unexpectedly completed');
