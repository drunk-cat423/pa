import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openConversation, RequestError } from '../dist/runtime.js';
import { MemoryError } from '../dist/memory-types.js';
import { preparationDelta } from './fixtures/turn-preparation.mjs';

const call = (name, args) => ({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${name}`, type: 'function',
  function: { name, arguments: JSON.stringify(args) } }] });
const params = { key: 'medicine', goal: '吃药', remindAt: '2026-10-27T09:00:00+08:00', timezone: 'Asia/Shanghai' };
const sourceText = '明天早上九点提醒我吃药';
const confirmation = '已安排：北京时间2026年10月27日09:00，在原会话提醒你吃药。';
const context = reminders => ({ prepareTurn: plan => ({ prepared: true, mode: plan.mode, saved: [] }),
  readHistory: () => [], reminders });

async function fixture(t, respond, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-reminder-runtime-')), requests = [], errors = [], runtimes = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw); requests.push(body);
      const delta = await respond(body, requests.length);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [value, finish_reason] of [[delta, null], [{}, delta.tool_calls ? 'tool_calls' : 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'fixture', model: body.model,
          choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture', apiKey: 'fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 131072, maxOutputTokens: 1024,
    timeoutMs: 5000, loop: { maxModelCalls: 6, maxToolCalls: 8 }, ...overrides };
  t.after(async () => {
    await Promise.allSettled(runtimes.map(runtime => runtime.close())); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return { requests, dataDir:config.dataDir, async open(id, options = { enableSearch: true }) {
    const runtime = await openConversation(config, id, options); runtimes.push(runtime); return runtime;
  } };
}

test('提醒拒绝不确认成功，已保存画像也不能授权无回执的未来提醒承诺', async t => {
  const f = await fixture(t, (body, n) => {
    if (n === 1) return preparationDelta('prepare');
    if (n === 2) return call('create_reminder', params);
    if (n === 3) { assert.match(JSON.stringify(body.messages), /本次提醒被拒绝/); return { role: 'assistant', content: '我会提醒你吃药。' }; }
    assert.equal(n, 4); assert.equal(body.tool_choice, 'none');
    return { role: 'assistant', content: '这次提醒没有安排成功。' };
  });
  const runtime = await f.open('rejected');
  const tools = context({ execute() { throw new MemoryError('本次提醒被拒绝：原文没有有效授权。'); } });
  tools.prepareTurn = plan => ({ prepared: true, mode: plan.mode, saved: [{ target: 'sender', status: 'saved' }] });
  assert.equal(await runtime.prompt(sourceText, { runId: 'run-rejected', companionTools: tools }), '这次提醒没有安排成功。');
  assert.equal(f.requests.length, 4);
});

test('提醒已保存后取消本轮请求，RequestError保留实际成功确认', async t => {
  const f = await fixture(t, (_body, n) => n === 1 ? preparationDelta('prepare') : call('create_reminder', params));
  const runtime = await f.open('cancel-after-save');
  await assert.rejects(runtime.prompt(sourceText, { runId: 'cancel-after-save', companionTools: context({
    execute() {
      // Cancel after the synchronous saved receipt has reached the tool, before Pi finishes its turn.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { void runtime.abort(); })));
      return { saved: true, id: 'reminder-1', remindAt: params.remindAt, goal: params.goal, confirmation };
    } }) }), error => error instanceof RequestError && error.kind === 'cancelled'
    && assert.deepEqual(error.confirmedActions, [confirmation]) === undefined);
  assert.equal(f.requests.length, 2);
});
