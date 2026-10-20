import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DiagnosticLog } from '../dist/diagnostics.js';
import { ContextTokenEstimator, contextCalibrationKey, contextFootprint } from '../dist/context-tokens.js';
import { openConversation } from '../dist/runtime.js';

for (const artifact of ['intact', 'redacted', 'missing']) {
  test(`restart restores legacy calibration only from the exact verified request (${artifact})`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pa-calibration-restore-'));
    let runtime;
    t.after(async () => { await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
    const config = { cwd: directory, dataDir: directory, provider: 'pa-calibration-test', model: 'fixture',
      apiKey: 'fixture-private-key', baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 1_000_000, maxOutputTokens: 256, timeoutMs: 1000 };
    const history = Array.from({ length: 1500 }, (_, index) => ({ id: `message-${index}`, contextSeq: index + 1,
      role: 'user', senderId: 'alice', text: `${index}:` + '此前讨论的稳定原文。'.repeat(12)
        + (artifact === 'redacted' ? config.apiKey : '') }));
    const text = rows => '[检查点后的完整消息流]\n' + rows.map(row => JSON.stringify(row)).join('\n');
    const original = { model: config.model, messages: [{ role: 'user', content: text(history) }] };
    const scope = 'stable-room';
    const metadata = { version: 1,
      key: contextCalibrationKey(config.provider, config.model, 'openai-completions', config.baseUrl, scope),
      footprint: contextFootprint(original, 1) };
    const diagnostics = new DiagnosticLog(directory, [config.apiKey]);
    const callId = diagnostics.startCall({ traceId: 'legacy', kind: 'chat', provider: config.provider,
      model: config.model, phase: 'request', contextCalibration: metadata }, original);
    diagnostics.saveResponse(callId, { usage: { input: 20_000, cacheRead: 100_000, cacheWrite: 0,
      output: 7, totalTokens: 120_007 } });
    diagnostics.finishCall(callId, 'completed', 'response');
    const before = diagnostics.calls({ callId });
    if (artifact === 'missing') await unlink(join(directory, 'diagnostics', 'calls', callId, 'request.json'));
    runtime = await openConversation(config, `new-task-${artifact}`, { contextCalibrationScope: scope });
    const enriched = text(history.map(row => ({ personId: 'person-alice', sourceType: 'user_statement', ...row })));
    const estimate = runtime.estimate(enriched);
    assert.equal(estimate.method, artifact === 'intact' ? 'usage-calibrated' : 'utf8-byte-estimate');
    if (artifact === 'intact') {
      assert.equal(estimate.calibration.sampleInputTokens, 120_000);
      assert.ok(estimate.inputTokens < 400_000);
      assert.ok(estimate.calibration.newBytes >= 1500 * Buffer.byteLength('person-aliceuser_statement'));
    }
    assert.deepEqual(diagnostics.calls({ callId }), before, 'restoration does not rewrite historical evidence');
    assert.equal(diagnostics.calls().length, 1, 'restoration does not send a model request');
  });
}

test('calibration restoration keeps at most eight valid samples while skipping unusable usage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-calibration-bounds-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const diagnostics = new DiagnosticLog(directory);
  const key = 'a'.repeat(64);
  const payload = { messages: [{ role: 'user', content: 'bounded history' }] };
  const metadata = new ContextTokenEstimator(key).metadata(payload);
  const eligible = [];
  for (let index = 0; index < 14; index++) {
    const id = diagnostics.startCall({ traceId: `sample-${index}`, kind: 'chat', provider: 'fixture',
      model: 'fixture', phase: 'request', contextCalibration: metadata }, payload);
    const input = index % 3 ? 1000 : 0;
    diagnostics.saveResponse(id, { usage: { input, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: input } });
    diagnostics.finishCall(id, 'completed', 'response');
    if (input) eligible.push(id);
  }
  assert.deepEqual(diagnostics.calibrationCalls(key).map(call => call.callId), eligible.reverse().slice(0, 8));
});
