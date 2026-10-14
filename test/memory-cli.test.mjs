import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseMemoryRequest } from '../dist/memory-service.js';

test('显式删除命令本地拒绝，自然语言不走规则路由', () => {
  assert.equal(parseMemoryRequest('/forget memory-id').type, 'unsupported_delete');
  assert.equal(parseMemoryRequest('/memory delete memory-id').type, 'unsupported_delete');
  assert.equal(parseMemoryRequest('请忘掉我的饮食偏好'), undefined);
});

test('实际离线 CLI 记住、查询和纠正；旧删除命令被拒绝且内容保留', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-memory-cli-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const env = { ...process.env, PA_DATA_DIR: dataDir, PA_PROVIDER: '', PA_MODEL: '', PA_API_KEY: '', PA_BASE_URL: 'http://127.0.0.1:1/v1' };
  function run(args, expectedStatus = 0) {
    const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, expectedStatus, result.stderr);
    return expectedStatus === 0 ? JSON.parse(result.stdout) : result.stderr;
  }
  const original = '我喜欢乌龙茶 🙂  ';
  const remembered = run(['memory', 'remember', '--conversation', 'owner', '--kind', 'preference', '--content', original]);
  assert.equal(remembered.scope.key, 'owner');
  assert.equal(remembered.memory.content, original);
  assert.equal(remembered.memory.revision, 1);
  const id = remembered.memory.id;
  assert.equal(run(['memory', 'query', '--conversation', 'owner', '--query', '乌龙']).memories[0].id, id);
  assert.equal(run(['memory', 'query', '--conversation', 'other']).memories.length, 0);
  assert.match(run(['memory', 'correct', '--conversation', 'other', '--id', id, '--content', '越界'], 1), /记忆/);
  const corrected = run(['memory', 'correct', '--conversation', 'owner', '--id', id, '--content', '我现在更喜欢绿茶', '--expected-revision', '1']);
  assert.equal(corrected.memory.id, id);
  assert.equal(corrected.memory.revision, 2);
  assert.equal(corrected.contextResetRequired, true);
  assert.equal(run(['memory', 'query', '--conversation', 'owner', '--query', '乌龙']).memories.length, 0);
  assert.equal(run(['memory', 'query', '--conversation', 'owner', '--query', '绿茶']).memories.length, 1);
  assert.match(run(['memory', 'correct', '--conversation', 'owner', '--id', id, '--content', '过时修改', '--expected-revision', '1'], 1), /版本/);
  assert.match(run(['memory', 'delete', '--conversation', 'owner', '--id', id, '--expected-revision', '2'], 1), /不提供删除/);
  assert.equal(run(['memory', 'query', '--conversation', 'owner']).memories[0].content, '我现在更喜欢绿茶');
  for (const args of [
    ['memory'], ['memory', 'unknown'], ['memory', 'remember'], ['memory', 'remember', '--content', ' '],
    ['memory', 'query', '--limit', '201'], ['memory', 'delete'], ['memory', 'remember', '--content', 'x', '--kind', 'unknown'],
  ]) run(args, 1);
});
