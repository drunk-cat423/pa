import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { acquireConversationLock } from '../dist/conversation-lock.js';
import { searchDeepSeek } from '../dist/web-search.js';

const payload = { content: [{ type: 'web_search_tool_result', content: [] }], usage: {} };
const response = () => new Response(JSON.stringify(payload));
function deferred() { return Promise.withResolvers(); }
async function fixture(t, maxRequests = 0) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-search-concurrency-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, provider: 'deepseek', apiKey: 'offline-fixture',
    search: { enabled: true, budgetId: 'shared', model: 'offline', maxRequests, maxUses: 1,
      maxTokens: 1024, timeoutMs: 3000, maxResults: 5 } };
  const directory = join(dataDir, createHash('sha256').update('web-search-budget:shared').digest('hex'));
  const ledgerPath = join(directory, 'search-attempts.jsonl');
  return { config, directory, ledgerPath, entries: async () =>
    (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

test('共享无限预算允许四条请求并发，额外请求排队可取消且不占预算', { timeout: 10000 }, async t => {
  const f = await fixture(t), gate = deferred(), started = deferred();
  let active = 0, peak = 0, calls = 0;
  const fetcher = async () => {
    calls++; active++; peak = Math.max(peak, active);
    if (calls === 4) started.resolve();
    await gate.promise;
    active--;
    return response();
  };
  const pending = Array.from({ length: 4 }, (_, i) => searchDeepSeek(f.config, `parallel-${i}`, undefined, fetcher));
  t.after(() => gate.resolve());
  await started.promise;
  const controller = new AbortController();
  const cancelled = searchDeepSeek(f.config, 'cancelled', controller.signal, fetcher);
  const rejected = assert.rejects(cancelled, /已取消/);
  const queued = searchDeepSeek(f.config, 'queued', undefined, fetcher);
  controller.abort();
  await rejected;
  assert.equal(calls, 4);
  assert.equal((await f.entries()).filter(event => event.type === 'reserved').length, 4);
  gate.resolve();
  const results = await Promise.all([...pending, queued]);
  assert.equal(peak, 4);
  assert.equal(calls, 5);
  assert.equal(new Set(results.map(result => result.attemptId)).size, 5);
  const entries = await f.entries();
  assert.equal(entries.filter(event => event.type === 'completed').length, 5);
  assert.equal(entries.filter(event => event.type === 'reserved').length, 5);
  assert.ok(!entries.some(event => event.query === 'cancelled'));
});

test('不同进程同时预约共享预算仍不超额，重启后持久预算继续生效', { timeout: 10000 }, async t => {
  const f = await fixture(t, 2);
  const moduleUrl = new URL('../dist/web-search.js', import.meta.url).href;
  const workerCode = `
    import { searchDeepSeek } from ${JSON.stringify(moduleUrl)};
    const config = JSON.parse(process.argv[1]);
    process.send({ ready: true });
    process.once('message', async () => {
      let calls = 0;
      const fetcher = async () => { calls++; await new Promise(r => setTimeout(r, 50));
        return new Response(JSON.stringify(${JSON.stringify(payload)})); };
      const results = await Promise.allSettled(Array.from({ length: 3 }, (_, i) => searchDeepSeek(config, 'worker-' + i, undefined, fetcher)));
      process.send({ calls, statuses: results.map(r => r.status), errors: results.filter(r => r.status === 'rejected').map(r => r.reason.message) });
      process.disconnect();
    });
  `;
  const workers = Array.from({ length: 2 }, () => spawn(process.execPath,
    ['--input-type=module', '-e', workerCode, JSON.stringify(f.config)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  t.after(() => { for (const worker of workers) if (worker.exitCode === null) worker.kill(); });
  const exits = workers.map(worker => once(worker, 'exit'));
  await Promise.all(workers.map(worker => once(worker, 'message')));
  const messages = workers.map(worker => once(worker, 'message'));
  for (const worker of workers) worker.send('go');
  const results = (await Promise.all(messages)).map(([message]) => message);
  assert.equal(results.reduce((sum, result) => sum + result.calls, 0), 2);
  assert.equal(results.flatMap(result => result.statuses).filter(status => status === 'fulfilled').length, 2);
  assert.ok(results.flatMap(result => result.errors).every(error => /预算已用尽/.test(error)));
  assert.ok((await Promise.all(exits)).every(([code]) => code === 0));
  await assert.rejects(searchDeepSeek(f.config, 'after-restart', undefined,
    async () => { assert.fail('exhausted budget must not send'); }), /预算已用尽/);
  assert.equal((await f.entries()).filter(event => event.type === 'reserved').length, 2);
});

test('旧JSONL与未知预约仍计数，请求失败不重发也不退还预算', { timeout: 10000 }, async t => {
  const f = await fixture(t, 3), timestamp = new Date().toISOString();
  const oldId = randomUUID(), unknownId = randomUUID();
  const oldEntries = [
    { type: 'reserved', attemptId: oldId, timestamp, query: 'old' },
    { type: 'completed', attemptId: oldId, timestamp, sources: [{ url: 'https://example.com/', publishedAt: 'old-date' }],
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0, serverSearches: null } },
    { type: 'reserved', attemptId: unknownId, timestamp, query: 'unknown-before-crash' },
  ];
  await mkdir(f.directory, { recursive: true });
  await writeFile(f.ledgerPath, oldEntries.map(event => JSON.stringify(event)).join('\n') + '\n');
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('connection lost after send'); };
  await assert.rejects(searchDeepSeek(f.config, 'new-unknown', undefined, fetcher), /请求失败或超时/);
  await assert.rejects(searchDeepSeek(f.config, 'next', undefined, fetcher), /预算已用尽/);
  assert.equal(calls, 1);
  const entries = await f.entries();
  assert.deepEqual(entries.slice(0, 3), oldEntries);
  assert.equal(entries.filter(event => event.type === 'reserved').length, 3);
  assert.equal(entries.filter(event => event.type === 'failed').length, 1);
  assert.ok(!entries.some(event => event.attemptId === unknownId && event.type !== 'reserved'));
});

test('等待跨进程预算短锁时可取消，取消不发送也不预约', { timeout: 10000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  const lock = await acquireConversationLock(f.config.dataDir, 'web-search-budget:shared');
  try {
    let calls = 0;
    const pending = searchDeepSeek(f.config, 'cancel-lock-wait', controller.signal, async () => { calls++; return response(); });
    const rejected = assert.rejects(pending, /已取消/);
    await delay(30);
    controller.abort();
    await rejected;
    assert.equal(calls, 0);
    await assert.rejects(readFile(f.ledgerPath), { code: 'ENOENT' });
  } finally { await lock.release(); }
  await searchDeepSeek(f.config, 'after-cancel', undefined, async () => response());
  assert.equal((await f.entries()).filter(event => event.type === 'completed').length, 1);
});
