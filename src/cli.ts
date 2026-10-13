import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { readConfig, readDataDir } from './config.js';
import { MemoryError, type MemoryInput, type MemoryChange, type MemoryRecord } from './memory-types.js';
import { parseMemoryRequest } from './memory-service.js';

const help = `pa — TypeScript 个人伙伴的本地对话入口

用法：
  npm start -- [chat] [--conversation <名称>] [--message <内容>]
  npm start -- history [--conversation <名称>] [--limit <1-200>]
  npm start -- memory remember --content <内容> [--conversation <名称>]
  npm start -- memory query [--query <关键词>] [--conversation <名称>]
  npm start -- memory correct --id <ID> --content <新内容> [--conversation <名称>]
  npm start -- check
  npm start -- --help

默认会话：local-owner。同名会话恢复 Pi 上下文，不同名称使用独立历史。
交互指令：/help、/info、/history、/remember 内容、/memories [关键词]、/correct ID 新内容、/exit。
SQLite 保存原文、显式记忆与人物画像；PA_MEMORY_ENABLED=true 时启用独立后台整理。
history 和 memory 指令无须模型密钥，不请求模型；不提供删除操作。
memory remember/correct 可选 --kind fact|preference|episode、--source-message-id <来源用户消息ID>。
memory correct 可选 --expected-revision <版本>；query 可选 --limit <1-200>。
模型配置：在 .env 中填写 PA_PROVIDER、PA_MODEL、PA_API_KEY。
`;

interface Options {
  command: 'chat' | 'check' | 'help' | 'history' | 'memory';
  conversationId: string;
  limit: number;
  message?: string;
  action?: 'remember' | 'query' | 'correct';
  content?: string;
  query?: string;
  memoryId?: string;
  kind?: 'fact' | 'preference' | 'episode';
  sourceMessageId?: string;
  expectedRevision?: number;
}

function parseMemoryArgs(args: string[]): Options {
  const action = args[1];
  if (action === 'delete') throw new MemoryError('不提供删除记忆的操作；可以使用 correct 纠正信息。');
  if (action !== 'remember' && action !== 'query' && action !== 'correct') {
    throw new MemoryError('memory 需要 remember、query 或 correct 操作。');
  }
  const options: Options = { command: 'memory', action, conversationId: 'local-owner', limit: 20 };
  const allowed = new Set(['--conversation']);
  if (action === 'query') { allowed.add('--query'); allowed.add('--limit'); }
  if (action === 'remember' || action === 'correct') {
    allowed.add('--content'); allowed.add('--kind'); allowed.add('--source-message-id');
  }
  if (action === 'correct') { allowed.add('--id'); allowed.add('--expected-revision'); }
  for (let index = 2; index < args.length; index++) {
    const flag = args[index]!;
    if (!allowed.has(flag)) throw new MemoryError(`此记忆操作不支持参数：${flag}。`);
    const value = args[++index];
    if (value === undefined || !value.trim()) throw new MemoryError(`${flag} 需要非空值。`);
    switch (flag) {
      case '--conversation': options.conversationId = value; break;
      case '--content': options.content = value; break;
      case '--query': options.query = value; break;
      case '--id': options.memoryId = value; break;
      case '--source-message-id': options.sourceMessageId = value; break;
      case '--kind':
        if (value !== 'fact' && value !== 'preference' && value !== 'episode') throw new MemoryError('--kind 必须是 fact、preference 或 episode。');
        options.kind = value;
        break;
      case '--expected-revision':
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new MemoryError('--expected-revision 必须是正整数。');
        options.expectedRevision = Number(value);
        break;
      case '--limit':
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) throw new MemoryError('--limit 必须是 1 到 200 的整数。');
        options.limit = Number(value);
    }
  }
  if ((action === 'remember' || action === 'correct') && options.content === undefined) throw new MemoryError('此操作需要 --content。');
  if (action === 'correct' && options.memoryId === undefined) throw new MemoryError('此操作需要 --id。');
  if (options.conversationId.length > 200) throw new MemoryError('会话名称不能超过 200 个字符。');
  return options;
}

