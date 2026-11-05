import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startPublisher } from '../scripts/deployment/pa-publisher.mjs';

test('publisher freezes exact repair, waits for sent acknowledgement, and resumes a running release once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pa-publisher-'));
  const socket = name => process.platform === 'win32' ? `\\\\.\\pipe\\pa-publisher-${name}-${randomUUID()}` : join(root, name + '.sock');
  const taskId = randomUUID(), owner = 'a'.repeat(64), sourceSha = 'b'.repeat(40);
  const source = join(root, 'release'), workerDirectory = join(root, 'worker'), directory = join(root, 'publisher');
  await mkdir(source); await writeFile(join(source, 'RELEASE_SHA'), sourceSha);
  const result = join(workerDirectory, 'results', taskId + '-1'); await mkdir(result, { recursive: true });
  const diff = 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+fixed\n';
  await writeFile(join(result, 'diff.txt'), diff);
  let latestRevision = 1, attempts = 0, server;
  const task = { id: taskId, owner, source, revision: 1, mode: 'fix', status: 'completed', diff };
  const workerSocket = socket('worker');
  const worker = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('owner'), owner);
    res.end(JSON.stringify({ ...task, revision: url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : latestRevision }));
  });
  await new Promise(resolve => worker.listen(workerSocket, resolve));
  const config = { directory, socket: socket('publisher'), owner, workerDirectory, workerSocket, current: source };
  const call = (path, body) => new Promise((accept, reject) => {
    const req = request({ socketPath: config.socket, path, method: body ? 'POST' : 'GET' }, res => {
      const chunks = []; res.on('data', part => chunks.push(part)); res.on('end', () => accept({ code: res.statusCode, value: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const execute = async path => {
    attempts++;
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sourceSha, sourceSha); assert.equal(await readFile(join(path, 'patch.diff'), 'utf8'), diff);
    return { status: 'succeeded', summary: '已上线，QQ 已恢复。', commit: 'c'.repeat(40) };
  };
  try {
    server = await startPublisher(config, execute);
    const {createHash} = await import('node:crypto');
    const input = { owner, taskId, revision: 1, requestId: 'original-qq-confirm', patchSha256:createHash('sha256').update(diff).digest('hex') };
    const prepared = await call('/releases', input);
    assert.equal(prepared.code, 202); assert.equal(prepared.value.status, 'prepared'); assert.equal(attempts, 0);
    assert.equal((await call('/releases', input)).value.id, prepared.value.id);
    assert.equal((await call('/releases', { ...input, revision: 2 })).code, 400);
    assert.equal((await call('/releases?owner=other')).code, 403);
    latestRevision = 2;
    assert.equal((await call('/releases/' + prepared.value.id + '/start', { owner, requestId: input.requestId })).code, 400);
    assert.equal(attempts, 0); latestRevision = 1;
    await writeFile(join(result, 'diff.txt'), diff + '\nchanged after report');
    assert.equal((await call('/releases/' + prepared.value.id + '/start', { owner, requestId: input.requestId })).code, 400);
    await writeFile(join(result, 'diff.txt'), diff);
    const queued = await Promise.all([1, 2].map(() => call('/releases/' + prepared.value.id + '/start', { owner, requestId: input.requestId })));
    assert.ok(queued.every(response => response.code === 202));
    for (let i = 0; i < 100; i++) {
      const record = (await call('/releases?owner=' + owner + '&requestId=' + input.requestId)).value.releases[0];
      if (record.status === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(attempts, 1);
    await call('/releases/' + prepared.value.id + '/start', { owner, requestId: input.requestId });
    assert.equal(attempts, 1);
    await server.close();
    const ledger = JSON.parse(await readFile(join(directory, 'releases.json'), 'utf8'));
    ledger.releases[0].status = 'running';
    await writeFile(join(directory, 'releases.json'), JSON.stringify(ledger));
    server = await startPublisher(config, async path => { attempts++; assert.ok(path.endsWith(prepared.value.id)); return { status: 'rolled_back', summary: '已恢复旧版，QQ 已恢复。' }; });
    const resumed = await call('/releases?owner=' + owner + '&requestId=' + input.requestId);
    assert.equal(resumed.value.releases[0].status, 'rolled_back'); assert.equal(attempts, 2);
  } finally { await server?.close(); await new Promise(resolve => worker.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
