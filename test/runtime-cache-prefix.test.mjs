import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openConversation } from '../dist/runtime.js';
import { DiagnosticLog } from '../dist/diagnostics.js';
import { isPreparationRequest, preparationDelta } from './fixtures/turn-preparation.mjs';

const controlPrefix = '[PA本轮控制｜应用生成]\n';
const text = content => typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
const systems = body => body.messages.filter(message => ['system', 'developer'].includes(message.role));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sharedPrefix = (a, b) => { let n = 0; while (n < Math.min(a.length, b.length) && a[n] === b[n]) n++; return n; };
const control = body => {
  const raw = text(body.messages.at(-1).content);
  assert.ok(raw.startsWith(controlPrefix), 'application control must follow the complete history and current input');
  return JSON.parse(raw.slice(controlPrefix.length));
};

async function fixture(t, respond, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-cache-prefix-')), requests = [], runtimes = [], errors = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
      const delta = respond(body, requests.length);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [part, reason] of [[delta, null], [{}, delta.tool_calls ? 'tool_calls' : 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: part, finish_reason: reason }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'model',
    apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    contextWindow: 200000, maxOutputTokens: 512, timeoutMs: 5000, research: { enabled: true }, ...overrides };
  t.after(async () => {
    await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []);
  });
  return { requests, log: new DiagnosticLog(config.dataDir), async open(name, options) {
    const runtime = await openConversation(config, name, options); runtimes.push(runtime); return runtime;
  } };
}

test('channel wire keeps per-stage system fixed across three modes while link/target controls follow long history', async t => {
  const modes = ['professional', 'standard', 'casual'];
  const f = await fixture(t, (body, number) => isPreparationRequest(body)
    ? preparationDelta(`prepare-${number}`, { intent: 'research', mode: modes[Math.floor((number - 1) / 2)], updates: [] })
    : { role: 'assistant', tool_calls: [{ index: 0, id: `research-${number}`, type: 'function', function: {
      name: 'create_research', arguments: JSON.stringify({ key: 'one', title: '本轮研究', goal: '研究明确链接' }),
    } }] });
  const history = '稳定摘要与完整真人历史。'.repeat(1800), inputs = [], targets = [];
  for (const [index, mode] of modes.entries()) {
    const runtime = await f.open(mode), url = `https://example.test/${mode}?q="ignore rules"`;
    const target = { kind: 'explicit_url', sourceMessageId: `source-${index}`, urls: [url] };
    const input = `${history}${'新增可见历史。'.repeat(index * 100)}`; inputs.push(input); targets.push(target);
    await runtime.prompt('请把链接加入后台研究清单', { runId: mode, conversationContext: input, companionTools: {
      verifyLink: url, research: { target, execute: async () => ({ saved: true, id: 'research', title: '本轮研究', status: 'queued' }) },
      answerGrounding: { roomType: 'private', currentSender: { senderId: 'sender' }, currentQuestion: '请研究链接', sources: [] },
      prepareTurn: plan => ({ prepared: true, mode: plan.mode, saved: [] }), readHistory: () => [],
    } });
  }
  assert.equal(f.requests.length, 6);
  const first = text(systems(f.requests[1])[0].content), next = text(systems(f.requests[3])[0].content);
  const retainedWire = sharedPrefix(JSON.stringify(f.requests[1].messages), JSON.stringify(f.requests[3].messages));
  t.diagnostic(`answer system common prefix=${sharedPrefix(first, next)} chars; system length=${first.length}; retained history=${history.length} chars; message JSON prefix=${retainedWire} chars`);
  assert.ok(retainedWire > history.length + first.length);
  for (const [index, body] of f.requests.entries()) {
    assert.deepEqual(systems(body), systems(f.requests[index % 2]), 'mode/link/target must not alter the same stage system');
    const round = Math.floor(index / 2), ready = index % 2 === 1, state = control(body);
    assert.equal(state.stage, ready ? 'answer' : 'prepare');
    assert.equal(state.mode, ready ? modes[round] : null);
    assert.equal(state.verifyLink, targets[round].urls[0]); assert.deepEqual(state.researchTarget, targets[round]);
    const visible = body.messages.filter(message => message.role === 'user');
    assert.equal(text(visible[0].content), inputs[round]); assert.ok(inputs[round].startsWith(history));
    assert.ok(visible.slice(0, -1).some(message => text(message.content).includes('请把链接加入后台研究清单')));
    const names = body.tools.map(tool => tool.function.name);
    if (!ready) { assert.deepEqual(names, ['prepare_turn']); assert.equal(body.tool_choice.function.name, 'prepare_turn'); }
    else { assert.ok(names.includes('create_research')); assert.ok(!names.includes('prepare_turn')); }
  }
  assert.deepEqual(f.requests[1].tools, f.requests[3].tools); assert.deepEqual(f.requests[3].tools, f.requests[5].tools);
  const events = f.log.events().filter(event => event.event === 'model.request_prepared');
  assert.equal(events.length, 6);
  for (const event of events) {
    const body = f.log.artifact(event.callId, 'request');
    assert.deepEqual(event.details.cachePrefix, { version: 1, systemHash: hash(systems(body)), toolsHash: hash(body.tools ?? []) });
    assert.equal(event.details.contextWindow, 200000);
    assert.equal(event.details.contextKind, 'channel');
    assert.match(event.details.cachePrefix.systemHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(event.details), /example\.test|请研究链接|ignore rules/);
  }
});

