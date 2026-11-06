import assert from 'node:assert/strict';

// Mock models react to user text, while captured requests retain the real envelope.
export function requestText(raw) {
  if (!raw.startsWith('[本轮时间环境｜由harness服务器时钟提供]\n')) return currentText(raw);
  const lines = raw.split('\n');
  const clock = JSON.parse(lines[1]);
  assert.equal(clock.timeZone, 'Asia/Shanghai');
  assert.ok(Number.isFinite(Date.parse(clock.currentTime)));
  return currentText(lines.slice(3).join('\n'));
}

function currentText(raw) {
  if (!raw.startsWith('[本轮明确输入]\n')) return raw;
  return JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1)).currentMessage.text;
}
