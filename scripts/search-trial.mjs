// One bounded live harness trial. Load the ignored .env with Node's --env-file option.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig } from '../dist/config.js';
import { openConversation } from '../dist/runtime.js';

const config = readConfig();
if (!config.search?.enabled || config.search.maxRequests !== 1 || config.search.maxUses !== 1) {
  throw new Error('真实测试要求显式启用搜索，MAX_REQUESTS=1 且 MAX_USES=1。');
}
const directory = join(config.cwd, '.local', 'search-trials', config.search.budgetId);
await mkdir(directory, { recursive: true });
// Reserve this runner before model invocation; rerunning never repeats an uncertain paid call.
await writeFile(join(directory, 'started.json'), JSON.stringify({ startedAt: new Date().toISOString(),
  budgetId: config.search.budgetId, maxSearchRequests: 1, maxServerSearches: 1 }), { flag: 'wx', mode: 0o600 });
const question = '请搜索 DeepSeek 官方文档中 Claude Code 的 Web Search 支持与计费说明，用中文简短回答并附官方来源。';
let runtime;
try {
  runtime = await openConversation({ ...config, timeoutMs: 120000 }, `search-trial:${config.search.budgetId}`, { enableSearch: true });
  const startedAt = Date.now();
  const answer = await runtime.prompt(question, { runId: `trial:${config.search.budgetId}`,
    searchQuery: 'DeepSeek 官方文档中 Claude Code 的 Web Search 支持与计费说明' });
  const entries = (await readFile(runtime.info().sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const messages = entries.filter(entry => entry.type === 'message').map(entry => entry.message);
  const mainRequests = messages.filter(message => message.role === 'assistant').map(message => ({
    stopReason: message.stopReason, usage: { input: message.usage.input, output: message.usage.output,
      cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite, totalTokens: message.usage.totalTokens },
  }));
  const toolResults = messages.filter(message => message.role === 'toolResult' && message.toolName === 'web_search');
  const searches = toolResults.filter(message => !message.isError && message.details?.attemptId)
    .map(message => message.details).filter(details => details?.usage);
  const searchSucceeded = searches.length === 1;
  const mainTokens = mainRequests.reduce((sum, request) => sum + request.usage.totalTokens, 0);
  const searchTokens = searchSucceeded && searches.every(search => search.usage.totalTokens !== null)
    ? searches.reduce((sum, search) => sum + search.usage.totalTokens, 0) : null;
  const serverLimitExceeded = searches.some(search => search.usage.serverSearches > config.search.maxUses);
  const report = { status: !searchSucceeded ? 'search_failed_usage_unknown'
    : serverLimitExceeded ? 'search_completed_server_limit_exceeded' : 'search_completed', serverLimitExceeded,
    question, answer, elapsedMs: Date.now() - startedAt, provider: config.provider,
    model: config.model, searchModel: config.search.model, mainRequests, searches,
    totalTokens: searchTokens === null ? null : mainTokens + searchTokens, mainTokens, searchTokens,
    toolErrors: toolResults.filter(message => message.isError).map(message => message.content), sessionFile: runtime.info().sessionFile,
    budgetId: config.search.budgetId, maxSearchRequests: 1, requestedMaxServerSearches: 1,
    tokenAccounting: 'Anthropic usage fields: input + output + cache_read + cache_creation; not a reconciled invoice' };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!searchSucceeded || serverLimitExceeded) process.exitCode = 1;
} catch (error) {
  const report = { status: 'failed_no_retry', errorType: error?.name ?? 'UnknownError',
    sessionFile: runtime?.info().sessionFile, budgetId: config.search.budgetId };
  await writeFile(join(directory, 'failure.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
  process.exitCode = 1;
} finally { await runtime?.close(); }