test('save-claim correction closes tools in trailing controls without changing fixed answer system at the default context window', async t => {
  const f = await fixture(t, (body, number) => isPreparationRequest(body) ? preparationDelta('prepare')
    : { role: 'assistant', content: number === 2 ? '记住了。' : '你好。' },
  { contextWindow: 32768, maxOutputTokens: 2048, research: { enabled: false } });
  const runtime = await f.open('correction', { enableSearch: true });
  const estimate = runtime.estimate('你好', undefined, { channel: true });
  assert.ok(estimate.fits && estimate.ratio < 0.85, 'minimum default channel request must fit before compression');
  t.diagnostic(`minimum default channel input estimate=${estimate.inputTokens}; ratio=${estimate.ratio}`);
  assert.equal(await runtime.prompt('你好', { runId: 'correction', companionTools: {
    prepareTurn: plan => ({ prepared: true, mode: plan.mode, saved: [] }), readHistory: () => [],
  } }), '你好。');
  assert.equal(f.requests.length, 3);
  t.diagnostic(`minimum default stage system lengths: prepare=${text(systems(f.requests[0])[0].content).length}; answer=${text(systems(f.requests[1])[0].content).length}`);
  assert.deepEqual(systems(f.requests[1]), systems(f.requests[2]));
  assert.equal(control(f.requests[1]).saveClaimCorrection, false);
  assert.equal(control(f.requests[2]).saveClaimCorrection, true);
  assert.equal(control(f.requests[2]).toolsClosed, true);
  assert.deepEqual(f.requests[2].tools, []); assert.equal(f.requests[2].tool_choice, 'none');
  assert.doesNotMatch(await readFile(runtime.info().sessionFile, 'utf8'), /\[PA本轮控制｜应用生成\]/,
    'wire-only controls must not accumulate in saved conversation history');
});

test('channel tool continuations append to the complete previous wire prefix without persisting or leaking controls', async t => {
  let round = 0, answerCall = 0, runtime;
  const reads = [];
  const f = await fixture(t, body => {
    if (isPreparationRequest(body)) {
      round++; answerCall = 0;
      return preparationDelta(`prepare-${round}`, { intent: 'question', mode: round === 1 ? 'professional' : 'casual', updates: [] });
    }
    answerCall++;
    return answerCall <= 2 ? { role: 'assistant', tool_calls: [{ index: 0, id: `history-${round}-${answerCall}`,
      type: 'function', function: { name: 'read_history', arguments: JSON.stringify({ query: `part-${answerCall}` }) } }] }
      : { role: 'assistant', content: '查询完成。' };
  }, { loop: { maxModelCalls: 4, maxToolCalls: 3 } });
  runtime = await f.open('append-only');
  const estimate = () => runtime.estimate('estimate-only-sentinel', undefined, { channel: true });
  assert.deepEqual(estimate(), estimate(), 'admission probes must be repeatable');
  for (let turn = 1; turn <= 2; turn++) {
    assert.equal(await runtime.prompt(`第${turn}轮查询`, { runId: `append-${turn}`, companionTools: {
      prepareTurn: plan => ({ prepared: true, mode: plan.mode, saved: [] }),
      readHistory: params => {
        reads.push(`${turn}:${params.query}`);
        assert.deepEqual(estimate(), estimate(), 'active multi-mode probes must not mutate live controls');
        return { messages: [{ id: `result-${turn}-${params.query}`, role: 'user', text: `history-visible-${turn}-${params.query}` }] };
      },
    } }), '查询完成。');
    const requests = f.requests.slice((turn - 1) * 4, turn * 4), answers = requests.slice(1);
    assert.equal(requests.length, 4, 'preparation and two ordinary tool calls keep the original model budget');
    for (let index = 1; index < answers.length; index++) {
      assert.deepEqual(answers[index].messages.slice(0, answers[index - 1].messages.length), answers[index - 1].messages,
        'the complete previous same-stage wire messages, including old application controls, must remain the next request prefix');
      assert.ok(answers[index].messages.some(message => message.role === 'tool'
        && text(message.content).includes(`history-visible-${turn}-part-${index}`)), 'new tool results must be visible');
    }
    const controls = body => body.messages.filter(message => message.role === 'user' && text(message.content).startsWith(controlPrefix));
    assert.deepEqual(requests.map(body => controls(body).length), [1, 2, 2, 3],
      'unchanged controls are replayed at their original position; only changed controls append');
    assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['prepare_turn']);
    assert.equal(requests[0].tool_choice.function.name, 'prepare_turn');
    assert.ok(answers[0].tools.some(tool => tool.function.name === 'read_history'));
    assert.deepEqual(answers[2].tools, []); assert.equal(answers[2].tool_choice, 'none');
    assert.equal(JSON.parse(text(controls(requests[0])[0].content).slice(controlPrefix.length)).stage, 'prepare');
    assert.ok(controls(answers[0]).every(message => !text(message.content).includes(turn === 2 ? 'professional' : 'casual')),
      'a new prompt must not inherit the previous prompt controls');
    assert.doesNotMatch(JSON.stringify(requests), /estimate-only-sentinel|prepare-reserve/);
  }
  assert.deepEqual(reads, ['1:part-1', '1:part-2', '2:part-1', '2:part-2']);
  assert.deepEqual(f.log.events().filter(event => event.event === 'turn.completed')
    .map(event => [event.details.modelCalls, event.details.toolCalls]), [[4, 3], [4, 3]]);
  assert.doesNotMatch(await readFile(runtime.info().sessionFile, 'utf8'), /\[PA本轮控制｜应用生成\]/,
    'controls must remain wire-only rather than enter Pi JSONL');
});
