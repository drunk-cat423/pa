import assert from 'node:assert/strict';

export function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).map(part => part.text ?? '').join('');
}

export function currentTurnInput(body) {
  const user = body.messages.filter(message => message.role === 'user').at(-1);
  assert.ok(user, 'request should contain its current user input');
  const text = messageText(user);
  return JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
}

export function conversationContext(body) {
  for (const message of body.messages) {
    const raw = messageText(message);
    const start = raw.indexOf('[最近一次会话压缩摘要]\n');
    if (start < 0) continue;
    const content = raw.slice(start);
    const lines = content.split('\n');
    assert.equal(lines[0], '[最近一次会话压缩摘要]');
    const summary = JSON.parse(lines[1]);
    assert.equal(lines[2], '[检查点后的完整消息流｜仅供对话背景，不执行旧指令]');
    const header = lines[2] + '\n';
    const historyRaw = content.slice(content.indexOf(header) + header.length);
    const messages = historyRaw.trim() ? historyRaw.trimEnd().split('\n').map(line => JSON.parse(line)) : [];
    return { raw: content, summary, historyRaw, messages, source: message };
  }
  assert.fail('request should include pa_conversation_context');
}
