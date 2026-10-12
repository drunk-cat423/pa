import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('实际 CLI 多轮输入、管理指令、退出及重启恢复', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-cli-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const users = body.messages.filter(message => message.role === 'user')
      .map(message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join(''));
    const answer = users.join('|');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'cli-test', object: 'chat.completion.chunk', model: 'cli-model', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'cli-test', object: 'chat.completion.chunk', model: 'cli-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    PA_PROVIDER: 'cli-local', PA_MODEL: 'cli-model', PA_API_KEY: 'cli-test-only-key',
    PA_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, PA_DATA_DIR: dataDir,
    PA_CONTEXT_WINDOW: '32768', PA_MAX_OUTPUT_TOKENS: '2048', PA_TIMEOUT_MS: '10000',
  };
  async function run(args, input = '', overrides = {}, interruptOutput = false) {
    const cliUrl = pathToFileURL(join(process.cwd(), 'dist/cli.js')).href;
    const launch = interruptOutput ? ['--input-type=module', '-e', `
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (text, callback) => {
        if (String(text).trim() === 'signal-output') {
          return originalWrite(text, error => {
            process.emit('SIGINT');
            setTimeout(() => callback(error), 30);
          });
        }
        return originalWrite(text, callback);
      };
      process.argv = [process.execPath, 'dist/cli.js', ...${JSON.stringify(args)}];
      await import(${JSON.stringify(cliUrl)});
    `] : ['dist/cli.js', ...args];
    const child = spawn(process.execPath, launch, { cwd: process.cwd(), env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 25000);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.end(input);
    try {
      const status = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      assert.equal(status, interruptOutput ? 130 : 0, stderr);
      assert.ok(!stdout.includes(env.PA_API_KEY));
      assert.ok(!stderr.includes(env.PA_API_KEY));
      return stdout;
    } finally { clearTimeout(timer); }
  }
  const first = await run(['--conversation', 'owner'], 'alpha\nbeta\n/info\n/help\n/exit\n');
  assert.match(first, /伙伴 > alpha\s/);
  assert.match(first, /伙伴 > alpha\|beta/);
  assert.match(first, /"tools": \[\]/);
  assert.match(first, /"messageCount": 4/);
  const resumed = await run(['--conversation', 'owner', '--message', 'gamma']);
  assert.match(resumed, /alpha\|beta\|gamma/);
  const other = await run(['--conversation', 'another', '--message', 'delta']);
  assert.equal(other.trim(), 'delta');
  const history = JSON.parse(await run(['history', '--conversation', 'owner'], '', {
    PA_PROVIDER: '', PA_MODEL: '', PA_API_KEY: '',
  }));
  assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(history.filter(message => message.role === 'user').map(message => message.text), ['alpha', 'beta', 'gamma']);
  assert.ok(history.filter(message => message.role === 'assistant').every(message => message.deliveryStatus === 'sent'));
  const limited = JSON.parse(await run(['history', '--conversation', 'owner', '--limit', '2'], '', {
    PA_PROVIDER: '', PA_MODEL: '', PA_API_KEY: '',
  }));
  assert.deepEqual(limited.map(message => message.text), ['gamma', 'alpha|beta|gamma']);
  const anotherHistory = JSON.parse(await run(['history', '--conversation', 'another']));
  assert.equal(anotherHistory.length, 2);
  assert.ok(anotherHistory.every(message => message.text === 'delta'));
  await run(['--conversation', 'signal', '--message', 'signal-output'], '', {}, true);
  const signalHistory = JSON.parse(await run(['history', '--conversation', 'signal']));
  assert.equal(signalHistory.at(-1).deliveryStatus, 'sent');
  assert.equal(requests.length, 5);
});
