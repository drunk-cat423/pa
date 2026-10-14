import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig, readDataDir } from '../dist/config.js';

const valid = { PA_PROVIDER: 'test-provider', PA_MODEL: 'test-model', PA_API_KEY: 'private-test-key' };

test('后台整理允许0不限次数，保留有限预算和无效值校验', () => {
  assert.equal(readConfig(valid).memory.maxCalls, 20);
  assert.equal(readConfig({ ...valid, PA_MEMORY_MAX_CALLS: '0' }).memory.maxCalls, 0);
  assert.equal(readConfig({ ...valid, PA_MEMORY_MAX_CALLS: '1' }).memory.maxCalls, 1);
  for (const value of ['-1', '1.5', 'Infinity', '9007199254740992', 'no']) {
    assert.throws(() => readConfig({ ...valid, PA_MEMORY_MAX_CALLS: value }), /PA_MEMORY_MAX_CALLS/);
  }
});

test('搜索默认关闭，复用官方key但要求明确持久预算，拒绝其他供应商凭据', () => {
  assert.equal(readConfig(valid).search.enabled, false);
  const enabled = { ...valid, PA_PROVIDER: 'deepseek', PA_BASE_URL: 'https://api.deepseek.com',
    PA_SEARCH_ENABLED: 'true', PA_SEARCH_BUDGET_ID: 'trial-1' };
  assert.equal(readConfig(enabled).search.maxRequests, 0);
  assert.equal(readConfig(enabled).search.maxUses, 0);
  assert.equal(readConfig({ ...enabled, PA_SEARCH_MAX_REQUESTS: '3', PA_SEARCH_MAX_USES: '2' }).search.maxRequests, 3);
  assert.equal(readConfig({ ...enabled, PA_SEARCH_MAX_REQUESTS: '3', PA_SEARCH_MAX_USES: '2' }).search.maxUses, 2);
  assert.equal(readConfig(enabled).apiKey, valid.PA_API_KEY);
  for (const env of [{ ...enabled, PA_PROVIDER: 'other' }, { ...enabled, PA_BASE_URL: 'https://gateway.test' },
    { ...enabled, PA_SEARCH_BUDGET_ID: '' },
    { ...enabled, PA_SEARCH_MAX_USES: '6' }, { ...enabled, PA_SEARCH_MAX_TOKENS: '9999' }]) {
    assert.throws(() => readConfig(env));
  }
  for (const value of ['-1', '1.5', 'Infinity', '9007199254740992', 'no']) {
    for (const name of ['PA_SEARCH_MAX_REQUESTS', 'PA_SEARCH_MAX_USES']) {
      assert.throws(() => readConfig({ ...enabled, [name]: value }), new RegExp(name));
    }
  }
});

test('网页抓取独立于收费搜索，默认关闭且读取与DNS配置有硬上限', () => {
  const config = readConfig({ ...valid, PA_FETCH_ENABLED: 'true', PA_FETCH_PUBLIC_DNS: 'true' });
  assert.equal(config.search.enabled, false);
  assert.equal(config.fetch.enabled, true);
  assert.equal(config.fetch.publicDns, true);
  assert.equal(config.fetch.maxTextChars, 8000);
  for (const env of [{ PA_FETCH_PUBLIC_DNS: 'yes' }, { PA_FETCH_ENABLED: 'yes' },
    { PA_FETCH_TIMEOUT_MS: '30001' }, { PA_FETCH_MAX_BYTES: '1048577' }, { PA_FETCH_MAX_CHARS: '16001' }]) {
    assert.throws(() => readConfig({ ...valid, ...env }));
  }
});

test('配置不预选供应商，错误不泄露密钥', () => {
  assert.throws(() => readConfig({}), /PA_PROVIDER.*PA_MODEL.*PA_API_KEY/);
  assert.throws(() => readConfig({ PA_API_KEY: valid.PA_API_KEY }), error => !error.message.includes(valid.PA_API_KEY));
});

test('默认目录跟随项目且可配置，兼容服务地址显式保留', () => {
  const config = readConfig(valid, process.cwd());
  assert.equal(config.dataDir, resolve('.local/pa'));
  assert.equal(config.maxOutputTokens, 2048);
  assert.equal(config.timeoutMs, 60000);
  assert.equal(config.baseUrl, undefined);
  assert.equal(readConfig({ ...valid, PA_DATA_DIR: 'alternate' }).dataDir, resolve('alternate'));
  assert.equal(readDataDir({ PA_DATA_DIR: 'offline-data' }), resolve('offline-data'));
  assert.equal(readConfig({ ...valid, PA_BASE_URL: 'http://127.0.0.1:1234/v1' }).baseUrl, 'http://127.0.0.1:1234/v1');
});

test('拒绝无效预算和含隐式认证的地址', () => {
  for (const value of ['0', '-1', '1.2', 'Infinity', '9007199254740992']) {
    assert.throws(() => readConfig({ ...valid, PA_TIMEOUT_MS: value }), /PA_TIMEOUT_MS/);
  }
  assert.throws(() => readConfig({ ...valid, PA_TIMEOUT_MS: '2147483648' }), /PA_TIMEOUT_MS/);
  assert.throws(() => readConfig({ ...valid, PA_CONTEXT_WINDOW: '1024', PA_MAX_OUTPUT_TOKENS: '1024' }), /PA_MAX_OUTPUT_TOKENS/);
  for (const value of ['garbage', 'file:///secret', 'https://name:secret@example.org/v1', 'https://example.org/v1?key=secret', 'https://example.org/v1#secret']) {
    assert.throws(() => readConfig({ ...valid, PA_BASE_URL: value }), /PA_BASE_URL/);
  }
});

test('内置 Vertex 拒绝会触发本机 ADC 的密钥标记，兼容服务使用显式密钥', () => {
  for (const key of ['gcp-vertex-credentials', '<placeholder>', '<my-key>']) {
    assert.throws(() => readConfig({ ...valid, PA_PROVIDER: 'google-vertex', PA_API_KEY: key }), /显式 API 密钥/);
  }
  assert.equal(readConfig({ ...valid, PA_PROVIDER: 'google-vertex' }).apiKey, valid.PA_API_KEY);
  assert.equal(readConfig({ ...valid, PA_PROVIDER: 'google-vertex', PA_API_KEY: '<custom-token>', PA_BASE_URL: 'http://127.0.0.1:1234/v1' }).apiKey, '<custom-token>');
});

function cli(args, extraEnv = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PA_')) delete env[key];
  return spawnSync(process.execPath, ['dist/cli.js', ...args], {
    cwd: process.cwd(), env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 20000,
  });
}

test('真实 CLI 帮助无须密钥；缺配置和错误参数返回非零', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--conversation/);
  const missing = cli(['check']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /缺少配置/);
  for (const args of [['--unknown'], ['--conversation'], ['--message', ' '], ['check', '--message', 'hello'],
    ['history', '--limit', '0'], ['history', '--limit', '201'], ['history', '--message', 'hello']]) {
    assert.equal(cli(args).status, 1);
  }
});

test('CLI check 只检查格式，无请求也不输出密钥', () => {
  const result = cli(['check'], { ...valid, PA_BASE_URL: 'http://127.0.0.1:1/v1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /不调用模型/);
  assert.ok(!result.stdout.includes(valid.PA_API_KEY));
  assert.ok(!result.stderr.includes(valid.PA_API_KEY));
});
