import assert from 'node:assert/strict';

// Mock models react to user text, while captured requests retain the real envelope.
export function requestText(raw) {
  if (!raw.startsWith('[本轮时间环境｜由harness服务器时钟提供]\n')) return raw;
  const lines = raw.split('\n');
  const clock = JSON.parse(lines[1]);
  assert.equal(clock.timeZone, 'Asia/Shanghai');
  assert.ok(Number.isFinite(Date.parse(clock.currentTime)));
  return lines.slice(3).join('\n');
}
