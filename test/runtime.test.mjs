import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { openConversation } from '../dist/runtime.js';

const runtimeUrl = pathToFileURL(join(import.meta.dirname, '../dist/runtime.js')).href;

async function child(code, config, conversationId, env = {}) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e',
    `import { openConversation } from ${JSON.stringify(runtimeUrl)};
     const config = JSON.parse(process.argv[1]); const id = process.argv[2]; ${code}`,
    JSON.stringify(config), conversationId], {
    env: { ...globalThis.process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  process.stdout.on('data', (data) => { stdout += data; });
  process.stderr.on('data', (data) => { stderr += data; });
  const exitCode = await new Promise((resolve, reject) => {
    process.on('error', reject); process.on('close', resolve);
  });
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(stdout);
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-runtime-'));
  const cwd = join(directory, 'project');
  await mkdir(cwd);
  const requests = [];
  const hanging = new Set();
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ body, url: request.url, authorization: request.headers.authorization });
      const asText = (content) => typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('');
      const text = asText(body.messages.findLast((message) => message.role === 'user')?.content ?? '');
      if (text === 'error') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'local model failure', type: 'server_error' } }));
        return;
      }
      if (text === 'hang') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        hanging.add(response);
        response.on('close', () => { hanging.delete(response); });
        return;
      }
      const users = body.messages.filter((message) => message.role === 'user').map((message) => asText(message.content));
      const answer = `reply:${users.join('|')}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choices of [
        [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        [{ index: 0, delta: { content: answer }, finish_reason: null }],
        [{ index: 0, delta: {}, finish_reason: text === 'length' ? 'length' : 'stop' }],
      ]) response.write(`data: ${JSON.stringify({ id: 'local-response', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(500); response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    cwd, dataDir: join(directory, 'data'), provider: 'pa-test', model: 'test-model',
    apiKey: 'local-test-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    contextWindow: 32768, maxOutputTokens: 512, timeoutMs: 5000, ...options,
  };
  const runtimes = [];
  async function conversation(id, overrides = {}) {
    const runtime = await openConversation({ ...config, ...overrides }, id);
    runtimes.push(runtime); return runtime;
  }
  t.after(async () => {
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { config, conversation, requests, hanging, directory };
}

test('真实 Pi SDK 多轮持久化、进程重启恢复与不同会话隔离', async (t) => {
  const f = await fixture(t);
  const a = await f.conversation('../../用户 A');
  assert.deepEqual(a.info().tools, []);
  assert.equal(a.info().messageCount, 0);
  assert.equal(await a.prompt('one'), 'reply:one');
  assert.equal(await a.prompt('two'), 'reply:one|two');
  const before = a.info();
  assert.equal(before.messageCount, 4);
  const expectedDirectory = join(f.config.dataDir, createHash('sha256').update('../../用户 A').digest('hex'));
  assert.equal(before.sessionFile, join(expectedDirectory, 'session.jsonl'));
  assert.doesNotMatch(await readFile(before.sessionFile, 'utf8'), /local-test-key/);
  assert.deepEqual((await readdir(expectedDirectory)).sort(), ['conversation.lock', 'session.jsonl']);
  const b = await f.conversation('用户 B');
  assert.equal(await b.prompt('other'), 'reply:other');
  assert.notEqual(a.info().sessionId, b.info().sessionId);
  await a.close();
  const restarted = await child(`
    const runtime = await openConversation(config, id);
    try { const before = runtime.info(); const answer = await runtime.prompt('three');
      console.log(JSON.stringify({ before, answer, after: runtime.info() })); }
    finally { await runtime.close(); }`, f.config, '../../用户 A');
  assert.equal(restarted.before.sessionId, before.sessionId);
  assert.equal(restarted.before.sessionFile, before.sessionFile);
  assert.equal(restarted.before.messageCount, 4);
  assert.equal(restarted.answer, 'reply:one|two|three');
  assert.equal(restarted.after.messageCount, 6);
  assert.equal(f.requests.length, 4);
  for (const request of f.requests) {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.authorization, 'Bearer local-test-key');
    assert.equal(request.body.model, 'test-model');
    assert.ok(!request.body.tools || request.body.tools.length === 0);
    assert.ok(request.body.max_tokens <= 512 || request.body.max_completion_tokens <= 512);
    const system = request.body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    assert.match(system, /不假造记忆/);
    assert.doesNotMatch(system, /expert coding assistant|Pi documentation/);
  }
});

test('空会话关闭重开不创建伪造的持久化文件', async (t) => {
  const f = await fixture(t);
  const empty = await f.conversation('empty');
  const file = empty.info().sessionFile;
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await empty.close(); await empty.close();
  const reopened = await f.conversation('empty');
  assert.equal(reopened.info().sessionFile, file);
  assert.equal(reopened.info().messageCount, 0);
  assert.equal(await reopened.prompt('first'), 'reply:first');
});

test('项目与模拟全局资源、认证、settings 均不会自动加载', async (t) => {
  const f = await fixture(t);
  const fakeGlobal = join(f.directory, 'fake-global');
  for (const root of [f.config.cwd, fakeGlobal, join(f.config.cwd, '.pi')]) {
    await mkdir(join(root, 'extensions'), { recursive: true });
    await mkdir(join(root, 'skills', 'unwanted'), { recursive: true });
    await mkdir(join(root, 'prompts'), { recursive: true });
    await mkdir(join(root, 'themes'), { recursive: true });
    for (const name of ['AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'])
      await writeFile(join(root, name), 'RESOURCE_SENTINEL');
    await writeFile(join(root, 'settings.json'), '{broken global settings');
    await writeFile(join(root, 'auth.json'), '{broken global auth');
    await writeFile(join(root, 'models.json'), '{broken global models');
    await writeFile(join(root, 'extensions', 'bad.ts'), 'throw new Error("RESOURCE_SENTINEL");');
    await writeFile(join(root, 'skills', 'unwanted', 'SKILL.md'), '---\nname: unwanted\ndescription: RESOURCE_SENTINEL\n---\nRESOURCE_SENTINEL');
    await writeFile(join(root, 'prompts', 'unwanted.md'), 'RESOURCE_SENTINEL');
    await writeFile(join(root, 'themes', 'broken.json'), '{broken theme');
  }
  const result = await child(`const runtime = await openConversation(config, id);
    try { console.log(JSON.stringify({ answer: await runtime.prompt('/unwanted'), info: runtime.info() })); }
    finally { await runtime.close(); }`, f.config, 'resource-test', { PI_CODING_AGENT_DIR: fakeGlobal });
  assert.equal(result.answer, 'reply:/unwanted');
  assert.deepEqual(result.info.tools, []);
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(f.requests[0].body), /RESOURCE_SENTINEL/);
  assert.deepEqual((await readdir(fakeGlobal)).sort(), ['AGENTS.md', 'APPEND_SYSTEM.md', 'SYSTEM.md', 'auth.json', 'extensions', 'models.json', 'prompts', 'settings.json', 'skills', 'themes'].sort());
});

test('模型错误没有重试、不会把上一轮文本当作当前回复，超时后可继续', async (t) => {
  const f = await fixture(t);
  const runtime = await f.conversation('errors', { timeoutMs: 400 });
  assert.equal(await runtime.prompt('good'), 'reply:good');
  await assert.rejects(runtime.prompt('error'), /模型请求失败.*local model failure/);
  assert.equal(f.requests.length, 2);
  await assert.rejects(runtime.prompt('hang'), /模型请求超时/);
  assert.equal(f.requests.length, 3);
  assert.equal(await runtime.prompt('recovered'), 'reply:good|error|hang|recovered');
  assert.equal(f.requests.length, 4);
});

test('拒绝并发 prompt；close 中止活动请求、释放进程锁且多次关闭安全', async (t) => {
  const f = await fixture(t);
  const runtime = await f.conversation('close');
  const pending = runtime.prompt('hang');
  const rejected = assert.rejects(pending, /取消|失败/);
  await assert.rejects(runtime.prompt('parallel'), /正在处理/);
  const deadline = Date.now() + 2000;
  while (!f.hanging.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.hanging.size, 1);
  await Promise.all([runtime.close(), runtime.close()]);
  await rejected;
  await assert.rejects(runtime.prompt('after-close'), /已关闭/);
  const reopened = await f.conversation('close');
  assert.equal(await reopened.prompt('after'), 'reply:hang|after');
});

test('输出 length 截断不触发自动压缩或追加模型请求', async (t) => {
  const f = await fixture(t);
  const runtime = await f.conversation('length');
  assert.equal(await runtime.prompt('length'), 'reply:length');
  assert.equal(f.requests.length, 1);
  await runtime.close();
  assert.equal(f.requests.length, 1);
});

test('文件锁阻止其他进程修改同一会话，其他会话仍可打开', async (t) => {
  const f = await fixture(t);
  const runtime = await f.conversation('locked');
  const result = await child(`try { const runtime = await openConversation(config, id);
      await runtime.close(); throw new Error('lock unexpectedly succeeded'); }
    catch (error) { console.log(JSON.stringify({ message: error.message })); }`, f.config, 'locked');
  assert.match(result.message, /已被锁定/);
  const other = await f.conversation('other');
  assert.equal(await other.prompt('allowed'), 'reply:allowed');
  await runtime.close();
  const unlocked = await f.conversation('locked');
  assert.equal(await unlocked.prompt('allowed too'), 'reply:allowed too');
});

test('已有空文件、截断 JSONL 或缺头会话报错并保留原数据', async (t) => {
  const f = await fixture(t);
  for (const [id, content] of [['zero', ''], ['truncated', '{"type":"session"'], ['no-header', '{"type":"message","id":"a"}\n']]) {
    const runtime = await f.conversation(id);
    const file = runtime.info().sessionFile;
    await runtime.close();
    await writeFile(file, content);
    await assert.rejects(f.conversation(id), /会话文件损坏/);
    assert.equal(await readFile(file, 'utf8'), content);
    // Failure cleanup releases the lock so a subsequent diagnostic attempt also reports corruption.
    await assert.rejects(f.conversation(id), /会话文件损坏/);
  }
});

test('有效 JSON 中消息结构、内容或父记录损坏时拒绝恢复并保留原文件', async (t) => {
  const f = await fixture(t);
  const cases = [
    ['bad-message', 'user', (entry) => { delete entry.message; }],
    ['bad-parent', 'user', (entry) => { entry.parentId = 'missing-parent'; }],
    ...['user', 'system', 'assistant'].map((role) => [`null-${role}`, role, (entry) => { entry.message.content = null; }]),
    ['missing-content', 'user', (entry) => { delete entry.message.content; }],
    ...[123, true, {}].map((value, index) => [`bad-content-${index}`, 'user', (entry) => { entry.message.content = value; }]),
    ...[null, {}, [], { type: 'text', text: 123 }, { type: 'image', data: null, mimeType: 'image/png' },
      { type: 'image', data: 'a', mimeType: 123 }, { type: 'unknown', text: 'lost' }]
      .map((value, index) => [`bad-block-${index}`, 'user', (entry) => { entry.message.content = [value]; }]),
    ['bad-thinking', 'assistant', (entry) => { entry.message.content = [{ type: 'thinking', thinking: null }]; }],
    ['bad-tool-call', 'assistant', (entry) => { entry.message.content = [{ type: 'toolCall', id: 'a', name: 'b', arguments: null }]; }],
  ];
  for (const [id, role, mutate] of cases) {
    const runtime = await f.conversation(id);
    await runtime.prompt('saved');
    const file = runtime.info().sessionFile;
    await runtime.close();
    const entries = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    const message = entries.find((entry) => entry.type === 'message' && entry.message.role === role);
    mutate(message);
    const changed = entries.map(JSON.stringify).join('\n') + '\n';
    await writeFile(file, changed);
    await assert.rejects(f.conversation(id), /会话文件损坏/);
    assert.equal(await readFile(file, 'utf8'), changed);
    await assert.rejects(f.conversation(id), /会话文件损坏/);
    assert.equal(await readFile(file, 'utf8'), changed);
  }
});

test('无 base URL 时严格查询内置目录并且不请求本地或远程模型', async (t) => {
  const f = await fixture(t);
  const { baseUrl: _, ...builtinConfig } = f.config;
  await assert.rejects(openConversation(builtinConfig, 'invalid-model'), /内置模型目录中没有/);
  const known = await openConversation({ ...builtinConfig, provider: 'openai', model: 'gpt-4o' }, 'known-model');
  try { assert.equal(known.info().model, 'gpt-4o'); assert.deepEqual(known.info().tools, []); }
  finally { await known.close(); }
  assert.equal(f.requests.length, 0);
});

test('内置模型的输出上限也传入真实 SDK 的 HTTP 请求', async (t) => {
  const f = await fixture(t);
  const { baseUrl: localUrl, ...config } = f.config;
  const result = await child(`
    const localFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (url !== 'https://api.ant-ling.com/v1/chat/completions') throw new Error('Unexpected network URL: ' + url);
      return localFetch(process.env.PA_TEST_LOCAL_URL + '/chat/completions', init);
    };
    const runtime = await openConversation(config, id);
    try { console.log(JSON.stringify({ answer: await runtime.prompt('capped') })); }
    finally { await runtime.close(); }
  `, { ...config, provider: 'ant-ling', model: 'Ling-2.6-flash', maxOutputTokens: 37 }, 'builtin-cap', { PA_TEST_LOCAL_URL: localUrl });
  assert.equal(result.answer, 'reply:capped');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.max_tokens ?? f.requests[0].body.max_completion_tokens, 37);
});
