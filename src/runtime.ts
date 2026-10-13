import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CURRENT_SESSION_VERSION,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import type { PaConfig } from './config.js';
import { acquireConversationLock } from './conversation-lock.js';
import type { MemoryRef } from './memory-types.js';

const COMPANION_PROMPT = '你是用户的个人对话伙伴。用中文清晰、诚实地交流，尊重用户的选择和边界。'
  + '没有预设性格或人物关系；根据当前对话理解用户。只依据当前会话中实际提供的信息，不假造记忆、经历或已完成的行动。'
  + '你没有文件、命令、网络检索或其他外部工具；不能声称执行了这些操作。不确定时明确说明。'
  + '个人偏好背景只用于当前问题和交流方式，不展示内部画像清单、内部评价、记忆ID或管理信息。'
  + '记忆整理、写入、纠正与权限由应用处理；不提供删除记忆功能。不能因聊天内容声称已经保存长期记忆或改变权限。';

export interface ContextEstimate {
  inputTokens: number;
  reservedOutputTokens: number;
  safetyTokens: number;
  contextWindow: number;
  ratio: number;
  fits: boolean;
  method: 'utf8-byte-estimate';
}

// Tokenizer-independent conservative estimate, explicitly not a measured usage value.
export function estimateContext(input: unknown, contextWindow: number, reservedOutputTokens: number): ContextEstimate {
  const inputTokens = Buffer.byteLength(JSON.stringify(input), 'utf8') + 64;
  const safetyTokens = Math.max(128, Math.ceil(contextWindow * 0.01));
  const total = inputTokens + reservedOutputTokens + safetyTokens;
  return { inputTokens, reservedOutputTokens, safetyTokens, contextWindow,
    ratio: total / contextWindow, fits: total <= contextWindow, method: 'utf8-byte-estimate' };
}

export interface ConversationRuntime {
  prompt(text: string, metadata?: { runId: string; memoryContext?: string; memoryRefs?: MemoryRef[] }): Promise<string>;
  resetContext(): void;
  estimate(text: string, memoryContext?: string): ContextEstimate;
  recordedTurns(): RecordedTurn[];
  abort(): Promise<void>;
  close(): Promise<void>;
  info(): {
    conversationId: string;
    sessionId: string;
    sessionFile: string | undefined;
    messageCount: number;
    tools: readonly string[];
    provider: string;
    model: string;
  };
}

export async function createConfiguredModel(config: PaConfig) {
  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined, list: async () => [],
      modify: async () => { throw new Error('此运行时不持久化认证信息。'); },
      delete: async () => { throw new Error('此运行时不修改认证信息。'); },
    },
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  if (config.baseUrl) modelRuntime.registerProvider(config.provider, {
    baseUrl: config.baseUrl, api: 'openai-completions',
    models: [{ id: config.model, name: config.model, reasoning: config.provider === 'deepseek', input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.contextWindow, maxTokens: config.maxOutputTokens }],
  });
  const catalogModel = modelRuntime.getModel(config.provider, config.model);
  if (!catalogModel) throw new Error(`Pi 内置模型目录中没有 ${config.provider}/${config.model}；请明确配置 base URL 或使用有效模型。`);
  const model = { ...catalogModel, contextWindow: Math.min(catalogModel.contextWindow, config.contextWindow),
    maxTokens: Math.min(catalogModel.maxTokens, config.maxOutputTokens) };
  await modelRuntime.setRuntimeApiKey(config.provider, config.apiKey);
  return { modelRuntime, model };
}

export type RecordedTurn = {
  runId: string;
  user?: { entryId: string; text: string };
  assistant?: { entryId: string; text: string; stopReason: string; errorMessage?: string };
};

export class RequestError extends Error {
  constructor(message: string, readonly kind: 'error' | 'timeout' | 'cancelled', options?: ErrorOptions) {
    super(message, options);
    this.name = 'RequestError';
  }
}

function recordedTurns(manager: SessionManager): RecordedTurn[] {
  const turns: RecordedTurn[] = [];
  let current: RecordedTurn | undefined;
  for (const entry of manager.getBranch()) {
    if (entry.type === 'custom' && entry.customType === 'pa_run') {
      const data = entry.data;
      current = data && typeof data === 'object' && 'runId' in data
        && typeof data.runId === 'string' && data.runId ? { runId: data.runId } : undefined;
      if (current) turns.push(current);
    } else if (entry.type === 'message' && current) {
      const message = entry.message;
      if (message.role === 'user') {
        // An unmarked second user message starts another turn; never borrow its answer.
        if (current.user) { current = undefined; continue; }
        current.user = {
          entryId: entry.id,
          text: typeof message.content === 'string' ? message.content
            : message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''),
        };
      } else if (message.role === 'assistant' && current.user) {
        current.assistant = {
          entryId: entry.id,
          text: message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''),
          stopReason: message.stopReason,
          ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
        };
      }
    }
  }
  return turns;
}

