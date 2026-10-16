import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openConversation } from '../dist/runtime.js';

test('实际模型请求按准备和回答阶段工作，固定提示不再指导旧工具调用', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-prompt-workflow-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const call = requests.length === 1;
    const delta = call
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'prepare', type: 'function',
        function: { name: 'prepare_turn', arguments: JSON.stringify({ intent: 'social', mode: 'standard', updates: [] }) } }] }
      : { role: 'assistant', content: '你好！' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, reason] of [[delta, null], [{}, call ? 'tool_calls' : 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{ index: 0, delta: part, finish_reason: reason }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = await openConversation({ cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture',
    model: 'fixture', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}`,
    contextWindow: 32768, maxOutputTokens: 512, timeoutMs: 3000 }, 'test');
  t.after(async () => {
    await runtime.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const answer = await runtime.prompt('你好', { runId: 'prompt-check', companionTools: {
    prepareTurn: plan => ({ prepared: true, mode: plan.mode, saved: [] }),
    updateProfile: () => { throw new Error('unexpected profile tool'); },
    readHistory: () => [],
  } });

  assert.equal(answer, '你好！');
  assert.equal(requests.length, 2);
  const systemText = requests.map(request => request.messages.filter(message => message.role === 'system')
    .map(message => message.content).join('\n')).join('\n');
  assert.match(systemText, /prepare_turn/);
  assert.match(systemText, /资料写入已关闭/);
  assert.doesNotMatch(systemText, /update_profile|answer_in_depth|调用read_history/);
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['prepare_turn']);
  assert.ok(!requests[1].tools.some(tool => ['prepare_turn', 'update_profile', 'answer_in_depth'].includes(tool.function.name)));
});
