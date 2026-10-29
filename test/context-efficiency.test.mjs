import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ImageAssets, ImageAssetError } from '../dist/image-assets.js';
import { ContextTokenEstimator, contextFootprint } from '../dist/context-tokens.js';
import { DiagnosticLog } from '../dist/diagnostics.js';
import { openRecordedConversation, PersistenceError } from '../dist/conversation.js';
import { ConversationStore } from '../dist/store.js';
import { validateExtract } from '../dist/auto-memory.js';
import { currentMessage, isPreparationRequest, preparationDelta } from './fixtures/turn-preparation.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const key = 'a'.repeat(64);
const usage = { input: 200, output: 10, cacheRead: 100, cacheWrite: 0, totalTokens: 310 };

async function assertLegacyImageRejection(dataDir) {
  const original = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]);
  const imageId = crypto.createHash('sha256').update(original).digest('hex');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const read = currentMessage(body)?.text.includes('取旧图')
      && !body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'read-legacy');
    const delta = isPreparationRequest(body) ? preparationDelta(`prepare-${requests.length}`)
      : read ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-legacy', type: 'function', function: {
        name: 'read_image', arguments: JSON.stringify({ imageId }),
      } }] } : { role: 'assistant', content: 'LOCAL_ANSWER' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, reason] of [[delta, null], [{}, delta.tool_calls ? 'tool_calls' : 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: part, finish_reason: reason }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let conversation;
  try {
    const config = { cwd: dataDir, dataDir, provider: 'bailian', model: 'deepseek-v4.1-flash-1017', apiKey: 'offline',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 250000, maxOutputTokens: 512, timeoutMs: 5000 };
    const route = { channel: 'fixture', accountId: 'bot', roomId: 'room', roomType: 'group' };
    conversation = await openRecordedConversation(config, 'legacy-image', route);
    const imagePath = join(dataDir, 'images', `${imageId}.bin`);
    fs.mkdirSync(join(dataDir, 'images'), { recursive: true }); fs.writeFileSync(imagePath, original);
    conversation.ingest('旧模型保存的原图', { eventId: 'old-image', senderId: 'sender', modelInputText: '旧模型保存的原图', images: [{ imageId,
      fileId: 'file-api-legacy', mimeType: 'image/png', bytes: original.length, width: 1, height: 1, tokenEstimate: 1024 }] });
    // Archive the source through the existing compression contract, so read_image
    // accesses the retained original without adding it to every current payload.
    const store = new ConversationStore(join(dataDir, 'pa.sqlite'));
    try {
      const room = store.ensureConversation('legacy-image', conversation.info().sessionFile, route);
      store.autoMemory.reserveBatch(room.id, 'capacity');
      const job = store.autoMemory.claimNext(room.id, { owner: 'fixture', leaseMs: 60000 });
      const frozen = store.autoMemory.taskInput(job);
      store.autoMemory.commit(job.id, job.leaseToken, validateExtract({ topics: [], profiles: [], fragments: [],
        ignoredMessageIds: frozen.extractionProtocol === 2 ? [] : frozen.messages.filter(message => message.role === 'user').map(message => message.id),
        continuationSummary: `旧原图仍保留 imageId=${imageId}` }, frozen));
    } finally { store.close(); }
    const prompt = (eventId, text) => conversation.prompt(text, { eventId, senderId: 'sender', modelInputText: text });
    const oversized = await prompt('oversized', '取旧图');
    assert.equal(oversized.text, 'LOCAL_ANSWER');
    conversation.acknowledge(oversized.deliveryId, 'sent', 'reply-oversized');
    const rejection = requests[2].messages.find(message => message.role === 'tool' && message.tool_call_id === 'read-legacy');
    assert.match(rejection.content, /tool_request_rejected/);
    assert.match(rejection.content, /图片超过大小或尺寸限制/);
    const next = await prompt('next', '继续普通问答');
    assert.equal(next.text, 'LOCAL_ANSWER');
    conversation.acknowledge(next.deliveryId, 'sent', 'reply-next');
    const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1; fs.writeFileSync(imagePath, corrupt);
    await assert.rejects(prompt('corrupt', '取旧图（原图已损坏）'), error =>
      error instanceof PersistenceError && /图片持久化或读取失败/.test(error.message));
    assert.throws(() => conversation.history(), PersistenceError);
    assert.equal(requests.length, 7, 'rejected image is recoverable; corrupt original halts without another provider call');
  } finally {
    await conversation?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('百炼只读一次且payload相同，旧大图可纠正并继续会话，损坏原图仍停止', async t => {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'pa-image-once-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const imageId = crypto.createHash('sha256').update(png).digest('hex');
  const originalPath = join(dataDir, 'images', `${imageId}.bin`);
  fs.mkdirSync(join(dataDir, 'images'));
  fs.writeFileSync(originalPath, png);
  const assets = new ImageAssets({ dataDir, provider: 'bailian', model: 'deepseek-v4.1-flash-1017', apiKey: 'offline' });
  const expected = assets.content(assets.get(imageId));
  const originalRead = fs.readFileSync;
  let reads = 0;
  try {
    fs.readFileSync = (...args) => { reads++; return originalRead(...args); };
    syncBuiltinESMExports();
    const loaded = assets.loadContent(imageId);
    assert.deepEqual(loaded.content, expected);
    assert.equal(loaded.image.imageId, imageId);
    assert.equal(loaded.image.bytes, png.length);
    assert.equal(reads, 1);
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  const corrupt = Buffer.from(png); corrupt[corrupt.length - 1] ^= 1;
  fs.writeFileSync(originalPath, corrupt);
  assert.throws(() => assets.loadContent(imageId), error => error instanceof ImageAssetError && error.code === 'persistence');
  assert.equal(assets.loadContent('b'.repeat(64)), undefined);
  await assertLegacyImageRejection(join(dataDir, 'conversation'));
});

test('同次准备和三种回答估算复用分片hash，v1/v2上界与原分片完全相同', () => {
  const history = Array.from({ length: 300 }, (_, i) => JSON.stringify({ id: i, text: `历史${i}:` + 'abcdef'.repeat(100) })).join('\n');
  const payloads = ['prepare', 'casual', 'standard', 'professional'].map(mode => ({ model: 'fixture',
    messages: [{ role: 'system', content: mode === 'prepare' ? '准备协议' : '全部固定回答协议' },
      { role: 'user', content: history }, { role: 'user', content: JSON.stringify({ mode }) }], tools: [] }));
  const before = JSON.stringify(payloads);
  const estimator = new ContextTokenEstimator(key);
  assert.equal(estimator.learn(estimator.metadata(payloads[0]), usage), true);
  const expectedEstimates = payloads.map(payload => estimator.estimate(payload));
  const originalHash = crypto.createHash;
  let hashes = 0;
  try {
    crypto.createHash = (...args) => { hashes++; return originalHash(...args); };
    syncBuiltinESMExports();
    for (const version of [1, 2]) {
      hashes = 0;
      const expected = payloads.map(payload => contextFootprint(payload, version));
      const baselineHashes = hashes;
      hashes = 0;
      const cache = new Map();
      const actual = payloads.map(payload => contextFootprint(payload, version, cache));
      assert.deepEqual(actual, expected);
      assert.ok(hashes < baselineHashes / 2, `${version}: ${hashes} cached / ${baselineHashes} original hashes`);
    }
    const cache = new Map();
    assert.deepEqual(payloads.map(payload => estimator.estimate(payload, cache)), expectedEstimates);
    assert.equal(JSON.stringify(payloads), before);
  } finally { crypto.createHash = originalHash; syncBuiltinESMExports(); }
});

test('旧v1诊断索引增补校准索引，冷key查询使用索引且不改历史正文', t => {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'pa-calibration-index-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const directory = join(dataDir, 'diagnostics'); fs.mkdirSync(directory);
  const path = join(directory, 'index.sqlite');
  const db = new DatabaseSync(path);
  const metadata = new ContextTokenEstimator(key).metadata({ messages: [{ role: 'user', content: 'history' }] });
  const record = { callId: crypto.randomUUID(), kind: 'chat', status: 'completed', usageSource: 'sdk-normalized',
    contextCalibration: metadata, usage };
  const raw = JSON.stringify(record);
  try {
    db.exec(`PRAGMA user_version=1;
      CREATE TABLE calls(call_id TEXT PRIMARY KEY, job_id TEXT, task_id TEXT, trace_id TEXT, record_json TEXT);
      CREATE TABLE events(id TEXT PRIMARY KEY, event_json TEXT);
      CREATE INDEX calls_trace ON calls(trace_id);`);
    const insert = db.prepare('INSERT INTO calls(call_id, record_json) VALUES (?,?)');
    insert.run(record.callId, raw);
    for (let i = 0; i < 200; i++) insert.run(`other-${i}`, JSON.stringify({ ...record, contextCalibration: { ...metadata, key: 'b'.repeat(64) } }));
  } finally { db.close(); }
  const log = new DiagnosticLog(dataDir);
  assert.deepEqual(log.calibrationCalls(key), [record]);
  const readonly = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(readonly.prepare("SELECT 1 FROM sqlite_master WHERE name='calls_calibration_eligible_v1'").get(), undefined); }
  finally { readonly.close(); }
  log.prepareCalibrationIndex();
  assert.deepEqual(log.calibrationCalls(key), [record]);
  assert.deepEqual(log.calibrationCalls('c'.repeat(64)), []);
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    const plan = check.prepare(`EXPLAIN QUERY PLAN SELECT record_json FROM calls
      WHERE json_extract(record_json,'$.contextCalibration.key')=?
        AND json_extract(record_json,'$.status')='completed'
        AND json_extract(record_json,'$.kind')='chat'
        AND json_extract(record_json,'$.usageSource')='sdk-normalized'
      ORDER BY rowid DESC LIMIT ?`).all('c'.repeat(64), 100);
    assert.match(plan.map(row => row.detail).join('\n'), /SEARCH calls USING INDEX calls_calibration_eligible_v1/);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1);
    assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name='calls_trace'").get());
    assert.equal(check.prepare('SELECT record_json FROM calls WHERE call_id=?').get(record.callId).record_json, raw);
  } finally { check.close(); }
  const absent = join(dataDir, 'absent');
  assert.deepEqual(new DiagnosticLog(absent).calibrationCalls(key), []);
  assert.equal(fs.existsSync(absent), false);
});
