import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextTokenEstimator, contextCalibrationKey, contextFootprint, normalizedInputTokens,
  validContextCalibration } from '../dist/context-tokens.js';

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
  assert.equal(validContextCalibration({ version: 1, key, footprint: fp }), true);
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
  assert.equal(contextFootprint(payload(...Array(2050).fill('small'))), undefined);
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
