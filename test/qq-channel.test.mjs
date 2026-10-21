import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeQQMessage } from '../dist/qq-channel.js';

class FakeSocket {
  readyState = 1;
  listeners = new Map();
  sent = [];
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  message(payload) { this.emit('message', { data: JSON.stringify(payload) }); }
  close() {
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }
}

class FakeTimers {
  next = 0;
  tasks = new Map();
  setTimeout = (fn, delay) => this.add(fn, delay, false);
  clearTimeout = id => this.tasks.delete(id);
  setInterval = (fn, delay) => this.add(fn, delay, true);
  clearInterval = id => this.tasks.delete(id);
  add(fn, delay, interval) {
    const id = ++this.next;
    this.tasks.set(id, { fn, delay, interval });
    return id;
  }
  run(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    if (!task.interval) this.tasks.delete(id);
    task.fn();
  }
  find(delay) { return [...this.tasks].find(([, task]) => task.delay === delay)?.[0]; }
}

test('引用提取限制深度、节点数和UTF8正文预算；只有引用不凭空创建当前问题', () => {
  const base = { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'question', group_openid: 'group', content: '问题',
    timestamp: '2026-10-13T00:00:00Z', author: { member_openid: 'asker' }, message_type: 103 } };
  const huge = normalizeQQMessage({ ...base, d: { ...base.d,
    msg_elements: [{ content: '中'.repeat(10000) }, { content: '不会超限进入' }] } }, 'account', 'bot');
  assert.equal(huge.quote.truncated, true);
  assert.ok(Buffer.byteLength(huge.quote.inlineMessages.map(item => item.text).join('')) <= 8000);
  let deep = { content: 'TOO_DEEP' };
  for (let depth = 0; depth < 5; depth++) deep = { msg_elements: [deep] };
  const bounded = normalizeQQMessage({ ...base, d: { ...base.d, msg_elements: [deep] } }, 'account', 'bot');
  assert.equal(bounded.quote.truncated, true);
  assert.doesNotMatch(JSON.stringify(bounded), /TOO_DEEP/);
  const many = normalizeQQMessage({ ...base, d: { ...base.d,
    msg_elements: Array.from({ length: 50 }, (_, index) => ({ content: `quote-${index}` })) } }, 'account', 'bot');
  assert.equal(many.quote.inlineMessages.length, 8);
  assert.equal(many.quote.truncated, true);
  const blank = normalizeQQMessage({ ...base, d: { ...base.d, content: ' ', msg_elements: [{ content: '引用原话' }] } }, 'account', 'bot');
  assert.equal(blank.text, ' ');
});