function parseArgs(args: string[]): Options {
  if (args[0] === 'memory') return parseMemoryArgs(args);
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    return { command: 'help', conversationId: 'local-owner', limit: 20 };
  }
  if (args.length === 1 && args[0] === 'check') return { command: 'check', conversationId: 'local-owner', limit: 20 };
  const command = args[0] === 'history' ? 'history' : 'chat';
  const options: Options = { command, conversationId: 'local-owner', limit: 20 };
  const rest = ['chat', 'history'].includes(args[0] ?? '') ? args.slice(1) : args;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag !== '--conversation' && !(command === 'chat' && flag === '--message')
      && !(command === 'history' && flag === '--limit')) {
      throw new Error(`未知参数：${flag}。使用 --help 查看用法。`);
    }
    const value = rest[++index];
    if (!value || !value.trim()) throw new Error(`${flag} 需要非空值。`);
    if (flag === '--conversation') options.conversationId = value;
    else if (flag === '--message') options.message = value;
    else {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) {
        throw new Error('--limit 必须是 1 到 200 的整数。');
      }
      options.limit = Number(value);
    }
  }
  if (options.conversationId.length > 200) throw new Error('会话名称不能超过 200 个字符。');
  return options;
}

interface MemoryAccess {
  remember(input: MemoryInput): MemoryChange;
  queryMemories(query?: string, limit?: number): MemoryRecord[];
  correctMemory(id: string, input: MemoryInput, expectedRevision?: number): MemoryChange;
}

function performMemory(target: MemoryAccess, options: Options): unknown {
  const scope = { type: 'conversation', key: options.conversationId };
  const input: MemoryInput = {
    content: options.content ?? '',
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.sourceMessageId === undefined ? {} : { sourceMessageId: options.sourceMessageId }),
  };
  switch (options.action) {
    case 'remember': return { scope, ...target.remember(input) };
    case 'query': return { scope, memories: target.queryMemories(options.query, options.limit) };
    case 'correct': return { scope, ...target.correctMemory(options.memoryId!, input, options.expectedRevision) };
    default: throw new MemoryError('未知记忆操作。');
  }
}

function interactiveMemory(line: string, conversationId: string): Options | undefined {
  let args: string[] | undefined;
  if (/^\/remember(?:\s|$)/.test(line)) args = ['remember', '--content', line.slice('/remember'.length).trimStart()];
  else if (/^\/memories(?:\s|$)/.test(line)) {
    const query = line.slice('/memories'.length).trim();
    args = ['query', ...(query ? ['--query', query] : [])];
  } else if (/^\/correct(?:\s|$)/.test(line)) {
    const match = /^\/correct\s+(\S+)\s+([\s\S]+)$/.exec(line);
    if (!match) throw new MemoryError('用法：/correct ID 新内容。');
    args = ['correct', '--id', match[1]!, '--content', match[2]!];
  }
  return args ? parseMemoryArgs(['memory', ...args, '--conversation', conversationId]) : undefined;
}

function reportError(error: unknown): void {
  let message = error instanceof Error ? error.message : String(error);
  const key = process.env.PA_API_KEY?.trim();
  if (key) message = message.replaceAll(key, '[已隐藏密钥]');
  console.error(`pa：${message}`);
}

class OutputError extends Error {}