// Implement every resource method instead of relying on discovery-disable flags.
function emptyResources(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => COMPANION_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('此运行时禁止加载外部资源。'); },
    reload: async () => {},
  };
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function regularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`会话数据必须是普通文件：${path}`);
}

function validMessageContent(role: string, content: unknown): boolean {
  if (typeof content === 'string') return role === 'user' || role === 'system';
  if (!Array.isArray(content)) return false;
  return content.every((block: unknown) => {
    if (!block || typeof block !== 'object' || Array.isArray(block) || !('type' in block)) return false;
    switch (block.type) {
      case 'text':
        return 'text' in block && typeof block.text === 'string';
      case 'image':
        return role === 'user' && 'data' in block && typeof block.data === 'string'
          && 'mimeType' in block && typeof block.mimeType === 'string';
      case 'thinking':
        return role === 'assistant' && 'thinking' in block && typeof block.thinking === 'string';
      case 'toolCall':
        return role === 'assistant' && 'id' in block && typeof block.id === 'string'
          && 'name' in block && typeof block.name === 'string' && 'arguments' in block
          && block.arguments !== null && typeof block.arguments === 'object' && !Array.isArray(block.arguments);
      default:
        return false;
    }
  });
}

async function loadSession(cwd: string, directory: string): Promise<SessionManager> {
  // The fixed path in the conversation hash directory is the only permitted session mapping.
  const file = join(directory, 'session.jsonl');
  let text: string;
  try {
    await regularFile(file);
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (!missing(error)) throw error;
    // Pi keeps this explicit path and writes it at the first user message. An empty
    // conversation may reopen with a new Pi id, but always retains the same file mapping.
    return SessionManager.open(file, directory, cwd);
  }
  try {
    // Pi ignores some malformed JSONL lines. Reject them here instead of losing history.
    const lines = text.trim().split('\n');
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const header = entries[0];
    if (!header || header.type !== 'session' || typeof header.id !== 'string' || !header.id
      || header.version !== CURRENT_SESSION_VERSION || typeof header.cwd !== 'string'
      || entries.slice(1).some((entry) => !entry || typeof entry !== 'object'
        || entry.type === 'session' || typeof entry.type !== 'string' || typeof entry.id !== 'string')) {
      throw new Error('会话文件内容无效');
    }
    const ids = new Set<string>();
    for (const entry of entries.slice(1)) {
      if (!entry.id || ids.has(entry.id as string) || typeof entry.timestamp !== 'string'
        || (entry.parentId !== null && (typeof entry.parentId !== 'string' || !ids.has(entry.parentId)))) {
        throw new Error('会话记录标识或父记录无效');
      }
      if (entry.type === 'message') {
        const message = entry.message;
        if (!message || typeof message !== 'object' || !('role' in message)
          || !['system', 'user', 'assistant'].includes(String(message.role)) || !('content' in message)
          || !validMessageContent(String(message.role), message.content)) {
          throw new Error('会话消息无效');
        }
      }
      ids.add(entry.id as string);
    }
    return SessionManager.open(file, directory, cwd);
  } catch (error) {
    throw new Error(`会话文件损坏，请检查：${file}`, { cause: error });
  }
}

