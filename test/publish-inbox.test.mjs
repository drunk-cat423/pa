import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PublishInbox, readPublicationGate } from '../dist/publish-inbox.js';
import { ChannelHarness } from '../dist/channel-harness.js';
import { BackgroundMemory } from '../dist/auto-memory.js';

test('publish standby holds business work and rollback-safe QQ inbox replays ordered inputs only after durable acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-publish-inbox-'));
  const dataDir = join(directory, 'app'), inboxDir = join(directory, 'external-inbox'), gatePath = join(directory, 'hold');
  const route = { channel: 'qq', accountId: 'bot', roomType: 'private', roomId: 'owner' }, sends = [];
  const config = { cwd: directory, dataDir, provider: 'fixture', model: 'fixture', apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:1',
    contextWindow: 1000000, maxOutputTokens: 1024, timeoutMs: 3000, research: { enabled: false, maxModelCalls: 2, maxToolCalls: 2, maxSearchCalls: 1 } };
  const create = standby => new ChannelHarness(config, [route], { send: async message => {
    sends.push(message); return { status: 'sent', externalMessageId: `out-${sends.length}` };
  } }, 0, { version: 1, ownerBindings: [] }, undefined, undefined, undefined,
  { standby, mayRun: () => !readPublicationGate(gatePath) });
  let harness, inbox, pausedMemory;
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(gatePath, 'hold'); assert.equal(readPublicationGate(gatePath), 'hold');
    harness = create(true); inbox = new PublishInbox(inboxDir, [route]);
    await harness.prepare(); assert.ok(harness.info().persistence.every(room => room.status === 'ready'));
    let allowed = false;
    pausedMemory = new BackgroundMemory({ ...config, memory: { enabled: true, maxCalls: 1, timeoutMs: 1000 } },
      { reserveRecoveryJobs() { throw new Error('activated memory reservation'); } }, 'room', { extract: async () => { throw Error('unexpected model'); } }, undefined, () => allowed);
    pausedMemory.start(); allowed = true;
    assert.throws(() => pausedMemory.start(), /activated memory reservation/); allowed = false;
    const message = n => ({ route, senderId: 'owner', eventId: `held-${n}`, text: '/result 00000000-0000-0000-0000-000000000000', mentioned: false, sentAt: new Date().toISOString() });
    assert.equal(inbox.capture({ ...message(0), route: { ...route, roomId: 'unauthorized' } }), false);
    assert.throws(() => inbox.capture({ ...message(0), senderId: 'forged' }), /无法核实/);
    inbox.capture(message(1)); inbox.capture(message(1)); inbox.capture(message(2));
    assert.equal(inbox.size(), 2); assert.equal(inbox.next().message.eventId, 'held-1');
    await assert.rejects(harness.handle(message(1)), /发布检查/); assert.equal(sends.length, 0);
    await writeFile(gatePath, 'activate'); assert.equal(readPublicationGate(gatePath), 'activate');
    assert.equal(inbox.size(), 2); assert.equal(sends.length, 0);
    await writeFile(gatePath, 'opening'); assert.equal(readPublicationGate(gatePath), 'opening');
    await harness.start();
    assert.equal(harness.info().reminders.started, true, 'normal service startup can finish while external execution remains gated');
    await assert.rejects(harness.handle(message(1)), /发布检查/); assert.equal(sends.length, 0); assert.equal(inbox.size(), 2);
    await harness.close(); inbox.close();
    await rm(dataDir, { recursive: true, force: true }); // Simulate restoration of the old application's snapshot.
    await unlink(gatePath); assert.equal(readPublicationGate(gatePath), undefined);
    inbox = new PublishInbox(inboxDir, [route]); harness = create(true); await harness.start();
    const first = inbox.next(); assert.equal(await harness.handle(first.message, { waitForResult: false }), 'accepted');
    await harness.waitForTasks();
    // A crash before acknowledging the external inbox must deduplicate against application admission.
    assert.equal(await harness.handle(first.message, { waitForResult: false }), 'duplicate');
    inbox.acknowledge(first.sequence);
    const second = inbox.next(); assert.equal(second.message.eventId, 'held-2');
    assert.equal(await harness.handle(second.message, { waitForResult: false }), 'accepted'); inbox.acknowledge(second.sequence);
    await harness.waitForTasks(); assert.equal(inbox.size(), 0); assert.equal(sends.length, 2);
    assert.deepEqual(sends.map(item => item.replyToMessageId), ['held-1', 'held-2']);
    inbox.close();
    const other = { ...route, roomId: 'healthy-owner' };
    inbox = new PublishInbox(inboxDir, [route, other]);
    inbox.capture(message(3)); inbox.capture(message(4));
    inbox.capture({ ...message(5), route: other, senderId: other.roomId });
    inbox.deferRoom(route, 1000);
    const healthy = inbox.next(1001); assert.equal(healthy.message.eventId, 'held-5');
    inbox.acknowledge(healthy.sequence);
    assert.equal(inbox.next(1002), undefined); assert.equal(inbox.size(), 2, 'failed room originals are retained without blocking healthy rooms');
    assert.equal(inbox.next(31001).message.eventId, 'held-3', 'the isolated room retries in its original order after a bounded delay');
    inbox.close(); inbox = new PublishInbox(inboxDir, [other]);
    assert.equal(inbox.next(31001), undefined, 'revoked route originals are retained rather than replayed or crashing other rooms');
    assert.equal(inbox.size(), 2);
    await writeFile(gatePath, 'unexpected'); assert.throws(() => readPublicationGate(gatePath), /门禁状态/);
  } finally { await pausedMemory?.close(); await harness?.close(); inbox?.close(); await rm(directory, { recursive: true, force: true }); }
});
