import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { mergeCredentials, saveCredentials } from '../scripts/qq-bind-config.mjs';

const credentials = { appId: '123456789', appSecret: 'test-secret-only' };

test('扫码凭证写入保留其他配置、注释与 CRLF，重新绑定不增加重复字段', () => {
  const original = '# untouched\r\nPA_API_KEY="test-model-only"\r\nPA_MODEL=local\r\nPA_QQ_APP_ID=\r\nPA_QQ_APP_SECRET=\r\n';
  const result = mergeCredentials(original, credentials);
  assert.deepEqual(parseEnv(result), { PA_API_KEY: 'test-model-only', PA_MODEL: 'local', PA_QQ_APP_ID: '123456789', PA_QQ_APP_SECRET: 'test-secret-only' });
  assert.ok(result.startsWith('# untouched\r\n'));
  assert.equal(mergeCredentials(result, credentials), result);
});

test('拒绝格式注入、重复 QQ 字段，以及会改变其他多行字段的更新', () => {
  for (const secret of ['bad\nPA_API_KEY=changed', 'bad"value', 'bad\\value', '']) {
    assert.throws(() => mergeCredentials('', { ...credentials, appSecret: secret }));
  }
  assert.throws(() => mergeCredentials('PA_QQ_APP_ID=1\nPA_QQ_APP_ID=2', credentials));
  assert.throws(() => mergeCredentials('OTHER="first\nPA_QQ_APP_ID=inside\nlast"', credentials));
});

test('原子保存成功可重新读取，失败保留原文件且不残留含凭证临时文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-qq-bind-'));
  const path = join(directory, '.env');
  try {
    writeFileSync(path, 'PA_MODEL=local\n');
    saveCredentials(path, credentials);
    assert.equal(parseEnv(readFileSync(path, 'utf8')).PA_MODEL, 'local');
    assert.equal(parseEnv(readFileSync(path, 'utf8')).PA_QQ_APP_SECRET, credentials.appSecret);
    const invalid = 'PA_QQ_APP_SECRET=first\nPA_QQ_APP_SECRET=second\n';
    writeFileSync(path, invalid);
    assert.throws(() => saveCredentials(path, credentials));
    assert.equal(readFileSync(path, 'utf8'), invalid);
    assert.deepEqual(readdirSync(directory), ['.env']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
