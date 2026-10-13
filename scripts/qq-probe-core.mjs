export class QQApiError extends Error {
  constructor(operation, httpStatus, businessCode) {
    super(`QQ ${operation} 请求失败`);
    this.httpStatus = httpStatus;
    this.businessCode = businessCode;
    this.definitelyRejected = [400, 401, 403, 404, 405, 429].includes(httpStatus)
      || (httpStatus === 200 && Number.isFinite(businessCode) && businessCode !== 0);
  }
}

export function readApiResponse(operation, httpStatus, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new QQApiError(operation, httpStatus);
  const codes = [body.code, body.err_code, body.retcode].filter(value => value !== undefined && value !== null);
  const failed = codes.find(value => !Number.isFinite(Number(value)) || Number(value) !== 0);
  if (httpStatus !== 200 || failed !== undefined) {
    throw new QQApiError(operation, httpStatus, Number.isFinite(Number(failed)) ? Number(failed) : undefined);
  }
  return body;
}

export function validateGateway(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || !['api.bot.qq.com', 'api.sgroup.qq.com'].includes(url.hostname)
    || url.username || url.password || (url.port && url.port !== '443')) throw new Error('官方 Gateway 地址不符合要求。');
  return url.href;
}

export function probeMessage(event, expectedCode, botId) {
  if (event?.op !== 0 || !['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(event.t)) return undefined;
  const selfIds = [botId].filter(Boolean);
  const mentions = Array.isArray(event.d?.mentions) ? event.d.mentions : [];
  let mentioned = event.t === 'GROUP_AT_MESSAGE_CREATE';
  for (const mention of mentions) {
    if (!mention || typeof mention !== 'object' || mention.scope === 'all') continue;
    if (mention.is_you === true || (botId && (mention.id === botId || mention.member_openid === botId))) mentioned = true;
    if (mention.is_you === true) for (const id of [mention.id, mention.member_openid, mention.user_openid]) {
      if (typeof id === 'string' && id.length > 0 && id.length <= 512) selfIds.push(id);
    }
  }
  const content = typeof event.d?.content === 'string' ? event.d.content : '';
  if (botId && (content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`))) mentioned = true;
  if (!mentioned) return undefined;
  return matchMessage(event.d, expectedCode, botId, selfIds);
}

function matchMessage(message, expectedCode, botId, selfIds = [botId]) {
  if (!message || typeof message.content !== 'string' || message.author?.bot === true
    || message.author?.id === botId || message.author?.member_openid === botId) return undefined;
  for (const field of ['id', 'group_openid']) {
    if (typeof message[field] !== 'string' || !message[field] || message[field].length > 512) return undefined;
  }
  let text = message.content.trim();
  for (const prefix of selfIds.filter(Boolean).flatMap(id => [`<@${id}>`, `<@!${id}>`])) {
    if (text.startsWith(prefix)) { text = text.slice(prefix.length).trim(); break; }
  }
  if (text !== expectedCode) return undefined;
  const senderId = message.author?.member_openid || message.author?.id;
  if (typeof senderId !== 'string' || !senderId || senderId.length > 512) return undefined;
  return { groupOpenid: message.group_openid, inputMessageId: message.id, senderOpenid: senderId };
}

export function fullProbeMessage(event, expectedCode, botId, allowedGroupOpenid) {
  if (event?.op !== 0 || event.t !== 'GROUP_MESSAGE_CREATE'
    || typeof allowedGroupOpenid !== 'string' || !allowedGroupOpenid
    || event.d?.group_openid !== allowedGroupOpenid
    || typeof event.d?.content !== 'string' || event.d.content.trim() !== expectedCode
    || (event.d.mentions !== undefined && (!Array.isArray(event.d.mentions) || event.d.mentions.length > 0))) return undefined;
  return matchMessage(event.d, expectedCode, botId);
}

export function replyBody(inputMessageId) {
  return { msg_type: 0, content: 'pa QQ 官方接口连通测试成功。已收到群内 @ 消息；本次没有调用 AI 模型。', msg_id: inputMessageId, msg_seq: 1 };
}

export function activeBody() {
  return { msg_type: 0, content: 'pa QQ 主动发言测试成功。这是一条主动发送的测试消息，本次没有调用 AI 模型。' };
}
