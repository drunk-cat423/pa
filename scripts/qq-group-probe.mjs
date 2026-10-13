import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { QQApiError, activeBody, fullProbeMessage, probeMessage, readApiResponse, replyBody, validateGateway } from './qq-probe-core.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const fullMode = args[0] === '--full';
const checkOnly = args.length === 1 && args[0] === '--check';
if (args.length && !checkOnly && !(fullMode && args.length === 2 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(args[1]))) {
  console.error('用法：node scripts/qq-group-probe.mjs [--check | --full 已验证的运行编号]');
  process.exit(1);
}
let allowedGroupOpenid;
if (fullMode) {
  try {
    const sourceDirectory = join(root, '.local', 'qq-probe', args[1]);
    const source = JSON.parse(readFileSync(join(sourceDirectory, 'status.json'), 'utf8'));
    const receipt = JSON.parse(readFileSync(join(sourceDirectory, 'receipt-confirmation.json'), 'utf8'));
    if (source.runId !== args[1] || source.state !== 'reply_accepted' || !source.responseMessageId
      || receipt.runId !== args[1] || receipt.userConfirmedReceipt !== true
      || typeof source.groupOpenid !== 'string' || !source.groupOpenid) throw new Error('unverified group');
    allowedGroupOpenid = source.groupOpenid;
  } catch {
    console.error('没有已确认收件的测试群记录，已停止；不会选择其他群。');
    process.exit(1);
  }
}
let credentials;
try {
  const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
  if (!/^\d{1,32}$/.test(env.PA_QQ_APP_ID ?? '') || !env.PA_QQ_APP_SECRET) throw new Error('missing');
  credentials = { appId: env.PA_QQ_APP_ID, clientSecret: env.PA_QQ_APP_SECRET };
} catch {
  console.error('QQ 本地凭证缺失或无效；请先完成扫码绑定。');
  process.exit(1);
}
if (checkOnly) {
  console.log('QQ 本地凭证检查通过；未输出凭证、未请求官方服务。');
  process.exit(0);
}

const runId = randomUUID();
const directory = join(root, '.local', 'qq-probe', runId);
mkdirSync(directory, { recursive: true });
const statusPath = join(directory, 'status.json');
const testCode = `${fullMode ? 'PA_FULL' : 'PA_TEST'}_${randomBytes(5).toString('hex').toUpperCase()}`;
const startedAt = new Date().toISOString();
let ws, timer, heartbeat, handshake;
let state = { state: 'starting', mode: fullMode ? 'full_and_active' : 'at_reply', ...(fullMode ? { sourceRunId: args[1], allowedGroupOpenid } : {}) };
let terminal = false;
let claimed = false;
let sendInFlight = false;
let latestSequence = null;
let botId;
let ackPending = false;
const controller = new AbortController();

function status(additional) {
  state = { ...state, ...additional };
  writeFileSync(statusPath, JSON.stringify({ runId, pid: process.pid, startedAt, updatedAt: new Date().toISOString(), testCode, ...state }, null, 2), { mode: 0o600 });
}
function event(name, details = {}) {
  // Only explicitly selected metadata is persisted; never store raw payloads/text/credentials.
  writeFileSync(join(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ event: name, at: new Date().toISOString(), ...details }, null, 2), { flag: 'wx', mode: 0o600 });
}
function finish(finalState, text, code = 1, details = {}) {
  if (terminal) return;
  terminal = true;
  clearTimeout(timer);
  clearTimeout(handshake);
  clearInterval(heartbeat);
  controller.abort();
  try { status({ state: finalState, ...details }); } catch { /* Never continue sending after a persistence failure. */ }
  try { ws?.close(); } catch { /* Ignore close failure. */ }
  console.log(text);
  process.exitCode = code;
}
function failure(error) {
  const details = error instanceof QQApiError ? { httpStatus: error.httpStatus, businessCode: error.businessCode } : {};
  finish(sendInFlight ? 'delivery_uncertain' : 'failed', sendInFlight
    ? '群回复结果未确认；已停止，不会重发。'
    : 'QQ 通路测试停止。错误类别已记录；未打印原始响应或密钥。', 1, details);
}
async function api(operation, path, body, token) {
  const response = await fetch(`https://api.bot.qq.com${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `QQBot ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
  });
  let parsed;
  try { parsed = await response.json(); } catch { throw new QQApiError(operation, response.status); }
  return readApiResponse(operation, response.status, parsed);
}

status({});
console.log(`测试状态文件：${statusPath}`);
process.once('SIGINT', () => finish(sendInFlight ? 'delivery_uncertain' : 'cancelled', 'QQ 通路测试已停止。', 130));
process.once('SIGTERM', () => finish(sendInFlight ? 'delivery_uncertain' : 'cancelled', 'QQ 通路测试已停止。', 130));
timer = setTimeout(() => finish(sendInFlight ? 'delivery_uncertain' : 'timed_out', 'QQ 测试等待超时，已停止。'), 20 * 60 * 1000);

