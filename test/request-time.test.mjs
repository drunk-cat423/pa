import assert from 'node:assert/strict';
import test from 'node:test';
import { requestTimeContext } from '../dist/request-time.js';

test('北京时间跨UTC午夜边界，明确时区并独立于主机默认时区', () => {
  const before = requestTimeContext(new Date('2026-10-14T15:59:59Z'));
  const after = requestTimeContext(new Date('2026-10-14T16:00:00Z'));
  assert.deepEqual(JSON.parse(before.split('\n')[1]), { currentTime: '2026-10-14T23:59:59+08:00', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(JSON.parse(after.split('\n')[1]), { currentTime: '2026-10-15T00:00:00+08:00', timeZone: 'Asia/Shanghai' });
  assert.match(after, /来源发布日期与事件日期/);
});
