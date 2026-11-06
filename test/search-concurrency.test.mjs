import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