try {
  const auth = await api('access_token', '/app/getAppAccessToken', credentials);
  credentials = undefined;
  if (terminal) throw new Error('stopped');
  if (typeof auth.access_token !== 'string' || !auth.access_token || Number(auth.expires_in) < 60) throw new Error('invalid token');
  const token = auth.access_token;
  status({ state: 'authenticated', tokenExpiresAt: new Date(Date.now() + Number(auth.expires_in) * 1000).toISOString() });
  console.log('QQ Access Token 鉴权成功。');
  const gateway = await api('gateway', '/gateway/bot', undefined, token);
  if (terminal) throw new Error('stopped');
  const address = validateGateway(gateway.url);
  if (gateway.shards !== 1 || gateway.session_start_limit?.remaining === 0) throw new Error('unsupported gateway quota');
  ws = new WebSocket(address);
  status({ state: 'connecting' });
  handshake = setTimeout(() => finish('handshake_timeout', 'QQ Gateway 握手超时，已停止。'), 20000);
  const heartbeatSend = () => {
    if (terminal) return;
    if (ackPending) { finish(sendInFlight ? 'delivery_uncertain' : 'heartbeat_timeout', 'QQ 心跳未确认，已停止且不会重发回复。'); return; }
    if (ws.readyState !== WebSocket.OPEN) return;
    ackPending = true;
    ws.send(JSON.stringify({ op: 1, d: latestSequence }));
  };
  ws.addEventListener('error', () => finish(sendInFlight ? 'delivery_uncertain' : 'connection_error', 'QQ WebSocket 连接异常，已停止。'));
  ws.addEventListener('close', ({ code }) => {
    if (!terminal) finish(sendInFlight ? 'delivery_uncertain' : 'connection_closed', 'QQ WebSocket 已断开，未自动重连或重发。', 1, { closeCode: code });
  });
  ws.addEventListener('message', ({ data }) => {
    if (terminal) return;
    void (async () => {
      const payload = JSON.parse(typeof data === 'string' ? data : await data.text());
      if (terminal) return;
      if (Number.isSafeInteger(payload.s)) latestSequence = payload.s;
      if (payload.op === 10) {
        const interval = Number(payload.d?.heartbeat_interval);
        if (heartbeat || !Number.isFinite(interval) || interval < 1000 || interval > 120000) throw new Error('invalid hello');
        ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1], properties: { $os: process.platform, $browser: 'pa-qq-test', $device: 'pa-local' } } }));
        heartbeat = setInterval(heartbeatSend, interval);
        return;
      }
      if (payload.op === 11) {
        ackPending = false;
        status({ heartbeatConfirmed: true });
        return;
      }
      if (payload.op === 1) {
        ws.send(JSON.stringify({ op: 1, d: latestSequence }));
        return;
      }
      if (payload.op === 7 || payload.op === 9) {
        finish(sendInFlight ? 'delivery_uncertain' : 'gateway_rejected', 'QQ Gateway 要求重新连接或拒绝会话，已停止。', 1, { gatewayOpcode: payload.op });
        return;
      }
      if (payload.op === 0 && payload.t === 'READY') {
        if (typeof payload.d?.user?.id !== 'string') throw new Error('invalid ready');
        botId = payload.d.user.id;
        clearTimeout(handshake);
        status({ state: 'waiting_for_group_test', botName: typeof payload.d.user.username === 'string' ? payload.d.user.username.slice(0, 100) : undefined });
        heartbeatSend();
        console.log('QQ Gateway READY；已订阅群聊与单聊事件，单聊内容不会处理或保存。');
        console.log(fullMode
          ? `请在刚才的测试群发送普通文本，不要 @ 任何人：${testCode}`
          : `请仅在你的测试群内 @ 机器人并发送：${testCode}`);
        return;
      }
      // No logging or persistence for other people's messages or unrelated rooms.
      if (!botId || claimed) return;
      const matched = fullMode ? fullProbeMessage(payload, testCode, botId, allowedGroupOpenid) : probeMessage(payload, testCode, botId);
      if (!matched) return;
      claimed = true;
      writeFileSync(join(directory, 'claim.json'), JSON.stringify(matched, null, 2), { flag: 'wx', mode: 0o600 });
      status({ state: fullMode ? 'full_message_received' : 'group_received', ...matched });
      event(fullMode ? 'GROUP_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE', matched);
      console.log(fullMode ? '已收到测试群未 @ 的指定普通消息；5 秒后主动发送一次固定文本。' : '已收到测试群的指定 @ 消息，准备回复一次固定连通性文本。');
      if (fullMode) {
        status({ state: 'active_send_scheduled', fullMessageReceived: true });
        await delay(5000, undefined, { signal: controller.signal });
        if (terminal) return;
      }
      status({ state: 'sending', delivery: 'pending' });
      const body = fullMode ? activeBody() : replyBody(matched.inputMessageId);
      event('GROUP_SEND_REQUEST', { mode: fullMode ? 'active' : 'reply', groupOpenid: matched.groupOpenid, hasMsgId: Object.hasOwn(body, 'msg_id'), hasEventId: Object.hasOwn(body, 'event_id'), hasMsgSeq: Object.hasOwn(body, 'msg_seq') });
      sendInFlight = true;
      let result;
      try { result = await api('send_group_message', `/v2/groups/${encodeURIComponent(matched.groupOpenid)}/messages`, body, token); } catch (error) {
        if (error instanceof QQApiError && error.definitelyRejected) {
          sendInFlight = false;
          finish('delivery_rejected', 'QQ 平台拒绝了测试回复，错误码已记录；未重试。', 1, { delivery: 'rejected', httpStatus: error.httpStatus, businessCode: error.businessCode });
        } else failure(error);
        return;
      }
      if (terminal) return;
      if (typeof result.id !== 'string' || !result.id) throw new Error('missing message id');
      event(fullMode ? 'GROUP_ACTIVE_ACCEPTED' : 'GROUP_REPLY_ACCEPTED', { responseMessageId: result.id });
      finish(fullMode ? 'active_accepted' : 'reply_accepted', fullMode
        ? 'QQ 已接受主动群消息，发送请求未带回复 ID；请到群内确认收到文本。'
        : 'QQ 已接受测试群回复，消息 ID 已保存；请到群内确认收到文本。', 0, { delivery: 'accepted', responseMessageId: result.id });
    })().catch(failure);
  });
} catch (error) { failure(error); }
