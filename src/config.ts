import { resolve } from 'node:path';
import type { WebSearchConfig } from './web-search.js';
import type { WebFetchConfig } from './web-fetch.js';
import { parseWebFetchProxyUrl } from './web-fetch-proxy.js';

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
  tasks?: { maxConcurrent: number };
  loop?: { maxModelCalls: number; maxToolCalls: number };
  memory?: AutoMemoryConfig;
  search?: WebSearchConfig;
  fetch?: WebFetchConfig;
  research?: { enabled: boolean; maxModelCalls: number; maxToolCalls: number; maxSearchCalls: number };
}

export interface AutoMemoryConfig {
  enabled: boolean;
  /** 0 disables the per-start extraction call limit. */
  maxCalls: number;
  timeoutMs: number;
  maxOutputTokens?: number;
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

function nonNegativeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是 0（不限次数）或正整数。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} 必须是 0（不限次数）或正整数。`);
  return parsed;
}

function memoryCallLimit(env: NodeJS.ProcessEnv): number {
  const value = env.PA_MEMORY_MAX_CALLS?.trim() || '20';
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('PA_MEMORY_MAX_CALLS 必须为 0（不限次数）或正整数。');
  }
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
  const maxConcurrentTasks = positiveInteger(env, 'PA_MAX_CONCURRENT_TASKS', 2);
  if (maxConcurrentTasks > 16) throw new Error('PA_MAX_CONCURRENT_TASKS 必须在 1 到 16 之间。');
  const loop = { maxModelCalls: positiveInteger(env, 'PA_LOOP_MAX_MODEL_CALLS', 6),
    maxToolCalls: positiveInteger(env, 'PA_LOOP_MAX_TOOL_CALLS', 8) };
  const researchFlag = env.PA_RESEARCH_ENABLED?.trim() || 'true';
  if (!['true', 'false'].includes(researchFlag)) throw new Error('PA_RESEARCH_ENABLED 必须为 true 或 false。');
  const research = { enabled: researchFlag === 'true',
    maxModelCalls: positiveInteger(env, 'PA_RESEARCH_MAX_MODEL_CALLS', 16),
    maxToolCalls: positiveInteger(env, 'PA_RESEARCH_MAX_TOOL_CALLS', 24),
    maxSearchCalls: positiveInteger(env, 'PA_RESEARCH_MAX_SEARCH_CALLS', 6) };
  if (research.maxModelCalls < 2 || research.maxModelCalls > 50 || research.maxToolCalls > 100
    || research.maxSearchCalls > research.maxToolCalls) throw new Error('研究预算要求模型2到50次、工具最多100次、搜索不超过工具次数。');
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
    tasks: { maxConcurrent: maxConcurrentTasks },
    loop,
    research,
    memory: readAutoMemoryConfig(env),
    search: readWebSearchConfig(env, provider!, baseUrl),
    fetch: readWebFetchConfig(env),
  };
}

export function readWebFetchConfig(env: NodeJS.ProcessEnv): WebFetchConfig {
  const flag = env.PA_FETCH_ENABLED?.trim() || 'false';
  if (!['true', 'false'].includes(flag)) throw new Error('PA_FETCH_ENABLED 必须为 true 或 false。');
  const publicDns = env.PA_FETCH_PUBLIC_DNS?.trim() || 'false';
  if (!['true', 'false'].includes(publicDns)) throw new Error('PA_FETCH_PUBLIC_DNS 必须为 true 或 false。');
  const proxyUrl = env.PA_FETCH_PROXY_URL?.trim();
  if (proxyUrl) {
    try { parseWebFetchProxyUrl(proxyUrl); }
    catch { throw new Error('PA_FETCH_PROXY_URL 必须是无认证、路径、查询参数或片段的 HTTP 地址。'); }
  }
  const config: WebFetchConfig = { enabled: flag === 'true',
    publicDns: publicDns === 'true',
    ...(proxyUrl ? { proxyUrl } : {}),
    timeoutMs: positiveInteger(env, 'PA_FETCH_TIMEOUT_MS', 15000),
    maxResponseBytes: positiveInteger(env, 'PA_FETCH_MAX_BYTES', 1048576),
    maxTextChars: positiveInteger(env, 'PA_FETCH_MAX_CHARS', 8000) };
  if (config.timeoutMs > 30000 || config.maxResponseBytes > 1048576 || config.maxTextChars > 16000) {
    throw new Error('网页抓取配置超出允许范围。');
  }
  return config;
}

export function readWebSearchConfig(env: NodeJS.ProcessEnv, provider: string, baseUrl?: string): WebSearchConfig {
  const flag = env.PA_SEARCH_ENABLED?.trim() || 'false';
  if (!['true', 'false'].includes(flag)) throw new Error('PA_SEARCH_ENABLED 必须为 true 或 false。');
  const budgetId = env.PA_SEARCH_BUDGET_ID?.trim() || '';
  if (flag === 'true' && (!/^[a-zA-Z0-9_-]{1,80}$/.test(budgetId)
    || provider !== 'deepseek' || (baseUrl && !/^https:\/\/api\.deepseek\.com\/?(?:v1\/?)?$/.test(baseUrl)))) {
    throw new Error('搜索需官方 DeepSeek 配置及明确的 PA_SEARCH_BUDGET_ID；不会把其他供应商的密钥发送到 DeepSeek。');
  }
  const result: WebSearchConfig = { enabled: flag === 'true', budgetId,
    model: env.PA_SEARCH_MODEL?.trim() || 'deepseek-flash',
    maxRequests: nonNegativeInteger(env, 'PA_SEARCH_MAX_REQUESTS', 0),
    maxUses: nonNegativeInteger(env, 'PA_SEARCH_MAX_USES', 0),
    maxTokens: positiveInteger(env, 'PA_SEARCH_MAX_TOKENS', 2048),
    timeoutMs: positiveInteger(env, 'PA_SEARCH_TIMEOUT_MS', 60000),
    maxResults: positiveInteger(env, 'PA_SEARCH_MAX_RESULTS', 5) };
  if (result.maxRequests > 100 || result.maxUses > 5 || result.maxTokens > 4096
    || result.timeoutMs > 120000 || result.maxResults > 10 || !/^[a-zA-Z0-9_-]{1,100}$/.test(result.model)) {
    throw new Error('搜索预算、模型或结果上限超出支持范围。');
  }
  return result;
}

export function readAutoMemoryConfig(env: NodeJS.ProcessEnv): AutoMemoryConfig {
  const flag = env.PA_MEMORY_ENABLED?.trim() || 'false';
  if (!['true', 'false'].includes(flag)) throw new Error('PA_MEMORY_ENABLED 必须为 true 或 false。');
  const result: AutoMemoryConfig = { enabled: flag === 'true',
    maxCalls: memoryCallLimit(env),
    timeoutMs: positiveInteger(env, 'PA_MEMORY_TIMEOUT_MS', 120000),
    maxOutputTokens: positiveInteger(env, 'PA_MEMORY_MAX_OUTPUT_TOKENS', 8192) };
  if (result.timeoutMs > 2147483647) throw new Error('后台记忆超时配置超出范围。');
  return result;
}
