import { resolve } from 'node:path';

export interface PaConfig {
  cwd: string;
  dataDir: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  contextWindow: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export function readDataDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return resolve(cwd, env.PA_DATA_DIR?.trim() || '.local/pa');
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是正整数。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是正整数。`);
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): PaConfig {
  const provider = env.PA_PROVIDER?.trim();
  const model = env.PA_MODEL?.trim();
  const apiKey = env.PA_API_KEY?.trim();
  const missing = [!provider && 'PA_PROVIDER', !model && 'PA_MODEL', !apiKey && 'PA_API_KEY'].filter(Boolean);
  if (missing.length) {
    throw new Error(`缺少配置：${missing.join('、')}。请复制 .env.example 为 .env 并填写，参见 README。`);
  }
  const contextWindow = positiveInteger(env, 'PA_CONTEXT_WINDOW', 32768);
  const maxOutputTokens = positiveInteger(env, 'PA_MAX_OUTPUT_TOKENS', 2048);
  const timeoutMs = positiveInteger(env, 'PA_TIMEOUT_MS', 60000);
  if (maxOutputTokens >= contextWindow) {
    throw new Error('PA_MAX_OUTPUT_TOKENS 必须小于 PA_CONTEXT_WINDOW。');
  }
  if (timeoutMs > 2147483647) throw new Error('PA_TIMEOUT_MS 超出 Node 定时器范围。');
  const baseUrl = env.PA_BASE_URL?.trim();
  // Pi treats these Vertex values as ADC selectors, rather than explicit API keys.
  if (!baseUrl && provider === 'google-vertex'
    && (apiKey === 'gcp-vertex-credentials' || /^<[^>]+>$/.test(apiKey!))) {
    throw new Error('内置 google-vertex 仅允许显式 API 密钥，不能使用 ADC 标记或占位密钥。');
  }
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('PA_BASE_URL 必须是有效的 HTTP(S) 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('PA_BASE_URL 必须是 HTTP(S) 地址，且不能包含账号、密码、查询参数或片段。');
    }
  }
  return {
    cwd: resolve(cwd),
    dataDir: readDataDir(env, cwd),
    provider: provider!,
    model: model!,
    apiKey: apiKey!,
    ...(baseUrl ? { baseUrl } : {}),
    contextWindow,
    maxOutputTokens,
    timeoutMs,
  };
}
