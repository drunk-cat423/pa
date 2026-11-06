import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexWorkerStore } from '../dist/codex-worker-store.js';
import { codexArguments, prepareCodexWorkspace } from '../dist/codex-worker-runner.js';
import { retainCodexTasks } from '../dist/codex-worker-retention.js';

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
    assert.ok(args.some(value => value.includes('"/worker"="read"') && value.includes(JSON.stringify(join('/worker/state/workspaces/current', '.git')) + '="read"')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Read tasks share immutable source, retire safely and keep unpublished fixes and delivery evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-codex-retention-'));
  try {
    const source = join(directory, 'source'), home = join(directory, 'home'), state = join(home, 'state');
    mkdirSync(source); mkdirSync(home); mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'auth.json'), 'private');
    const store = new CodexWorkerStore(state);
    const config = { directory: state, source, home, owner: 'owner', binary: 'never-run', modules: '/modules', socket: '/socket' };
    const create = (id, mode = 'read', baseCommit) => {
      const receipt = store.submit({ owner: config.owner, requestId: id, prompt: id, mode });
      const task = store.claim(); task.status = 'completed'; task.baseCommit = baseCommit; store.update(task);
      task.updatedAt = '2020-01-01T00:00:00.000Z';
      const result = join(state, 'results', receipt.id + '-1'); mkdirSync(result, { recursive: true });
      writeFileSync(join(result, 'events.jsonl'), 'large event'); writeFileSync(join(result, 'summary.txt'), 'delivery pending');
      writeFileSync(join(result, 'diff.txt'), baseCommit ? 'unpublished diff' : '');
      mkdirSync(join(state, 'workspaces', receipt.id), { recursive: true });
      return task;
    };
    const old = create('old');
    const changed = create('changed', 'fix', 'baseline');
    store.submit({ owner: config.owner, requestId: 'read-followup', taskId: changed.id, mode: 'read', prompt: 'read modified tree' });
    const readFollowup = store.claim(); readFollowup.status = 'completed'; store.update(readFollowup);
    readFollowup.updatedAt = '2020-01-02T00:00:00.000Z';
    const followupResult = join(state, 'results', changed.id + '-2'); mkdirSync(followupResult);
    writeFileSync(join(followupResult, 'diff.txt'), '');
    const latest = create('latest'); latest.updatedAt = '2021-01-01T00:00:00.000Z';
    const read = { ...latest, baseCommit: undefined };
    assert.equal(await prepareCodexWorkspace(config, read), source);
    assert.equal(read.baseCommit, undefined);
    const policy = codexArguments(config, read, source).find(value => value.startsWith('permissions.pa_task.filesystem='));
    assert.ok(policy.includes(JSON.stringify(home) + '="read"'));
    assert.ok(policy.includes(JSON.stringify(join(home, '.codex')) + '="deny"'));
    assert.ok(codexArguments(config, read, source).includes('--skip-git-repo-check'));
    await retainCodexTasks(config, store, Date.parse('2026-01-01T00:00:00Z'));
    assert.ok(store.get(old.id, config.owner).archivedAt);
    assert.ok(store.get(old.id, config.owner).reclaimedAt);
    assert.equal(existsSync(join(state, 'workspaces', old.id)), false);
    assert.equal(existsSync(join(state, 'results', old.id + '-1', 'events.jsonl')), false);
    assert.equal(readFileSync(join(state, 'results', old.id + '-1', 'summary.txt'), 'utf8'), 'delivery pending');
    assert.throws(() => store.submit({ owner: config.owner, requestId: 'old-followup', taskId: old.id, prompt: 'continue', mode: 'read' }), /归档/);
    assert.equal(store.get(changed.id, config.owner).archivedAt, undefined);
    assert.ok(existsSync(join(state, 'workspaces', changed.id)));
    assert.equal(store.get(latest.id, config.owner).archivedAt, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
