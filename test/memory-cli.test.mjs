import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMemoryRequest } from '../dist/memory-service.js';

test('显式删除命令本地拒绝，自然语言不走规则路由', () => {
  assert.equal(parseMemoryRequest('/forget memory-id').type, 'unsupported_delete');
  assert.equal(parseMemoryRequest('/memory delete memory-id').type, 'unsupported_delete');
  assert.equal(parseMemoryRequest('请忘掉我的饮食偏好'), undefined);
});
