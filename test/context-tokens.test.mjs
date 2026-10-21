import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

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
