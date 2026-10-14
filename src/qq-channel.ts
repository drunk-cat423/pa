import type { DeliveryResult, InboundMessage, MessageQuote, OutboundMessage } from './channel-types.js';
import { toPlainText } from './plain-text.js';

const API = 'https://api.bot.qq.com';
const INTENTS = 1 << 25;
const MAX_RECONNECTS = 5;
const RECONNECT_DELAYS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const DEFINITE_HTTP_FAILURES = new Set([400, 401, 403, 404, 405, 429]);

type JsonObject = Record<string, unknown>;

interface QQSocket {
  readonly readyState: number;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: any) => void): void;
  send(data: string): void;
  close(): void;
}

export interface QQChannelConfig {
  appId: string;
  clientSecret: string;
}

export interface QQChannelCallbacks {
  onMessage: (message: InboundMessage) => void;
  onStatus?: (status: string) => void;
}

export interface QQChannelDependencies {
  fetch?: typeof fetch;
  webSocketFactory?: (url: string) => QQSocket;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

interface QQApiFailure extends Error {
  definitelyRejected: boolean;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function eventTime(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

function hasBotMention(eventData: JsonObject, botId: string): boolean {
  if (Array.isArray(eventData.mentions) && eventData.mentions.some(mention => object(mention)
    && mention.scope !== 'all'
    && (mention.is_you === true || (botId && (mention.id === botId || mention.member_openid === botId))))) return true;
  if (!botId) return false;
  const content = typeof eventData.content === 'string' ? eventData.content : '';
  return content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`);
}

function mentionedSenders(eventData: JsonObject, botId: string): string[] {
  if (!Array.isArray(eventData.mentions)) return [];
  const senders = new Set<string>();
  for (const mention of eventData.mentions) {
    if (!object(mention) || mention.scope === 'all' || mention.is_you === true) continue;
    // Group sender IDs use member_openid when available, and otherwise author.id.
    const id = mention.member_openid ?? mention.id;
    if (!nonEmptyString(id) || id.trim() !== id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)
      || id === botId || mention.bot === true) continue;
    senders.add(id);
  }
  return [...senders];
}

function stripBotPrefix(content: string, botIds: string[]): string {
  const trimmed = content.trimStart();
  for (const prefix of botIds.flatMap(id => [`<@${id}>`, `<@!${id}>`])) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trimStart();
  }
  return content;
}

function referenceId(value: unknown): string | undefined {
  return nonEmptyString(value) && value.length <= 512 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function normalizeQuote(data: JsonObject): MessageQuote | undefined {
  const messageId = object(data.message_reference) ? referenceId(data.message_reference.message_id) : undefined;
  const ext = object(data.message_scene) && Array.isArray(data.message_scene.ext) ? data.message_scene.ext : [];
  // ref_msg_idx is an opaque index, never a message.id. Do not copy auth_token or other scene data.
  const indexEntry = ext.find(value => typeof value === 'string' && value.startsWith('ref_msg_idx='));
  const referenceIndex = typeof indexEntry === 'string' ? referenceId(indexEntry.slice('ref_msg_idx='.length)) : undefined;
  let seenQuote = data.message_type === 103 || Boolean(referenceIndex);
  let visited = 0, bytes = 0, truncated = false;
  const inlineMessages: NonNullable<MessageQuote['inlineMessages']> = [];
  function walk(elements: unknown, depth: number, quoted: boolean): void {
    if (!Array.isArray(elements)) return;
    if (depth > 4) { truncated = true; return; }
    for (const element of elements) {
      if (++visited > 32) { truncated = true; return; }
      if (!object(element)) continue;
      const isQuote = quoted || element.message_type === 103;
      if (isQuote) seenQuote = true;
      if (isQuote && typeof element.content === 'string' && element.content.trim()) {
        if (inlineMessages.length >= 8 || bytes >= 8000) { truncated = true; return; }
        let text = '';
        for (const character of element.content) {
          const size = Buffer.byteLength(character, 'utf8');
          if (bytes + size > 8000) { truncated = true; break; }
          text += character; bytes += size;
        }
        const author = object(element.author) ? element.author : undefined;
        const senderId = referenceId(author?.member_openid ?? author?.user_openid ?? author?.id);
        if (text) inlineMessages.push({ text, ...(senderId ? { senderId } : {}),
          ...(typeof author?.username === 'string' ? { senderName: author.username.slice(0, 100) } : {}) });
      }
      walk(element.msg_elements, depth + 1, isQuote);
    }
  }
  walk(data.msg_elements, 1, seenQuote);
  if (!seenQuote && !messageId) return undefined;
  return { ...(messageId ? { messageId } : {}), ...(referenceIndex ? { referenceIndex } : {}),
    ...(inlineMessages.length ? { inlineMessages } : {}), ...(truncated ? { truncated } : {}) };
}

export function normalizeQQMessage(event: unknown, accountId: string, botId: string): InboundMessage | undefined {
  if (!object(event) || event.op !== 0 || !['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE'].includes(String(event.t))) return undefined;
  const privateMessage = event.t === 'C2C_MESSAGE_CREATE';
  const data = event.d;
  if (!object(data) || !nonEmptyString(data.id) || data.id.length > 512
    || !nonEmptyString(data.content) || !object(data.author)) return undefined;

  const author = data.author;
  if (author.bot === true || author.id === botId || author.member_openid === botId) return undefined;
  // C2C user_openid is a separate identity domain; never infer it from a group member.
  const senderId = privateMessage ? author.user_openid : (nonEmptyString(author.member_openid) ? author.member_openid : author.id);
  if (!nonEmptyString(senderId) || senderId.length > 512) return undefined;
  const roomId = privateMessage ? senderId : data.group_openid;
  if (!nonEmptyString(roomId) || roomId.length > 512) return undefined;
  const sentAt = eventTime(data.timestamp ?? data.created_at);
  if (!sentAt) return undefined;

  const mentioned = !privateMessage && (event.t === 'GROUP_AT_MESSAGE_CREATE' || hasBotMention(data, botId));
  const mentionedSenderIds = privateMessage ? [] : mentionedSenders(data, botId);
  // READY.user.id and group mention OpenIDs are different identity domains.
  // Only the authenticated platform's self marker can supply extra self IDs.
  const selfIds = [botId];
  if (Array.isArray(data.mentions)) for (const mention of data.mentions) {
    if (!object(mention) || mention.is_you !== true || mention.scope === 'all') continue;
    for (const id of [mention.id, mention.member_openid, mention.user_openid]) {
      if (nonEmptyString(id) && id.length <= 512) selfIds.push(id);
    }
  }
  const text = privateMessage ? data.content : stripBotPrefix(data.content, selfIds.filter(Boolean));
  const quote = normalizeQuote(data);
  return {
    route: { channel: 'qq', accountId, roomId, roomType: privateMessage ? 'private' : 'group' },
    eventId: data.id,
    senderId,
    ...(typeof author.username === 'string' ? { senderName: author.username } : {}),
    text,
    sentAt,
    mentioned,
    ...(mentionedSenderIds.length ? { mentionedSenderIds } : {}),
    ...(quote ? { quote } : {}),
  };
}

function apiFailure(httpStatus: number, body?: unknown): QQApiFailure {
  const error = new Error('QQ API request failed') as QQApiFailure;
  const codes = object(body) ? [body.code, body.err_code, body.retcode].filter(value => value !== undefined && value !== null) : [];
  const failedBusinessCode = codes.some(value => (typeof value === 'number' || typeof value === 'string')
    && Number.isFinite(Number(value)) && Number(value) !== 0);
  error.definitelyRejected = DEFINITE_HTTP_FAILURES.has(httpStatus) || (httpStatus === 200 && failedBusinessCode);
  return error;
}

function validateApiBody(httpStatus: number, body: unknown): JsonObject {
  if (!object(body)) throw apiFailure(httpStatus, body);
  const codes = [body.code, body.err_code, body.retcode].filter(value => value !== undefined && value !== null);
  if (httpStatus !== 200 || codes.some(value => !Number.isFinite(Number(value)) || Number(value) !== 0)) {
    throw apiFailure(httpStatus, body);
  }
  return body;
}

function gatewayUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid QQ gateway');
  const url = new URL(value);
  if (url.protocol !== 'wss:' || !['api.bot.qq.com', 'api.sgroup.qq.com'].includes(url.hostname)
    || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Invalid QQ gateway');
  return url.href;
}

function eventData(data: unknown): Promise<string> | string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof (data as { text?: unknown }).text === 'function') return (data as Blob).text();
  return String(data);
}

export class QQChannel {
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: (url: string) => QQSocket;
  private readonly now: () => number;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;
  private readonly scheduleInterval: typeof setInterval;
  private readonly cancelInterval: typeof clearInterval;
  private token: string | undefined;
  private tokenExpiresAt = 0;
  private socket: QQSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSequence: number | null = null;
  private sessionId: string | undefined;
  private botId: string | undefined;
  private heartbeatPending = false;
  private reconnectCount = 0;
  private reconnecting = false;
  private started = false;
  private closed = false;
  private startPromise: Promise<void> | undefined;
  private resolveStart: (() => void) | undefined;
  private rejectStart: ((error: Error) => void) | undefined;

  constructor(private readonly config: QQChannelConfig, private readonly callbacks: QQChannelCallbacks, dependencies: QQChannelDependencies = {}) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.socketFactory = dependencies.webSocketFactory ?? (url => new WebSocket(url));
    this.now = dependencies.now ?? Date.now;
    this.scheduleTimeout = dependencies.setTimeout ?? setTimeout;
    this.cancelTimeout = dependencies.clearTimeout ?? clearTimeout;
    this.scheduleInterval = dependencies.setInterval ?? setInterval;
    this.cancelInterval = dependencies.clearInterval ?? clearInterval;
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('QQ channel is closed'));
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    this.startupTimer = this.scheduleTimeout(() => this.stopWithStatus('QQ 启动超时'), 30_000);
    void this.connect(false).catch(() => this.scheduleReconnect());
    return this.startPromise;
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    if (this.closed || !this.started || message.route.channel !== 'qq' || message.route.accountId !== this.config.appId
      || !['group', 'private'].includes(message.route.roomType)
      || !nonEmptyString(message.route.roomId) || !nonEmptyString(message.replyToMessageId)) return { status: 'rejected' };
    const content = toPlainText(message.text);
    if (!content.trim()) return { status: 'rejected' };
    let token: string;
    try {
      token = await this.getToken();
    } catch (error) {
      return (error as Partial<QQApiFailure>).definitelyRejected ? { status: 'rejected' } : { status: 'uncertain' };
    }
    if (this.closed) return { status: 'rejected' };
    let response: Response;
    try {
      const scope = message.route.roomType === 'private' ? 'users' : 'groups';
      response = await this.fetchImpl(`${API}/v2/${scope}/${encodeURIComponent(message.route.roomId)}/messages`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
        body: JSON.stringify({ msg_type: 0, content, msg_id: message.replyToMessageId, msg_seq: 1 }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { status: 'uncertain' };
    }
    let body: JsonObject;
    try {
      body = validateApiBody(response.status, await response.json());
    } catch (error) {
      return (error as Partial<QQApiFailure>).definitelyRejected ? { status: 'rejected' } : { status: 'uncertain' };
    }
    return nonEmptyString(body.id) ? { status: 'sent', externalMessageId: body.id } : { status: 'uncertain' };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    try { socket?.close(); } catch { /* Closing is best effort. */ }
    this.rejectStart?.(new Error('QQ channel closed'));
    this.rejectStart = undefined;
    this.resolveStart = undefined;
  }

  private async connect(resume: boolean): Promise<void> {
    if (this.closed) return;
    const token = await this.getToken();
    if (this.closed) return;
    const gatewayResponse = await this.request(`${API}/gateway/bot`, token);
    const url = gatewayUrl(gatewayResponse.url);
    if (this.closed) return;
    const socket = this.socketFactory(url);
    this.socket = socket;
    this.handshakeTimer = this.scheduleTimeout(() => {
      if (socket === this.socket) this.scheduleReconnect();
    }, 30_000);
    socket.addEventListener('message', event => {
      void Promise.resolve(eventData(event.data)).then(raw => this.handlePayload(socket, JSON.parse(raw)))
        .catch(() => { if (socket === this.socket) this.scheduleReconnect(); });
    });
    socket.addEventListener('error', () => { if (socket === this.socket) this.scheduleReconnect(); });
    socket.addEventListener('close', () => { if (socket === this.socket) this.scheduleReconnect(); });
    socket.addEventListener('open', () => { /* Gateway sends HELLO after the connection opens. */ });
    void resume;
  }

  private async handlePayload(socket: QQSocket, payload: unknown): Promise<void> {
    if (this.closed || socket !== this.socket || !object(payload)) return;
    if (Number.isSafeInteger(payload.s)) this.lastSequence = payload.s as number;
    switch (payload.op) {
      case 10: {
        const interval = object(payload.d) ? Number(payload.d.heartbeat_interval) : NaN;
        if (!Number.isFinite(interval) || interval < 1_000 || interval > 120_000) {
          this.scheduleReconnect();
          return;
        }
        const token = await this.getToken();
        if (this.closed || socket !== this.socket) return;
        if (this.sessionId && this.lastSequence !== null) {
          socket.send(JSON.stringify({ op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSequence } }));
        } else {
          socket.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: INTENTS, shard: [0, 1], properties: { $os: process.platform, $browser: 'pa', $device: 'pa' } } }));
        }
        this.cancelInterval(this.heartbeatTimer);
        this.heartbeatTimer = this.scheduleInterval(() => this.sendHeartbeat(socket), interval);
        break;
      }
      case 11:
        this.heartbeatPending = false;
        break;
      case 1:
        this.sendHeartbeat(socket, true);
        break;
      case 7:
        this.scheduleReconnect();
        break;
      case 9: {
        const resumable = payload.d === true;
        if (!resumable) {
          this.sessionId = undefined;
          this.lastSequence = null;
        }
        this.scheduleReconnect(resumable);
        break;
      }
      case 0:
        await this.handleDispatch(payload);
        break;
      default:
        break;
    }
  }

  private async handleDispatch(payload: JsonObject): Promise<void> {
    if (payload.t === 'READY') {
      if (!object(payload.d) || !object(payload.d.user) || !nonEmptyString(payload.d.user.id) || !nonEmptyString(payload.d.session_id)) {
        this.scheduleReconnect();
        return;
      }
      this.botId = payload.d.user.id;
      this.sessionId = payload.d.session_id;
      this.started = true;
      this.reconnectCount = 0;
      this.cancelTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.cancelTimeout(this.startupTimer);
      this.startupTimer = undefined;
      this.resolveStart?.();
      this.resolveStart = undefined;
      this.rejectStart = undefined;
      this.reportStatus('QQ Gateway READY');
      return;
    }
    if (payload.t === 'RESUMED') {
      this.started = true;
      this.reconnectCount = 0;
      this.cancelTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.reportStatus('QQ Gateway 已恢复');
      return;
    }
    if (!this.started || !this.botId || !['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE'].includes(String(payload.t))) return;
    const message = normalizeQQMessage(payload, this.config.appId, this.botId);
    if (!message) return;
    try { this.callbacks.onMessage(message); } catch { /* User callback errors do not expose event contents. */ }
  }

  private sendHeartbeat(socket: QQSocket, immediate = false): void {
    if (this.closed || socket !== this.socket || socket.readyState !== 1) return;
    if (this.heartbeatPending && !immediate) {
      this.scheduleReconnect();
      return;
    }
    this.heartbeatPending = true;
    socket.send(JSON.stringify({ op: 1, d: this.lastSequence }));
  }

  private scheduleReconnect(resume = Boolean(this.sessionId)): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.cancelTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.cancelInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.heartbeatPending = false;
    const previousSocket = this.socket;
    this.socket = undefined;
    try { previousSocket?.close(); } catch { /* Reconnect will establish a fresh socket. */ }
    if (this.reconnectCount >= MAX_RECONNECTS) {
      this.stopWithStatus('connection_failed');
      return;
    }
    const delay = RECONNECT_DELAYS[this.reconnectCount] ?? 8_000;
    this.reconnectCount += 1;
    this.reportStatus('QQ 正在重连');
    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnecting = false;
      void this.connect(resume).catch(() => this.scheduleReconnect(resume));
    }, delay);
  }

  private stopWithStatus(status: string): void {
    this.reportStatus(status);
    this.close();
  }

  private reportStatus(status: string): void {
    try { this.callbacks.onStatus?.(status); } catch { /* Status observers are optional. */ }
  }

  private clearTimers(): void {
    this.cancelTimeout(this.startupTimer);
    this.cancelTimeout(this.handshakeTimer);
    this.cancelTimeout(this.reconnectTimer);
    this.cancelInterval(this.heartbeatTimer);
    this.startupTimer = undefined;
    this.handshakeTimer = undefined;
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.tokenExpiresAt - this.now() > 60_000) return this.token;
    const result = await this.request(`${API}/app/getAppAccessToken`, undefined, {
      appId: this.config.appId,
      clientSecret: this.config.clientSecret,
    });
    if (!nonEmptyString(result.access_token)) throw new Error('Invalid QQ token');
    const expiresIn = Number(result.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn < 60) throw new Error('Invalid QQ token expiry');
    this.token = result.access_token;
    this.tokenExpiresAt = this.now() + Math.max(1, expiresIn - 60) * 1_000;
    return this.token;
  }

  private async request(url: string, token?: string, body?: JsonObject): Promise<JsonObject> {
    const response = await this.fetchImpl(url, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `QQBot ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    let parsed: unknown;
    try { parsed = await response.json(); } catch { throw apiFailure(response.status); }
    return validateApiBody(response.status, parsed);
  }
}
