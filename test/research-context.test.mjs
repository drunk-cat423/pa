import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openConversation } from '../dist/runtime.js';
import { ResearchMaterialReader } from '../dist/research-material-reader.js';

const body = '保存的原文😀'.repeat(900);

for (const bodyProtocol of [false,true]) test(bodyProtocol ? '真实工具循环使用正文协议：重复回执、显式重读和预算接线' : '本地HTTP采集循环：轻量投影启用，完整思考与原始Pi记录保留', async t => {
  const enabled=true;
  const directory = await mkdtemp(join(tmpdir(), 'pa-context-'));
  const requests = [], errors = [], recorded = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      const payload = JSON.parse(raw); requests.push(payload);
      const number = requests.length;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture',
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      emit({ role: 'assistant', reasoning_content: `完整思考${number}` });
      if (number < 4) emit({ tool_calls: [{ index: 0, id: `read-${number}`, type: 'function', function: {
        name: 'read_research_material', arguments: JSON.stringify(bodyProtocol ? {id:'e1',offset:0,...(number===3?{reread:true}:{})} : { id: 'e1', offset: number }),
      } }] });
      else emit({ content: '完成采集' });
      emit({}, number < 4 ? 'tool_calls' : 'stop'); response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let runtime;
  t.after(async () => { await runtime?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const reader=new ResearchMaterialReader(id=>({id,tool:'web_fetch',result:{url:'https://example.org',text:body,
    coverage:{offset:0,end:body.length,totalChars:body.length,contentHash:'a'.repeat(64)}}}));
  runtime = await openConversation({ cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture',
    apiKey: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 131072,
    maxOutputTokens: 4096, timeoutMs: 5000, loop: { maxModelCalls: 4, maxToolCalls: 8 },
  }, 'collect', { research: { phase: 'collect', compactResearchContext: enabled, maxSearchCalls: 0,
    ...(bodyProtocol?{materialReadProtocol:'body-v1'}:{}),
    record: event => recorded.push(event), readMaterial: (input,limit) => bodyProtocol ? reader.read(input,limit) : ({ id: input.id, text: body, offset: input.offset,
      nextOffset: 2500, totalChars: 5000 }),
    resolveMaterialReference(tool, input, value) {
      assert.ok(recorded.some(event => event.tool === tool && event.input === input && event.result === value));
      return { id: value.id };
    },
  } });
  await runtime.prompt('采集材料'); assert.equal(requests.length, 4);
  const systems = requests.map(request => request.messages.filter(message => ['system','developer'].includes(message.role)));
  assert.ok(systems[0].length > 0);
  for (const system of systems) assert.deepEqual(system, systems[0]);
  assert.match(JSON.stringify(systems[0]), /本阶段初始上限/);
  assert.doesNotMatch(JSON.stringify(systems[0]), /剩余主模型调用/);
  // Do not insert ephemeral user messages into the tool/reasoning turn to move
  // counters out of system: that would change the provider's turn semantics.
  for (const request of requests) assert.equal(request.messages.filter(message => message.role === 'user').length, 1);
  const thirdTools = requests[2].messages.filter(message => message.role === 'tool');
  assert.equal(thirdTools.length, 2);
  assert.equal(thirdTools[0].content.includes('saved_research_material'), enabled);
  if (bodyProtocol) {
    assert.ok(thirdTools[1].content.includes('"alreadyRead":true'));
    assert.ok(requests[3].messages.filter(m=>m.role==='tool').at(-1).content.includes(body.slice(0,900)));
    assert.match(thirdTools[0].content,/reread:true/);
    const tool=requests[0].tools.find(t=>t.function.name==='read_research_material');
    assert.equal(tool.function.parameters.properties.reread.type,'boolean');
    assert.equal(recorded.filter(e=>e.kind==='tool_start' && e.tool==='read_research_material').length,3);
    assert.equal(recorded.at(-1).toolCalls,3);
  } else assert.ok(thirdTools[1].content.includes(body.slice(0, 900)));
  assert.equal(requests[2].messages.find(message => message.role === 'assistant').reasoning_content, '完整思考1');
  assert.deepEqual(thirdTools.map(message => message.tool_call_id), ['read-1', 'read-2']);
  const files = await readdir(join(directory, 'data'), { recursive: true });
  const sessions = files.filter(file => file.endsWith('session.jsonl'));
  assert.equal(sessions.length, 1);
  const session = await readFile(join(directory, 'data', sessions[0]), 'utf8');
  // Pi already bounds tool output before saving; this projection must not alter
  // that original bounded output or the independently recorded full material.
  assert.ok(session.includes(body.slice(0, 900))); assert.equal(session.includes('saved_research_material'), false);
  if (bodyProtocol) {
    const results=recorded.filter(e=>e.kind==='tool_result').map(e=>e.result);
    assert.equal(results[0].text,results[2].text); assert.equal(results[1].text,'');
    assert.ok(results.every(r=>r.readMode==='body-v1'));
    assert.doesNotMatch(session,/工具结果已截断/);
  } else assert.ok(recorded.filter(event => event.kind === 'tool_result').every(event => event.result.text === body));
});
