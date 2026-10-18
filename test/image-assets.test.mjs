import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ImageAssets, ImageAssetError, IMAGE_MAX_BYTES } from '../dist/image-assets.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const imageId = createHash('sha256').update(png).digest('hex');
async function config() {
  return { cwd: process.cwd(), dataDir: await mkdtemp(join(tmpdir(), 'pa-images-')), provider: 'deepseek', model: 'deepseek-flash',
    apiKey: 'private-model-key', baseUrl: 'https://api.deepseek.com', contextWindow: 1_000_000, maxOutputTokens: 1024, timeoutMs: 5000 };
}
const rejected = (promise, code) => assert.rejects(promise, error => error instanceof ImageAssetError && error.code === code);

test('concurrent references and restarts reuse a stable file handle; QQ receives no model key and metadata contains no signed URLs', async () => {
  const cfg = await config();
  let downloads = 0, uploads = 0;
  const fetch = async (input, options) => {
    const url = new URL(input);
    assert.equal(options.redirect, 'error');
    if (url.hostname === 'multimedia.nt.qq.com.cn') {
      downloads++;
      assert.equal(options.headers.Authorization, undefined);
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    assert.equal(url.href, 'https://api.deepseek.com/files');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer private-model-key');
    assert.equal(options.body.get('purpose'), 'user_data');
    assert.equal(options.body.get('file').type, 'image/png');
    assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), png);
    uploads++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ id: `file-api-image-${uploads}` });
  };
  const assets = new ImageAssets(cfg, { fetch });
  const [first, second] = await Promise.all([
    assets.prepare({ url: 'https://multimedia.nt.qq.com.cn/download?rkey=first-private-value' }),
    assets.prepare({ url: 'https://multimedia.nt.qq.com.cn/download?rkey=second-private-value' }),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(first, { imageId, fileId: 'file-api-image-1', mimeType: 'image/png', width: 1, height: 1, bytes: png.length, tokenEstimate: 1024 });
  const restarted = new ImageAssets(cfg, { fetch });
  assert.deepEqual(restarted.get(imageId), first);
  assert.deepEqual(restarted.read(imageId), png);
  assert.deepEqual(await restarted.prepare({ url: 'https://multimedia.nt.qq.com.cn/download?rkey=new-signature' }), first);
  assert.equal(uploads, 1); assert.equal(downloads, 3);
  const files = await readdir(join(cfg.dataDir, 'images'));
  assert.equal(files.length, 2);
  const metadata = await readFile(join(cfg.dataDir, 'images', files.find(file => file.endsWith('.json'))), 'utf8');
  assert.doesNotMatch(metadata, /rkey|signature|private-model-key|qq\.com/);
  assert.equal(new ImageAssets({ ...cfg, apiKey: 'different-account-key' }, { fetch }).get(imageId), undefined);
});

test('untrusted addresses, oversized responses and disguised images never reach the upload endpoint', async () => {
  const cfg = await config();
  let calls = 0;
  const assets = new ImageAssets(cfg, { fetch: async () => { calls++; throw new Error('unexpected'); } });
  for (const url of ['http://127.0.0.1/a', 'https://evil.example/a', 'https://multimedia.nt.qq.com.cn.evil.example/a',
    'https://user:secret@gchat.qpic.cn/a', 'https://gchat.qpic.cn:8443/a', 'file:///etc/passwd', 'https://gchat.qpic.cn/a\nsecret']) {
    await rejected(assets.prepare({ url }), 'source');
  }
  assert.equal(calls, 0);
  await rejected(new ImageAssets({ ...cfg, model: 'deepseek-v4-pro' }, { fetch: async () => { calls++; } }).prepare({ url: 'https://gchat.qpic.cn/a' }), 'unsupported_model');
  const tooWide = Buffer.from(png); tooWide.writeUInt32BE(5000, 16);
  const cases = [
    [() => new Response('redirect', { status: 302, headers: { location: 'http://127.0.0.1/' } }), 'download'],
    [() => new Response('<html>not an image</html>', { headers: { 'content-type': 'image/jpeg' } }), 'format'],
    [() => new Response(png, { headers: { 'content-length': String(IMAGE_MAX_BYTES + 1) } }), 'too_large'],
    [() => new Response(tooWide), 'too_large'],
    [() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(IMAGE_MAX_BYTES + 1)); controller.close(); } })), 'too_large'],
  ];
  for (const [response, code] of cases) {
    let requests = 0;
    const instance = new ImageAssets(cfg, { fetch: async () => { requests++; return response(); } });
    await rejected(instance.prepare({ url: 'https://gchat.qpic.cn/a' }), code);
    assert.equal(requests, 1);
  }
});

test('unknown upload is not retried and does not publish a handle; cancellation does not start a network request', async () => {
  const cfg = await config(); let uploads = 0;
  const assets = new ImageAssets(cfg, { fetch: async input => {
    if (new URL(input).hostname === 'gchat.qpic.cn') return new Response(png);
    uploads++; throw new Error('provider failed with private-model-key and raw query');
  } });
  await assert.rejects(assets.prepare({ url: 'https://gchat.qpic.cn/a?rkey=private-token' }), error => {
    assert.equal(error.code, 'upload');
    assert.doesNotMatch(error.message, /private-model-key|rkey|private-token/);
    return true;
  });
  assert.equal(uploads, 1);
  assert.equal(assets.get(imageId), undefined);
  const controller = new AbortController(); controller.abort();
  await rejected(assets.prepare({ url: 'https://gchat.qpic.cn/a' }, controller.signal), 'cancelled');
  assert.equal(uploads, 1);
});

test('corrupted original and provider metadata fail closed without a new upload', async () => {
  const cfg = await config();
  const assets = new ImageAssets(cfg, { fetch: async input => new URL(input).hostname === 'gchat.qpic.cn'
    ? new Response(png) : Response.json({ id: 'file-api-fixture-image' }) });
  await assets.prepare({ url: 'https://gchat.qpic.cn/a' });
  const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
  await writeFile(join(cfg.dataDir, 'images', imageId + '.bin'), changed);
  assert.throws(() => assets.read(imageId), error => error.code === 'persistence');
  assert.throws(() => assets.get('../escape'), error => error.code === 'persistence');
  const files = await readdir(join(cfg.dataDir, 'images'));
  await writeFile(join(cfg.dataDir, 'images', files.find(file => file.endsWith('.json'))), JSON.stringify({ imageId, fileId: 'wrong-handle' }));
  assert.throws(() => assets.get(imageId), error => error.code === 'persistence');
});
