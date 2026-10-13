import type { ChannelRoute } from './channel-types.js';

export function readQQSettings(env: NodeJS.ProcessEnv = process.env): {
  appId: string; clientSecret: string; routes: ChannelRoute[]; maxCalls: number;
} {
  const appId = env.PA_QQ_APP_ID?.trim() ?? '';
  const clientSecret = env.PA_QQ_APP_SECRET?.trim() ?? '';
  if (!/^\d{1,32}$/.test(appId) || !clientSecret) throw new Error('缺少有效的 QQ 机器人凭证。');
  const rooms = [...new Set((env.PA_QQ_ALLOWED_GROUPS ?? '').split(',').map(value => value.trim()).filter(Boolean))];
  const users = [...new Set((env.PA_QQ_ALLOWED_USERS ?? '').split(',').map(value => value.trim()).filter(Boolean))];
  if ((!rooms.length && !users.length) || [...rooms, ...users].some(id => !/^[A-Za-z0-9_-]{1,512}$/.test(id))) {
    throw new Error('必须配置已验证的 PA_QQ_ALLOWED_GROUPS（group_openid）或 PA_QQ_ALLOWED_USERS（user_openid），多个 ID 用逗号分隔。');
  }
  const value = env.PA_QQ_MAX_MODEL_CALLS?.trim() || '3';
  const maxCalls = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 10) {
    throw new Error('PA_QQ_MAX_MODEL_CALLS 必须为 0（不限次数）或 1 到 10 的整数。');
  }
  return {
    appId, clientSecret, maxCalls,
    routes: [
      ...rooms.map(roomId => ({ channel: 'qq', accountId: appId, roomId, roomType: 'group' as const })),
      ...users.map(roomId => ({ channel: 'qq', accountId: appId, roomId, roomType: 'private' as const })),
    ],
  };
}
