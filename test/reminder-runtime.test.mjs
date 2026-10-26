import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openConversation, RequestError } from '../dist/runtime.js';
import { MemoryError } from '../dist/memory-types.js';
import { REMINDER_TOOL_SPECS } from '../dist/reminder-tools.js';
import { hasUnbackedReminderClaim } from '../dist/turn-plan.js';
import { preparationDelta } from './fixtures/turn-preparation.mjs';

const call = (name, args) => ({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${name}`, type: 'function',
  function: { name, arguments: JSON.stringify(args) } }] });
const params = { key: 'medicine', goal: '吃药', remindAt: '2026-10-27T09:00:00+08:00', timezone: 'Asia/Shanghai',
  requestQuote: '明天早上九点提醒我吃药' };
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
  return { requests, async open(id, options = { enableSearch: true }) {
    const runtime = await openConversation(config, id, options); runtimes.push(runtime); return runtime;
  } };
}

test('提醒成功使用prepare和create两次本地SSE请求，程序确认并持久保留工具记录', async t => {
  const f = await fixture(t, (_body, n) => n === 1 ? preparationDelta('prepare') : call('create_reminder', params));
  const runtime = await f.open('create');
  let executions = 0;
  const answer = await runtime.prompt(params.requestQuote, { runId: 'run-create', companionTools: context({
    execute(name, input) { executions++; assert.equal(name, 'create_reminder'); assert.deepEqual(input, params);
      return { saved: true, id: 'reminder-1', remindAt: params.remindAt, goal: params.goal, confirmation }; },
  }) });
  assert.equal(answer, confirmation); assert.equal(executions, 1); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].tools.map(tool => tool.function.name), ['prepare_turn']);
  assert.ok(REMINDER_TOOL_SPECS.every(spec => f.requests[1].tools.some(tool => tool.function.name === spec.name)));
  assert.equal(runtime.recordedTurns().at(-1).assistant.text, confirmation);
  await runtime.close();
  const reopened = await f.open('create');
  assert.equal(reopened.recordedTurns().at(-1).assistant.text, confirmation);
});

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
  assert.equal(await runtime.prompt(params.requestQuote, { runId: 'run-rejected', companionTools: tools }), '这次提醒没有安排成功。');
  assert.equal(f.requests.length, 4);
});

test('模糊时间按正常回答澄清，没有额外提醒规划请求或工具执行', async t => {
  const f = await fixture(t, (_body, n) => n === 1 ? preparationDelta('prepare') : { role: 'assistant', content: '你希望具体几点提醒？' });
  const runtime = await f.open('clarify');
  const answer = await runtime.prompt('明天提醒我吃药', { runId: 'run-clarify', companionTools: context({ execute() { assert.fail('不能创建'); } }) });
  assert.equal(answer, '你希望具体几点提醒？'); assert.equal(f.requests.length, 2);
});

test('时间schema拒绝自然语言和无时区参数，模型可在原预算内修正且只执行有效调用',async t=>{
  for(const invalid of ['明天下午三点','2026-10-27T15:00:00']) {
    let executions=0;
    const f=await fixture(t,(_body,n)=>{
      if(n===1)return preparationDelta('prepare');
      if(n===2)return call('create_reminder',{...params,remindAt:invalid});
      assert.equal(n,3);assert.equal(executions,0,'错误格式不能进入执行器');
      return call('create_reminder',params);
    });
    const runtime=await f.open('time-format');
    const reply=await runtime.prompt(params.requestQuote,{runId:'time-format',companionTools:context({execute(_name,p){
      executions++;assert.equal(p.remindAt,params.remindAt);
      return {saved:true,id:'time-ok',goal:p.goal,remindAt:p.remindAt,confirmation};
    }})});
    assert.equal(reply,confirmation);assert.equal(executions,1);assert.equal(f.requests.length,3);
  }
});

test('提醒与研究同时可用时按实际工具调用分流，普通待办和定时研究澄清无副作用',async t=>{
  // Fixed model responses verify routing, not natural-language classification accuracy.
  const cases=[
    {text:'明天下午三点提醒我调研 DeepSeek-Bot',tool:'create_reminder'},
    {text:'把 DeepSeek-Bot 加入研究清单，研究完告诉我',tool:'create_research'},
    {text:'DeepSeek-Bot是什么？',answer:'这是一个需要当场解释的问题。'},
    {text:'把交电费加入任务清单',answer:'目前没有普通待办入口。你需要在具体时间提醒吗？'},
    {text:'明天下午三点开始帮我研究 DeepSeek-Bot',answer:'目前不支持定时开始研究。你希望现在研究，还是到时提醒你？'},
    {text:'明天帮我处理一下这个',answer:'你希望我具体做什么，还是到时提醒你处理？'},
  ];
  for(const [index,sample]of cases.entries()) {
    const executed=[];
    const f=await fixture(t,(body,n)=>{
      if(n===1)return preparationDelta('prepare');
      assert.equal(n,2);
      assert.ok(body.tools.some(tool=>tool.function.name==='create_reminder'));
      assert.ok(body.tools.some(tool=>tool.function.name==='create_research'));
      assert.match(JSON.stringify(body.messages),/普通待办/);
      if(sample.tool==='create_reminder')return call(sample.tool,{...params,goal:'调研 DeepSeek-Bot',requestQuote:sample.text});
      if(sample.tool==='create_research')return call(sample.tool,{key:'research',title:'DeepSeek-Bot',goal:'解释产品',requiresOriginal:false});
      return {role:'assistant',content:sample.answer};
    },{research:{enabled:true,maxModelCalls:16,maxToolCalls:24,maxSearchCalls:6}});
    const runtime=await f.open('boundary-'+index);
    const tools=context({execute(name,p){executed.push(name);return {saved:true,id:'reminder',goal:p.goal,remindAt:p.remindAt,confirmation};}});
    tools.research={execute(name){executed.push(name);return {saved:true,id:'research',title:'DeepSeek-Bot',status:'queued'};}};
    const reply=await runtime.prompt(sample.text,{runId:'boundary-'+index,companionTools:tools});
    assert.deepEqual(executed,sample.tool?[sample.tool]:[]);
    if(sample.answer)assert.equal(reply,sample.answer);
    assert.equal(f.requests.length,2);
  }
});

test('提醒成功后阻止同批后续工具并确认未执行项', async t => {
  const f = await fixture(t, (_body, n) => n === 1 ? preparationDelta('prepare') : { role: 'assistant', tool_calls: [
    ...call('create_reminder', params).tool_calls,
    { ...call('read_history', {}).tool_calls[0], index: 1 },
  ] });
  const runtime = await f.open('siblings');
  const tools = context({ execute: () => ({ saved: true, id: 'reminder-1', remindAt: params.remindAt, goal: params.goal, confirmation }) });
  tools.readHistory = () => assert.fail('成功后不能继续执行工具');
  const answer = await runtime.prompt(params.requestQuote, { runId: 'run-siblings', companionTools: tools });
  assert.equal(answer, confirmation + '\n本轮其他操作未执行。'); assert.equal(f.requests.length, 2);
});

test('提醒已保存后取消本轮请求，RequestError保留实际成功确认', async t => {
  const f = await fixture(t, (_body, n) => n === 1 ? preparationDelta('prepare') : call('create_reminder', params));
  const runtime = await f.open('cancel-after-save');
  await assert.rejects(runtime.prompt(params.requestQuote, { runId: 'cancel-after-save', companionTools: context({
    execute() {
      // Cancel after the synchronous saved receipt has reached the tool, before Pi finishes its turn.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { void runtime.abort(); })));
      return { saved: true, id: 'reminder-1', remindAt: params.remindAt, goal: params.goal, confirmation };
    },
  }) }), error => error instanceof RequestError && error.kind === 'cancelled'
    && assert.deepEqual(error.confirmedActions, [confirmation]) === undefined);
  assert.equal(f.requests.length, 2);
});

test('取消只采用真实成功回执，sending等未知状态留给正常回答解释', async t => {
  const f = await fixture(t, (_body, n) => n === 1 ? preparationDelta('prepare') : call('cancel_reminder', { id: 'reminder-1' }));
  const runtime = await f.open('cancel');
  const cancelled = '已取消提醒 reminder-1，原任务和审计保留。';
  assert.equal(await runtime.prompt('取消那条吃药提醒', { runId: 'run-cancel', companionTools: context({
    execute: () => ({ cancelled: true, id: 'reminder-1', confirmation: cancelled }),
  }) }), cancelled);
  assert.equal(f.requests.length, 2);
  const uncertain = await fixture(t, (_body, n) => n === 1 ? preparationDelta('prepare') : n === 2
    ? call('cancel_reminder', { id: 'reminder-1' }) : { role: 'assistant', content: '这条提醒正在发送，无法确认已取消。' });
  const sending = await uncertain.open('sending');
  assert.match(await sending.prompt('取消提醒', { runId: 'run-sending', companionTools: context({
    execute: () => ({ cancelled: false, id: 'reminder-1', status: 'sending' }),
  }) }), /无法确认已取消/);
  assert.equal(uncertain.requests.length, 3);
});

test('CLI、后台研究、无提醒context与未启用渠道工具的运行时不展示提醒工具', async t => {
  const f = await fixture(t, (body) => body.tool_choice?.function?.name === 'prepare_turn'
    ? preparationDelta(`prepare-${f.requests.length}`) : { role: 'assistant', content: '没有执行外部操作。' });
  const cli = await f.open('cli'); await cli.prompt('提醒我');
  const research = await f.open('research', { enableSearch: true, research: { phase: 'write', maxSearchCalls: 0, record() {} } });
  await research.prompt('写报告');
  const absent = await f.open('absent'); await absent.prompt('你好', { runId: 'absent', companionTools: context(undefined) });
  const disabled = await f.open('disabled', { enableSearch: false });
  await disabled.prompt('你好', { runId: 'disabled', companionTools: context({ execute() { assert.fail('不能执行'); } }) });
  assert.ok(f.requests.every(body => !(body.tools ?? []).some(tool => REMINDER_TOOL_SPECS.some(spec => spec.name === tool.function.name))));
});

test('无回执提醒承诺的窄校验保留否定、引用和澄清', () => {
  for (const answer of ['已为你安排提醒。', '已安排好了提醒。', '我已经帮你安排好了提醒。', '我会在明早九点提醒你吃药。', '提醒已设置好了。']) assert.equal(hasUnbackedReminderClaim(answer), true);
  for (const answer of ['这次提醒没有安排成功。', '你希望几点提醒？', '他说“我会提醒你”。',
    '你希望我到时提醒你做，还是由我来研究？','目前不支持定时开始研究。你希望现在研究，还是到时提醒你？']) assert.equal(hasUnbackedReminderClaim(answer), false);
  assert.equal(hasUnbackedReminderClaim('已安排提醒。你希望我到时提醒你做，还是由我来研究？'),true,'后面的问句不能掩盖前面的无回执承诺');
});
