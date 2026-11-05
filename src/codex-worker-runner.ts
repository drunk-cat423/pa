import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { CodexTask } from './codex-worker-store.js';

export interface CodexWorkerConfig {
  directory: string; source: string; binary: string; modules: string; owner: string; socket: string; home: string; logFile?: string;
}
const OUTPUT_LIMIT = 180_000; // Leave room for the command log in QQ's 1 MiB text attachment.
function executionEnvironment(home?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home ?? process.env.HOME,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C.UTF-8' };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
function clipped(text: string, limit = OUTPUT_LIMIT): string {
  return text.length <= limit ? text : text.slice(0, limit) + '\n[内容超过大小上限，已截断。]';
}
export function codexArguments(config: CodexWorkerConfig, task: CodexTask, workspace: string): string[] {
  const filesystem: Record<string, string> = { ':root': 'read', [config.home]: 'deny', [config.directory]: 'deny',
    '/var/lib/pa': 'deny', '/etc/pa': 'deny', '/root': 'deny', [config.socket]: 'deny',
    [workspace]: task.mode === 'fix' ? 'write' : 'read', [join(workspace, '.git')]: 'read',
    [join(workspace, '.codex')]: 'read', [join(workspace, '.agents')]: 'read', [config.modules]: 'read' };
  if (config.logFile) filesystem[config.logFile] = 'read';
  const toml = '{' + Object.entries(filesystem).map(([path, mode]) => `${JSON.stringify(path)}=${JSON.stringify(mode)}`).join(',') + '}';
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '-m', 'gpt-6.1-sol',
    '-c', 'model_reasoning_effort="high"', '-c', 'default_permissions="pa_task"',
    '-c', `permissions.pa_task.filesystem=${toml}`, '-c', 'permissions.pa_task.network.enabled=false',
    '-c', 'approval_policy="never"', '--json'];
  if (task.threadId) args.push('resume', task.threadId);
  args.push('-');
  return args;
}
async function command(binary: string, args: string[], cwd: string, max = OUTPUT_LIMIT): Promise<string> {
  return await new Promise((accept, reject) => {
    const child = spawn(binary, args, { cwd, env: executionEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', exceeded = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { output += text; if (output.length > max) { exceeded = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', (text: string) => { errors = clipped(errors + text, 4000); });
    child.on('error', reject);
    child.on('close', code => {
      if (exceeded) reject(new Error('结果超过大小上限，请缩小改动后续办。'));
      else if (code !== 0) reject(new Error(`本地命令失败 (${code ?? 'signal'})：${clipped(errors, 1000)}`));
      else accept(output);
    });
  });
}
export async function prepareCodexWorkspace(config: CodexWorkerConfig, task: CodexTask): Promise<string> {
  const workspace = join(config.directory, 'workspaces', task.id);
  if (task.baseCommit) {
    if (!existsSync(workspace) || lstatSync(workspace).isSymbolicLink()) throw new Error('任务工作目录丢失或被重定向。');
    return workspace;
  }
  const source = realpathSync(config.source);
  if (!isAbsolute(source) || source === resolve(config.directory)) throw new Error('Codex 源码目录无效。');
  if (existsSync(workspace)) {
    if (lstatSync(workspace).isSymbolicLink()) throw new Error('任务工作目录被重定向。');
    // A crash can happen after publishing the complete baseline and before saving task metadata.
    task.baseCommit = (await command('git', ['rev-parse', 'HEAD'], workspace)).trim();
    task.source = source;
    return workspace;
  }
  const disk = statfsSync(config.directory);
  if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error('服务器磁盘余量不足2GiB，暂停新建Codex工作目录。');
  mkdirSync(join(config.directory, 'workspaces'), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(config.directory, 'workspaces', '.prepare-'));
  // Copy only versioned development inputs, never env, service data or deployment credentials.
  for (const name of ['src', 'test', 'docs', 'scripts', '.agents', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    const input = join(source, name);
    if (!existsSync(input)) continue;
    cpSync(input, join(staging, name), { recursive: true, dereference: false,
      filter: path => !lstatSync(path).isSymbolicLink() });
  }
  // The root-owned cache is pinned to this deployment's lockfile and mounted read-only for model commands.
  const modules = realpathSync(config.modules);
  if ((lstatSync(modules).mode & 0o022) !== 0 || lstatSync(modules).uid === process.getuid?.()) {
    throw new Error('Codex依赖缓存必须由其他账号持有且不可组写。');
  }
  symlinkSync(modules, join(staging, 'node_modules'), 'dir');
  mkdirSync(join(staging, '.codex'), { mode: 0o700 }); // Bind an existing, empty directory read-only for every revision.
  writeFileSync(join(staging, '.gitignore'), 'node_modules/\ndist/\n.env\n.local/\n', { mode: 0o600 });
  await command('git', ['init', '-q'], staging);
  await command('git', ['add', '--all'], staging);
  await command('git', ['-c', 'user.name=PA Codex', '-c', 'user.email=pa-codex@localhost', 'commit', '-qm', 'Task baseline'], staging);
  task.baseCommit = (await command('git', ['rev-parse', 'HEAD'], staging)).trim();
  renameSync(staging, workspace);
  task.source = source;
  return workspace;
}

export async function runCodexTask(config: CodexWorkerConfig, task: CodexTask,
  persist: () => void, onChild?: (child: ReturnType<typeof spawn>) => void): Promise<void> {
  const workspace = await prepareCodexWorkspace(config, task);
  persist();
  const revisionDirectory = join(config.directory, 'results', `${task.id}-${task.revision}`);
  mkdirSync(revisionDirectory, { recursive: true, mode: 0o700 });
  const outputPath = join(revisionDirectory, 'events.jsonl');
  const evidence: string[] = [];
  let final = '', errorText = '', outputBytes = 0, failed = false;
  const prompt = `你是 PA 委派的服务器任务执行者。当前工作目录就是 PA 已为本任务创建的独立 Git 副本。${task.mode === 'fix' ? '直接在当前根目录修改源码和测试；另建嵌套副本或在忽略目录中改代码，PA 将无法交付这些改动。' : '本轮只读检查。'}\n`
    + '最终回复会直接发给委派人。用两三句中文说清做了什么、实际验证到什么效果；如果只完成一部分、还没验证或遇到阻塞，明确说明。只读任务直接回答查到的结论。省略补丁、代码块、命令和日志。'
    + '不要部署、推送、发送QQ消息或修改服务，不读取凭证、其他任务和生产数据库。'
    + '仓库约定适用。修改时只做用户要求的小修复，选择一条针对性测试；测试失败可以修正后重跑，不扩大为全量测试。'
    + (config.logFile ? `\n可用的服务器诊断日志是 ${config.logFile}，这是经脱敏的只读材料。` : '')
    + `\n当前用户要求\n${task.prompt}\n`;
  const args = codexArguments(config, task, workspace);
  writeFileSync(join(revisionDirectory, 'invocation.json'), JSON.stringify({ model: task.model, reasoning: task.reasoning,
    threadId: task.threadId, baseCommit: task.baseCommit, source: task.source, args, promptHash: createHash('sha256').update(prompt).digest('hex') }), { mode: 0o600 });
  const exit = await new Promise<number | null>((accept, reject) => {
    const child = spawn(config.binary, args, { cwd: workspace, env: executionEnvironment(config.home), stdio: ['pipe', 'pipe', 'pipe'] });
    onChild?.(child);
    let pending = '';
    const event = (line: string): void => {
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > 8_000_000) { failed = true; errorText = 'Codex 输出超过安全上限，已停止本轮。'; child.kill('SIGTERM'); return; }
      appendFileSync(outputPath, line + '\n', { mode: 0o600 });
      let value: Record<string, unknown>;
      try { value = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (value.type === 'thread.started' && typeof value.thread_id === 'string') {
        if (task.threadId && task.threadId !== value.thread_id) {
          failed = true; errorText = 'Codex 返回了不同的会话 ID，已停止本轮。'; child.kill('SIGTERM'); return;
        }
        task.threadId = value.thread_id;
        persist();
      }
      if (value.type === 'turn.failed') { failed = true; errorText = clipped(JSON.stringify(value), 1500); }
      if (value.type === 'error') errorText = clipped(JSON.stringify(value), 1500);
      if (value.type !== 'item.completed' || !value.item || typeof value.item !== 'object') return;
      const item = value.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') final = clipped(item.text, 14_000);
      if (item.type === 'command_execution') {
        evidence.push(`$ ${clipped(String(item.command ?? ''), 2000)}\nexit=${String(item.exit_code)}\n${clipped(String(item.aggregated_output ?? ''), 6000)}`);
        if (evidence.length > 40) evidence.shift();
      }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      pending += text;
      if (pending.length > 1_000_000) { failed = true; errorText = 'Codex 单条输出过大。'; child.kill('SIGTERM'); return; }
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines) if (line) event(line);
    });
    child.stderr.on('data', (text: string) => { errorText = clipped(errorText + text, 6000); });
    child.on('error', reject);
    child.on('close', code => { if (pending) event(pending); accept(code); });
    child.stdin.end(prompt);
  });
  task.evidence = clipped(evidence.join('\n\n'), 80_000);
  task.summary = final || clipped(errorText || 'Codex 未返回最终说明。', 6000);
  task.status = exit === 0 && !failed && Boolean(final) ? 'completed' : 'failed';
  if (task.status === 'failed' && final) task.summary += '\n\n执行异常：' + clipped(errorText || `exit=${exit}`, 1500);
  writeFileSync(join(revisionDirectory, 'commands.txt'), task.evidence, { mode: 0o600 });
  try {
    await command('git', ['add', '--intent-to-add', '--all'], workspace);
    task.diff = await command('git', ['diff', '--no-ext-diff', '--no-textconv', task.baseCommit!, '--'], workspace);
  } catch (error) {
    task.status = 'failed';
    task.diff = '未能导出完整 diff：' + (error instanceof Error ? error.message : '未知错误');
    task.summary = task.diff + '\n' + task.summary;
  }
  if (task.mode === 'fix' && task.diff === '') {
    task.summary = 'Git 核对：任务工作树与起始基线一致，本次没有可交付的代码改动。\n' + task.summary;
  }
  writeFileSync(join(revisionDirectory, 'diff.txt'), task.diff, { mode: 0o600 });
  writeFileSync(join(revisionDirectory, 'summary.txt'), task.summary, { mode: 0o600 });
  persist();
}