async function writeLine(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { reject(new OutputError('终端输出失败。', { cause: error })); };
    // write callbacks propagate failures; the listener also consumes the stream error event.
    process.stdout.once('error', onError);
    process.stdout.write(`${text}\n`, error => {
      if (error) { onError(error); return; }
      process.stdout.off('error', onError);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') { await writeLine(help); return; }
  if (options.command === 'memory') {
    const { openMemory } = await import('./memory.js');
    const session = await openMemory(readDataDir(), options.conversationId);
    try {
      await writeLine(JSON.stringify(performMemory({
        remember: input => session.remember(input),
        queryMemories: (query, limit) => session.query(query, limit),
        correctMemory: (id, input, revision) => session.correct(id, input, revision),
      }, options), null, 2));
    } finally { await session.close(); }
    return;
  }
  if (options.command === 'history') {
    const { ConversationStore } = await import('./store.js');
    const store = new ConversationStore(join(readDataDir(), 'pa.sqlite'));
    try { await writeLine(JSON.stringify(store.listMessages(options.conversationId, options.limit), null, 2)); }
    finally { store.close(); }
    return;
  }
  const config = readConfig();
  if (options.command === 'check') {
    await writeLine(`配置格式有效：${config.provider}/${config.model}\n数据目录：${config.dataDir}\nAPI 密钥：已配置（不显示）\n调用超时：${config.timeoutMs}ms\n此检查不调用模型；模型是否可用由首次对话验证。`);
    return;
  }
  const { openRecordedConversation, PersistenceError } = await import('./conversation.js');
  const runtime = await openRecordedConversation(config, options.conversationId);
  let reader: ReturnType<typeof createInterface> | undefined;
  let interrupted = false;
  let outputInProgress = false;
  const interrupt = (): void => {
    if (interrupted) return;
    interrupted = true;
    process.exitCode = 130;
    reader?.close();
    // Once output starts, respond() must finish its delivery acknowledgement before closing.
    // During a model request close() still cancels immediately and records the interrupted run.
    if (!outputInProgress) void runtime.close().catch(reportError);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  async function respond(text: string, prefix: string): Promise<void> {
    const result = await runtime.prompt(text);
    if (interrupted) return;
    outputInProgress = true;
    try {
      try { await writeLine(`${prefix}${result.text}`); }
      catch (error) { runtime.acknowledge(result.deliveryId, 'uncertain'); throw error; }
      runtime.acknowledge(result.deliveryId, 'sent');
    } finally { outputInProgress = false; }
  }
  try {
    if (options.message !== undefined) { await respond(options.message, ''); return; }
    await writeLine(`会话：${options.conversationId}（已有 ${runtime.info().messageCount} 条上下文消息）\n输入 /help 查看指令，/exit 退出。`);
    reader = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    reader.on('SIGINT', interrupt);
    reader.setPrompt('你 > ');
    if (process.stdin.isTTY) reader.prompt();
    for await (const line of reader) {
      if (interrupted) break;
      const command = line.trim();
      if (command === '/exit') break;
      if (command === '/help') await writeLine('直接输入消息。/info、/history、/remember 内容、/memories [关键词]、/correct ID 新内容、/exit。');
      else if (command === '/info') await writeLine(JSON.stringify(runtime.info(), null, 2));
      else if (command === '/history') await writeLine(JSON.stringify(runtime.history(20), null, 2));
      else if (command) {
        try {
          if (parseMemoryRequest(line)?.type === 'unsupported_delete') {
            await writeLine('不提供删除记忆或偏好的操作；你可以明确纠正信息，我会保留原记录并更新当前内容。');
            if (process.stdin.isTTY && !interrupted) reader.prompt();
            continue;
          }
          const memoryOptions = interactiveMemory(line.trimStart(), options.conversationId);
          if (memoryOptions) await writeLine(JSON.stringify(performMemory(runtime, memoryOptions), null, 2));
          else await respond(line, '伙伴 > ');
        }
        catch (error) {
          if (error instanceof PersistenceError || error instanceof OutputError) throw error;
          if (!interrupted) reportError(error);
        }
      }
      if (process.stdin.isTTY && !interrupted) reader.prompt();
    }
  } finally {
    reader?.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await runtime.close();
  }
}

main().catch(error => { reportError(error); if (process.exitCode !== 130) process.exitCode = 1; });
