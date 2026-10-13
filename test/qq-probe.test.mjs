import assert from 'node:assert/strict';
import test from 'node:test';
import { QQApiError, activeBody, fullProbeMessage, probeMessage, readApiResponse, replyBody, validateGateway } from '../scripts/qq-probe-core.mjs';

test('QQ API 区分 HTTP 成功与业务失败，不在错误中暴露平台正文', () => {
  for (const body of [{ code: 100016, message: 'test-secret' }, { err_code: 11253 }, { retcode: 1 }, { code: 'invalid' }]) {
    assert.throws(() => readApiResponse('test', 200, body), error => error instanceof QQApiError && !error.message.includes('test-secret'));
  }
  assert.throws(() => readApiResponse('send', 202, { id: 'maybe' }));
  assert.throws(() => readApiResponse('test', 401, {}));
  assert.deepEqual(readApiResponse('test', 200, { id: 'ok', err_code: 0 }), { id: 'ok', err_code: 0 });
});

test('Gateway 只连接受信的官方加密地址', () => {
  assert.equal(validateGateway('wss://api.bot.qq.com/websocket'), 'wss://api.bot.qq.com/websocket');
  for (const url of ['ws://api.bot.qq.com/websocket', 'wss://api.bot.qq.com.attacker.test/ws', 'wss://other.qq.com/ws', 'wss://user:password@api.bot.qq.com/ws']) assert.throws(() => validateGateway(url));
});

test('HTTP 200 无效响应、异步审核和服务端超时不能当成确定拒绝', () => {
  assert.equal(new QQApiError('send', 200).definitelyRejected, false);
  for (const body of [null, [], { code: 'not-a-code' }]) {
    assert.throws(() => readApiResponse('send', 200, body), error => error.definitelyRejected === false);
  }
  assert.throws(() => readApiResponse('send', 202, { err_code: 304023 }), error => error.definitelyRejected === false);
  for (const status of [408, 500, 502, 504]) assert.equal(new QQApiError('send', status).definitelyRejected, false);
  assert.throws(() => readApiResponse('send', 200, { err_code: 11253 }), error => error.definitelyRejected === true);
  assert.equal(new QQApiError('send', 401).definitelyRejected, true);
});

test('只匹配群内精确测试码，忽略私聊、普通群消息、回声、缺字段和其他文本', () => {
  const value = { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'message', group_openid: 'group', content: ' TEST_CODE ', author: { id: 'member', bot: false } } };
  const expected = { groupOpenid: 'group', inputMessageId: 'message', senderOpenid: 'member' };
  assert.deepEqual(probeMessage(value, 'TEST_CODE', 'bot'), expected);
  assert.deepEqual(probeMessage({ ...value, d: { ...value.d, content: '<@!bot> TEST_CODE' } }, 'TEST_CODE', 'bot'), expected);
  for (const t of ['C2C_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'GROUP_ADD_ROBOT']) assert.equal(probeMessage({ ...value, t }, 'TEST_CODE', 'bot'), undefined);
  assert.equal(probeMessage(value, 'OTHER_CODE', 'bot'), undefined);
  assert.equal(probeMessage({ ...value, d: { ...value.d, author: { id: 'bot' } } }, 'TEST_CODE', 'bot'), undefined);
  assert.equal(probeMessage({ ...value, d: { ...value.d, author: { id: 'other', bot: true } } }, 'TEST_CODE', 'bot'), undefined);
  assert.equal(probeMessage({ ...value, d: { ...value.d, group_openid: '' } }, 'TEST_CODE', 'bot'), undefined);
  assert.equal(probeMessage({ ...value, d: { ...value.d, content: 'TEST_CODE plus unrelated content' } }, 'TEST_CODE', 'bot'), undefined);
});

test('测试回复绑定原消息，固定序号与固定文本，不进行主动群发', () => {
  const body = replyBody('source-message');
  assert.equal(body.msg_id, 'source-message');
  assert.equal(body.msg_seq, 1);
  assert.equal(body.msg_type, 0);
  assert.ok(body.content.includes('没有调用 AI 模型'));
});

test('全量接收只匹配已验证群的普通消息，拒绝其他群、@、私聊和回声', () => {
  const value = { op: 0, t: 'GROUP_MESSAGE_CREATE', d: { id: 'message', group_openid: 'verified-group', content: ' FULL_CODE ', author: { id: 'member' }, mentions: [] } };
  assert.ok(fullProbeMessage(value, 'FULL_CODE', 'bot', 'verified-group'));
  assert.equal(fullProbeMessage(value, 'FULL_CODE', 'bot', ''), undefined);
  assert.equal(fullProbeMessage(value, 'FULL_CODE', 'bot', 'other-group'), undefined);
  assert.equal(fullProbeMessage({ ...value, t: 'GROUP_AT_MESSAGE_CREATE' }, 'FULL_CODE', 'bot', 'verified-group'), undefined);
  assert.equal(fullProbeMessage({ ...value, t: 'C2C_MESSAGE_CREATE' }, 'FULL_CODE', 'bot', 'verified-group'), undefined);
  assert.equal(fullProbeMessage({ ...value, d: { ...value.d, content: '<@bot> FULL_CODE' } }, 'FULL_CODE', 'bot', 'verified-group'), undefined);
  assert.equal(fullProbeMessage({ ...value, d: { ...value.d, mentions: [{ id: 'bot' }] } }, 'FULL_CODE', 'bot', 'verified-group'), undefined);
  assert.equal(fullProbeMessage({ ...value, d: { ...value.d, author: { id: 'bot' } } }, 'FULL_CODE', 'bot', 'verified-group'), undefined);
  assert.equal(fullProbeMessage({ ...value, d: { ...value.d, content: {} } }, 'FULL_CODE', 'bot', 'verified-group'), undefined);
});

test('主动发送不携带 msg_id、event_id 或回复序号', () => {
  const body = activeBody();
  assert.equal(body.msg_type, 0);
  for (const field of ['msg_id', 'event_id', 'msg_seq']) assert.equal(Object.hasOwn(body, field), false);
  assert.ok(body.content.includes('主动发送'));
});
