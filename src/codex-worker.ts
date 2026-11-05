import { createServer, type IncomingMessage } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { CodexWorkerStore, type CodexSubmission, type CodexTask } from './codex-worker-store.js';
import { runCodexTask, type CodexWorkerConfig } from './codex-worker-runner.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
export function codexWorkerConfig(env: NodeJS.ProcessEnv = process.env): CodexWorkerConfig {
  const config: CodexWorkerConfig = { directory: required(env, 'PA_CODEX_STATE_DIR'), source: required(env, 'PA_CODEX_SOURCE_DIR'),
    binary: required(env, 'PA_CODEX_BIN'), modules: required(env, 'PA_CODEX_MODULES_DIR'), owner: required(env, 'PA_CODEX_OWNER'),
    socket: required(env, 'PA_CODEX_SOCKET'), home: required(env, 'HOME'),
    ...(env.PA_CODEX_LOG_FILE ? { logFile: env.PA_CODEX_LOG_FILE } : {}) };
  if (![config.directory, config.source, config.binary, config.modules, config.socket, config.home, ...(config.logFile ? [config.logFile] : [])].every(isAbsolute)) {
    throw new Error('Codex paths must be absolute.');
  }
  if (!/^[a-f0-9]{64}$/.test(config.owner)) throw new Error('Codex owner must be the configured private route identity hash.');
  config.source = realpathSync(config.source);
  return config;
}
async function body(request: IncomingMessage): Promise<unknown> {
  let content = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    content += String(chunk);
    if (Buffer.byteLength(content) > 20_000) throw new Error('请求内容过长。');
  }
  return JSON.parse(content);
}
function submission(value: unknown, owner: string): CodexSubmission {
  if (!value || typeof value !== 'object') throw new Error('无效任务。');
  const input = value as Record<string, unknown>;
  if (input.owner !== owner) throw new Error('无权操作该执行器。');
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(input.requestId)
    || !['read', 'fix'].includes(String(input.mode)) || typeof input.prompt !== 'string'
    || input.prompt.trim().length < 1 || input.prompt.length > 12_000
    || (input.taskId !== undefined && (typeof input.taskId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.taskId)))) {
    throw new Error('无效任务参数。');
  }
  return { requestId: input.requestId, owner, mode: input.mode as 'read' | 'fix', prompt: input.prompt,
    ...(input.taskId ? { taskId: input.taskId as string } : {}) };
}

export async function startCodexWorker(config: CodexWorkerConfig): Promise<{ close(): Promise<void> }> {
  const store = new CodexWorkerStore(config.directory);
  const report = (task: CodexTask): CodexTask => {
    const view = { ...task };
    const result = join(config.directory, 'results', `${task.id}-${task.revision}`);
    for (const [key, filename] of [['summary', 'summary.txt'], ['evidence', 'commands.txt'], ['diff', 'diff.txt']] as const) {
      const file = join(result, filename);
      if (existsSync(file)) {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_100_000) throw new Error('Codex报告文件无效。');
        view[key] = readFileSync(file, 'utf8');
      }
    }
    return view;
  };
  let active = false, stopping = false, child: ChildProcess | undefined;
  const tick = async (): Promise<void> => {
    if (active || stopping) return;
    const task = store.claim();
    if (!task) return;
    active = true;
    try {
      await runCodexTask(config, task, () => store.update(task), process => { child = process; });
    } catch (error) {
      task.status = 'failed';
      task.summary = `Codex 执行失败：${error instanceof Error ? error.message : 'unknown error'}`;
      store.update(task);
    } finally {
      active = false;
      child = undefined;
      if (!stopping) setImmediate(() => { void tick(); });
    }
  };
  const server = createServer((request, response) => {
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/tasks') {
        const receipt = store.submit(submission(await body(request), config.owner));
        send(202, receipt);
        setImmediate(() => { void tick(); });
        return;
      }
      if (request.method !== 'GET' || url.searchParams.get('owner') !== config.owner) {
        send(403, { error: '无权访问该执行器。' }); return;
      }
      if (url.pathname === '/tasks') {
        const requestId = url.searchParams.get('requestId') ?? undefined;
        const tasks = store.list(config.owner, requestId);
        send(200, { tasks: requestId ? tasks.map(report) : tasks.slice(0, 50).map(task => ({ id: task.id, revision: task.revision,
          requestId: task.requestId, status: task.status, summary: task.summary?.slice(0, 500) })) }); return;
      }
      const match = /^\/tasks\/([a-f0-9-]{36})$/.exec(url.pathname);
      const revision = url.searchParams.get('revision');
      const task = match ? store.get(match[1]!, config.owner, revision ? Number(revision) : undefined) : undefined;
      send(task ? 200 : 404, task ? report(task) : { error: '没有找到该任务。' });
    })().catch(error => { if (!response.headersSent) send(400, { error: error instanceof Error ? error.message : '执行器请求失败。' }); });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  mkdirSync(dirname(config.socket), { recursive: true, mode: 0o750 });
  if (existsSync(config.socket)) {
    if (!lstatSync(config.socket).isSocket()) throw new Error('Codex socket path is not a socket.');
    unlinkSync(config.socket);
  }
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(config.socket, accept); });
  chmodSync(config.socket, 0o660);
  const timer = setInterval(() => { void tick(); }, 1000);
  timer.unref();
  void tick();
  return { async close() {
    stopping = true;
    clearInterval(timer);
    child?.kill('SIGTERM');
    server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
  } };
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  startCodexWorker(codexWorkerConfig()).then(worker => {
    process.once('SIGTERM', () => { void worker.close().then(() => process.exit(0)); });
    process.once('SIGINT', () => { void worker.close().then(() => process.exit(0)); });
    console.log('Codex worker ready; model=gpt-6.1-sol reasoning=high concurrency=1.');
  }).catch(error => { console.error(error instanceof Error ? error.message : 'Codex worker startup failed.'); process.exitCode = 1; });
}
