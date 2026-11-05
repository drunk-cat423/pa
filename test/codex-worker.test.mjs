import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexWorkerStore } from '../dist/codex-worker-store.js';
import { codexArguments } from '../dist/codex-worker-runner.js';

test('Codex tasks preserve request identity, revisions and interrupted work without replay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-codex-worker-'));
  try {
    let store = new CodexWorkerStore(directory);
    const input = { requestId: 'message-1', owner: 'owner-a', mode: 'fix', prompt: 'Fix one issue.' };
    const first = store.submit(input);
    assert.deepEqual(store.submit(input), first);
    assert.throws(() => store.submit({ ...input, prompt: 'Different action.' }));
    const active = store.claim();
    active.threadId = 'saved-codex-session';
    active.baseCommit = 'known-baseline';
    store.update(active);
    store = new CodexWorkerStore(directory);
    assert.equal(store.get(first.id, input.owner).status, 'interrupted');
    assert.equal(store.claim(), undefined);
    assert.equal(store.get(first.id, 'other-owner'), undefined);
    const followup = store.submit({ ...input, requestId: 'message-2', taskId: first.id, prompt: 'Continue this task.' });
    assert.equal(followup.revision, 2);
    assert.equal(store.list(input.owner, 'message-1')[0].revision, 1);
    assert.equal(store.claim().threadId, 'saved-codex-session');
    const task = store.get(first.id, input.owner);
    const args = codexArguments({ directory: '/worker/state', source: '/source', binary: '/bin/codex', modules: '/cache/node_modules',
      owner: input.owner, socket: '/run/pa-codex/worker.sock', home: '/worker', logFile: '/logs/events.log' }, task, '/worker/state/workspaces/current');
    assert.ok(args.includes('gpt-6.1-sol'));
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.ok(args.includes('saved-codex-session'));
    assert.ok(args.some(value => value.includes('"/worker"="deny"') && value.includes(JSON.stringify(join('/worker/state/workspaces/current', '.git')) + '="read"')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