export async function openConversation(config: PaConfig, conversationId: string): Promise<ConversationRuntime> {
  const { directory, release: releaseLock } = await acquireConversationLock(config.dataDir, conversationId);
  let session: AgentSession | undefined;
  try {
    const { modelRuntime, model } = await createConfiguredModel(config);
    const manager = await loadSession(config.cwd, directory);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
      cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false,
      enableSkillCommands: false, defaultTools: [], defaultThinkingLevel: 'off',
      transport: 'sse',
    });
    ({ session } = await createAgentSession({
      cwd: config.cwd, agentDir: directory, modelRuntime, model, thinkingLevel: 'off',
      tools: [], noTools: 'all', customTools: [], resourceLoader: emptyResources(),
      sessionManager: manager, settingsManager: settings,
    }));
    const agentSession = session;
    if (agentSession.getActiveToolNames().length || agentSession.getCallableToolNames().length
      || agentSession.getAllTools().length) throw new Error('Pi 运行时未成功禁用所有工具。');
    let closed = false;
    let active: Promise<string> | undefined;
    let closePromise: Promise<void> | undefined;
    let cancelRequested = false;
    async function abort(): Promise<void> {
      if (active) cancelRequested = true;
      await agentSession.abort();
    }
    return {
      info: () => ({
        conversationId, sessionId: agentSession.sessionId, sessionFile: agentSession.sessionFile,
        messageCount: agentSession.messages.filter((message) => message.role === 'user' || message.role === 'assistant').length,
        tools: agentSession.getActiveToolNames(), provider: config.provider, model: config.model,
      }),
      estimate: (text, memoryContext) => estimateContext({
        system: COMPANION_PROMPT, messages: agentSession.messages,
        ...(memoryContext ? { memory: memoryContext } : {}), currentMessage: text,
      }, model.contextWindow, model.maxTokens),
      recordedTurns: () => recordedTurns(manager),
      abort,
      resetContext() {
        if (closed) throw new Error('会话已关闭。');
        if (active) throw new Error('此会话正在处理上一条消息，请等待完成。');
        const branch = manager.getBranch();
        // This runtime never compacts or creates branch summaries. Pi 1.1 cannot
        // edit such entries through its public API, so fail closed if one appears.
        if (branch.some((entry) => entry.type === 'compaction' || entry.type === 'branch_summary')) {
          throw new Error('Pi 当前版本不能安全重置包含摘要的会话上下文。');
        }
        const latestEdits = new Map(branch.filter((entry) => entry.type === 'context_edit')
          .map((entry) => [entry.targetId, entry.replacement]));
        for (const entry of branch) {
          if ((entry.type === 'custom_message' || (entry.type === 'message'
            && ['user', 'assistant', 'toolResult'].includes(entry.message.role)))
            && latestEdits.get(entry.id) !== null) {
            manager.appendContextEdit(entry.id, null);
          }
        }
        // Public SDK method rebuilds the canonical projection and the live Agent.
        agentSession.refreshContext();
      },
      prompt(text, metadata) {
        if (closed) return Promise.reject(new Error('会话已关闭。'));
        if (active) return Promise.reject(new Error('此会话正在处理上一条消息，请等待完成。'));
        cancelRequested = false;
        const before = agentSession.messages.length;
        active = Promise.resolve().then(async () => {
          let timedOut = false;
          let abortPromise: Promise<void> | undefined;
          const timer = setTimeout(() => {
            timedOut = true;
            cancelRequested = true;
            abortPromise = agentSession.abort();
            // Attach immediately; await it again below so no background cancellation remains.
            void abortPromise.catch(() => {});
          }, config.timeoutMs);
          try {
            if (metadata?.memoryContext) {
              await agentSession.sendCustomMessage({
                customType: 'pa_memory', content: metadata.memoryContext, display: false,
                details: { memoryRefs: metadata.memoryRefs ?? [] },
              }, { triggerTurn: false });
            }
            // Plain custom entries are audit data only; Pi excludes them from model context.
            if (metadata) manager.appendCustomEntry('pa_run', { runId: metadata.runId });
            await agentSession.prompt(text, {
              expandPromptTemplates: false,
              preflightResult: () => { if (cancelRequested) throw new RequestError('本轮请求已取消。', 'cancelled'); },
            });
            if (timedOut) throw new RequestError(`模型请求超时（${config.timeoutMs} 毫秒）。`, 'timeout');
            if (cancelRequested) throw new RequestError('本轮请求已取消。', 'cancelled');
            const assistant = agentSession.messages.slice(before).findLast((message) => message.role === 'assistant');
            if (!assistant || assistant.role !== 'assistant') throw new RequestError('模型没有返回本轮回复。', 'error');
            if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
              throw new RequestError(`模型请求失败：${assistant.errorMessage ?? assistant.stopReason}`,
                assistant.stopReason === 'aborted' ? 'cancelled' : 'error');
            }
            return assistant.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
          } catch (error) {
            if (timedOut) throw new RequestError(`模型请求超时（${config.timeoutMs} 毫秒）。`, 'timeout', { cause: error });
            if (cancelRequested) throw new RequestError('本轮请求已取消。', 'cancelled', { cause: error });
            throw error;
          } finally {
            clearTimeout(timer);
            try { await abortPromise; } finally { active = undefined; }
          }
        });
        return active;
      },
      close() {
        if (closePromise) return closePromise;
        closed = true;
        cancelRequested = true;
        closePromise = (async () => {
          try {
            await abort();
            await active?.catch(() => {});
          } finally {
            try { agentSession.dispose(); } finally { await releaseLock(); }
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    try { session?.dispose(); } finally { await releaseLock(); }
    throw error;
  }
}
