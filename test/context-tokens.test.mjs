import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { ContextTokenEstimator, contextCalibrationKey, contextFootprint, normalizedInputTokens,
  validContextCalibration, upgradeContextCalibration } from '../dist/context-tokens.js';
import { imageTokenPayload, IMAGE_TOKENS } from '../dist/image-context.js';

const key = contextCalibrationKey('provider', 'model', 'openai-completions', 'https://example.test/v1', 'room');
const payload = (...texts) => ({ model: 'model', messages: texts.map(content => ({ role: 'user', content })) });
const usage = (input, cacheRead = 0, cacheWrite = 0) => ({ input, cacheRead, cacheWrite, output: 7,
  totalTokens: input + cacheRead + cacheWrite + 7 });
function learned(request, tokens = 500) {
  const estimator = new ContextTokenEstimator(key);
  assert.equal(estimator.learn(estimator.metadata(request), usage(tokens)), true);
  return estimator;
}

test('normalized SDK input includes cache reads/writes, excludes output and rejects absent or invalid counters', () => {
  assert.equal(normalizedInputTokens(usage(100, 200, 300)), 600);
  assert.equal(normalizedInputTokens(usage(0, 200)), 200);
  for (const value of [undefined, {}, usage(0), { ...usage(1), input: -1 }, { ...usage(1), input: 1.5 },
    { ...usage(1), input: NaN }, { ...usage(1), input: Infinity }, { ...usage(1), totalTokens: 10 },
    { ...usage(1), totalTokens: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(normalizedInputTokens(value), undefined);
  for (const name of Object.keys(usage(1))) {
    const invalid = usage(1); delete invalid[name];
    assert.equal(normalizedInputTokens(invalid), undefined);
  }
});

test('unchanged history uses measured input while new text retains its full conservative byte cost', () => {
  const old = payload('旧历史'.repeat(8000));
  const estimator = learned(old, 176000);
  const same = estimator.estimate(old);
  assert.ok(same.inputTokens >= 176000 && same.inputTokens < 176300);
  const added = 'brand new text '.repeat(10000);
  const next = estimator.estimate(payload('旧历史'.repeat(8000), added));
  assert.equal(next.calibration.sampleInputTokens, 176000);
  assert.ok(next.inputTokens >= 176000 + Buffer.byteLength(added));
  assert.ok(next.inputTokens < 176000 + Buffer.byteLength(added) + 512);
});

test('block multiset counts repeated messages and duplicate chunks rather than treating them as a set', () => {
  const text = 'x'.repeat(30000);
  const estimator = learned(payload(text));
  const doubled = estimator.estimate(payload(text, text));
  assert.ok(doubled.calibration.newBytes >= Buffer.byteLength(JSON.stringify({ role: 'user', content: text })));
  assert.ok(doubled.inputTokens > 30000);
  const fp = contextFootprint(payload(text, text));
  assert.ok(fp.blocks.some(block => block.count > 1));
  assert.equal(validContextCalibration({ version: 2, key, footprint: fp }), true);
});

test('message-local blocks survive changed phase instructions; summaries, major replacement and shrink fall back', () => {
  const history = '保留的历史'.repeat(6000);
  const old = { model: 'model', messages: [{ role: 'system', content: 'prepare' }, { role: 'user', content: history }] };
  const estimator = learned(old);
  const next = { ...old, messages: [{ role: 'system', content: 'answer' }, old.messages[1]] };
  assert.ok(estimator.estimate(next));
  assert.equal(estimator.estimate(payload('summary')), undefined);
  assert.equal(estimator.estimate(payload(history.slice(0, history.length / 2))), undefined);
  assert.equal(estimator.estimate(payload('新内容'.repeat(6000))), undefined);
  // Removing a small message must never subtract any observed input tokens.
  const withExtra = learned(payload(history, 'remove me'), 1000);
  assert.ok(withExtra.estimate(payload(history)).inputTokens >= 1000);
});

test('scope key separates provider, model, protocol, endpoint and room; metadata contains only bounded hashes', () => {
  const args = ['provider', 'model', 'openai-completions', 'https://example.test/v1', 'room'];
  for (let index = 0; index < args.length; index++) {
    const changed = [...args]; changed[index] += '-changed';
    assert.notEqual(contextCalibrationKey(...changed), key);
  }
  const estimator = learned(payload('PRIVATE_TEXT'.repeat(1000)));
  const metadata = estimator.metadata(payload('PRIVATE_TEXT'.repeat(1000)));
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_TEXT|example|room/);
  assert.equal(estimator.learn({ ...metadata, key: '0'.repeat(64) }, usage(1)), false);
  assert.equal(validContextCalibration({ ...metadata, secret: 'unexpected' }), false);
  assert.equal(validContextCalibration({ ...metadata, footprint: { ...metadata.footprint, bytes: 1 } }), false);
  assert.equal(contextFootprint(payload('x'.repeat(17 * 1024 * 1024))), undefined);
  assert.ok(contextFootprint(payload(...Array(2050).fill('small'))));
  assert.equal(contextFootprint(payload(...Array(2050).fill('small')), 1), undefined);
});

const wireBytes = request => Buffer.byteLength(JSON.stringify(imageTokenPayload(request).text));
function historyFixture(count = 2000, short = false) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`, actorId: `actor-${index % 40}`, at: `2026-10-20T${index}`,
    text: short ? `短消息${index}` : `第${index}条正文，必须完整保留。${'聊天正文与代码\\n"quoted"\n'.repeat(14)}`,
  }));
}
const historyRequest = (history, role = 'developer') => ({ model: 'model', messages: [
  { role, content: 'stable instructions' },
  { role: 'user', content: [{ type: 'text', text: `history:\n${history.map(row => JSON.stringify(row)).join('\n')}\n` },
    { type: 'file', file_id: 'old-image' }] },
] });

test('2000 nested JSONL rows retain measured history after per-row fields, order and wire role change', () => {
  const rows = historyFixture();
  const old = historyRequest(rows);
  const estimator = learned(old, 254743);
  const expanded = rows.map(({ text, id, actorId, at }) => ({
    replyTo: null, text, sourceType: 'group', personId: `person-${actorId}`, at, actorId, id,
  }));
  const next = historyRequest(expanded, 'system');
  // Also reorder the outer wire fields and text block fields.
  next.messages[1] = { content: next.messages[1].content.map(block => block.type === 'text'
    ? { text: block.text, type: block.type } : block), role: 'user' };
  const result = estimator.estimate(next);
  assert.ok(wireBytes(old) > 1000000);
  assert.ok(result);
  assert.ok(result.calibration.retainedBytes >= wireBytes(old) * 0.99);
  assert.ok(result.calibration.newBytes >= wireBytes(next) - wireBytes(old));
  assert.ok(result.inputTokens >= 254743 + wireBytes(next) - wireBytes(old));
  assert.ok(result.inputTokens < 500000, JSON.stringify(result));
  const spaced = structuredClone(next);
  spaced.messages[1].content[0].text = `history:\n${expanded.map(row =>
    JSON.stringify(row).replaceAll('\":', '\" : ')).join('\n')}\n`;
  const spacedResult = estimator.estimate(spaced);
  assert.ok(spacedResult);
  assert.ok(spacedResult.calibration.retainedBytes >= wireBytes(old) * 0.95);
  assert.ok(spacedResult.inputTokens >= result.inputTokens + wireBytes(spaced) - wireBytes(next));
  const addedCode = '\nconst arbitraryNewCode = "\\new code";\n'.repeat(9000);
  const withCode = structuredClone(next);
  withCode.messages.push({ role: 'user', content: addedCode });
  const codeResult = estimator.estimate(withCode);
  assert.ok(codeResult.inputTokens - result.inputTokens >= Buffer.byteLength(JSON.stringify(addedCode)));
});

test('2000 short JSON rows and duplicate images stay bounded, exact byte coverage includes whitespace and escapes', () => {
  const old = historyRequest(historyFixture(2000, true));
  old.messages[1].content.push({ type: 'file', file_id: 'old-image' });
  const metadata = new ContextTokenEstimator(key).metadata(old);
  assert.ok(metadata);
  assert.equal(metadata.version, 2);
  assert.equal(metadata.footprint.bytes, wireBytes(old));
  assert.equal(metadata.footprint.blocks.reduce((sum, block) => sum + block.bytes * block.count, 0), wireBytes(old));
  assert.equal(validContextCalibration(metadata), true);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 4 * 1024 * 1024);
  assert.doesNotMatch(JSON.stringify(metadata), /短消息|actor-|message-|old-image|instructions/);
  const estimator = learned(old, 250000);
  assert.equal(estimator.estimate(old).inputTokens, 250064);
  const next = structuredClone(old);
  next.messages[1].content.push({ type: 'file', file_id: 'new-image' });
  assert.ok(estimator.estimate(next).inputTokens >= 250064 + IMAGE_TOKENS);
  next.messages[1].content.splice(1, 1);
  assert.equal(estimator.estimate(next), undefined);
  const removedAll = structuredClone(old);
  removedAll.messages[1].content = removedAll.messages[1].content.slice(0, 1);
  assert.equal(estimator.estimate(removedAll), undefined);

  const formatted = payload('prefix\n { "odd\\\"key" : "line\\n\\\\ and 中文", "number": 1 } \r\n' +
    JSON.stringify({ nested: JSON.stringify({ text: 'inside\n"\\' }) }));
  const fp = contextFootprint(formatted);
  assert.equal(fp.bytes, wireBytes(formatted));
  assert.equal(fp.blocks.reduce((sum, block) => sum + block.bytes * block.count, 0), fp.bytes);
  const escapedJson = payload(String.raw`{"nested":"\u007b\"text\":\"escaped\/value\"}","raw":"\u000a"}`);
  const escapedFp = contextFootprint(escapedJson);
  assert.equal(escapedFp.bytes, wireBytes(escapedJson));
  assert.equal(escapedFp.blocks.reduce((sum, block) => sum + block.bytes * block.count, 0), escapedFp.bytes);
});

test('history compaction or wholesale body replacement cannot reuse the expanded JSONL sample', () => {
  const rows = historyFixture();
  const estimator = learned(historyRequest(rows), 254743);
  assert.equal(estimator.estimate(historyRequest(rows.slice(1000))), undefined);
  assert.equal(estimator.estimate(historyRequest(rows.map(row => ({ ...row, text: '替换的新内容'.repeat(60) })))), undefined);
  assert.equal(estimator.estimate(historyRequest([{ text: '压缩后的总结' }])), undefined);
});

test('legacy successful samples upgrade only from the complete matching wire footprint', () => {
  const request = historyRequest(historyFixture(500));
  const legacy = { version: 1, key, footprint: contextFootprint(request, 1) };
  assert.equal(validContextCalibration(legacy), true);
  const estimator = new ContextTokenEstimator(key);
  assert.equal(estimator.learn(legacy, usage(250000)), true);
  assert.ok(estimator.estimate(request));
  const upgraded = upgradeContextCalibration(legacy, request);
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.key, key);
  assert.deepEqual(upgraded, estimator.metadata(request));
  assert.equal(estimator.learn(upgraded, usage(250000)), true);
  assert.ok(estimator.estimate(historyRequest(historyFixture(500).map(row => ({ personId: 'new-id', ...row })))));
  const redacted = structuredClone(request);
  redacted.messages[1].content[0].text = redacted.messages[1].content[0].text.replace('第0条正文', '已脱敏原文');
  assert.equal(upgradeContextCalibration(legacy, redacted), undefined);
  const changedImage = structuredClone(request);
  changedImage.messages[1].content[1].file_id = 'another-image';
  assert.equal(upgradeContextCalibration(legacy, changedImage), undefined);
  assert.equal(upgradeContextCalibration(upgraded, redacted), undefined);
  assert.equal(upgradeContextCalibration({ ...legacy, extra: 'untrusted' }, request), undefined);
});

test('v2 validation enforces exact shape, block/part/byte limits and distinct multiset entries', () => {
  const estimator = new ContextTokenEstimator(key);
  const metadata = estimator.metadata(payload('small'));
  const block = metadata.footprint.blocks[0];
  for (const footprint of [
    { ...metadata.footprint, blocks: [...metadata.footprint.blocks, block] },
    { bytes: 8192 * 131073, blocks: [{ ...block, bytes: 8192, count: 131073 }] },
    { bytes: 131073, blocks: [{ ...block, bytes: 1, count: 131073 }] },
    { bytes: 8193, blocks: [{ ...block, bytes: 8193, count: 1 }] },
    { ...metadata.footprint, imageIds: Array(601).fill('0'.repeat(64)) },
    { ...metadata.footprint, imageIds: ['not-a-hash'] },
    { ...metadata.footprint, secret: 'raw text' },
  ]) assert.equal(validContextCalibration({ ...metadata, footprint }), false);
  assert.equal(validContextCalibration({ ...metadata, version: 3 }), false);
  assert.equal(contextFootprint(payload(...Array(30000).fill('small'))), undefined);
  const maxBytes = 16 * 1024 * 1024;
  const exact = payload('x'.repeat(maxBytes - wireBytes(payload(''))));
  assert.equal(contextFootprint(exact).bytes, maxBytes);
  exact.messages[0].content += 'x';
  assert.equal(contextFootprint(exact), undefined);
  const exactParts = { bytes: 131072, blocks: [{ hash: '0'.repeat(64), bytes: 1, count: 131072 }] };
  assert.equal(validContextCalibration({ version: 2, key, footprint: exactParts }), true);
  assert.equal(contextFootprint({ messages: [{ content: Array.from({ length: 601 }, (_, index) =>
    ({ type: 'file', file_id: String(index) })) }] }), undefined);
});

test('millions of empty or tiny history lines fit a bounded heap and preserve every wire byte', () => {
  const moduleUrl = new URL('../dist/context-tokens.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { contextFootprint, validContextCalibration } from ${JSON.stringify(moduleUrl)};
    for (const line of ['\\n', 'x\\n']) {
      const request = { messages: [{ role: 'user', content: line.repeat(1000000) + '{"text":"tail"}\\n' }] };
      const footprint = contextFootprint(request);
      assert.ok(footprint);
      assert.equal(footprint.bytes, Buffer.byteLength(JSON.stringify(request)));
      assert.equal(footprint.blocks.reduce((sum, block) => sum + block.bytes * block.count, 0), footprint.bytes);
      assert.equal(validContextCalibration({ version: 2, key: '0'.repeat(64), footprint }), true);
    }
  `], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test('deep and wide JSON candidates fit a bounded heap without losing wire bytes', () => {
  const moduleUrl = new URL('../dist/context-tokens.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { contextFootprint, validContextCalibration } from ${JSON.stringify(moduleUrl)};
    for (const content of ['['.repeat(1000000) + ']'.repeat(1000000), '[' + '[],'.repeat(500000) + '[]]']) {
      const request = { messages: [{ role: 'user', content }] };
      const footprint = contextFootprint(request);
      assert.ok(footprint);
      assert.equal(footprint.bytes, Buffer.byteLength(JSON.stringify(request)));
      assert.equal(footprint.blocks.reduce((sum, block) => sum + block.bytes * block.count, 0), footprint.bytes);
      assert.equal(validContextCalibration({ version: 2, key: '0'.repeat(64), footprint }), true);
    }
  `], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);

  const rows = historyFixture();
  const request = payload(JSON.stringify(rows));
  const estimator = learned(request, 250000);
  const expanded = payload(JSON.stringify(rows.map(row => ({ personId: 'new-person', ...row }))));
  assert.ok(estimator.estimate(expanded));
  // Brackets and escaped quotes inside an ordinary text value are not structure.
  const quoted = payload(JSON.stringify({ text: '["\\'.repeat(1000) }));
  assert.equal(contextFootprint(quoted).bytes, wireBytes(quoted));
});

test('newest compatible measurement wins, invalid samples cannot replace it, and only eight samples are retained', () => {
  const request = payload('history'.repeat(2000));
  const estimator = learned(request, 100);
  assert.equal(estimator.learn(estimator.metadata(request), usage(1000)), true);
  assert.equal(estimator.estimate(request).calibration.sampleInputTokens, 1000);
  assert.equal(estimator.learn(estimator.metadata(request), usage(0)), false);
  assert.equal(estimator.estimate(request).calibration.sampleInputTokens, 1000);
  for (let index = 0; index < 8; index++) estimator.learn(estimator.metadata(payload(String(index).repeat(20000))), usage(50));
  assert.equal(estimator.estimate(request), undefined);
});
