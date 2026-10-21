import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERSON_PROFILE_LIMITS,
  PersonProfileCapacityError,
  assertProfileCapacity,
  profileCapacity,
} from '../dist/profile-limits.js';

const profile = (facts = [], overrides = {}) => ({ personId: 'person-1', baseVersion: 1, facts, ...overrides });
const fact = (content = 'x', messageIds = ['m1'], extra = {}) => ({
  content,
  sourceType: 'self',
  messageIds,
  ...extra,
});

test('counts Unicode code points and UTF-8 bytes, and leaves inputs unchanged', () => {
  const input = profile([fact('😀'.repeat(200), ['a', 'b', 'c', 'd', 'e'])]);
  const before = structuredClone(input);
  const capacity = profileCapacity(input);

  assert.equal(capacity.facts, 1);
  assert.equal(capacity.contentBytes, 800);
  assert.equal(capacity.exceedsLimits, false);
  assert.equal(capacity.needsConsolidation, false);
  assert.equal(capacity.structureBytes, Buffer.byteLength(JSON.stringify(input), 'utf8'));
  assert.deepEqual(input, before);
  assert.equal(PERSON_PROFILE_LIMITS.softRatio, 0.75);
});

test('soft thresholds signal consolidation, while normal source metadata does not', () => {
  assert.equal(profileCapacity(profile([fact('x', ['1', '2', '3', '4', '5'])])).needsConsolidation, false);
  assert.equal(profileCapacity(profile(Array.from({ length: 30 }, () => fact()))).needsConsolidation, true);
  assert.equal(profileCapacity(profile([fact('x'.repeat(4500))])).needsConsolidation, true);
  assert.equal(profileCapacity(profile([], { personId: 'p'.repeat(12000) })).needsConsolidation, true);
});

test('hard limits include structure metadata and per-fact code points, without a source-count quota', () => {
  assert.equal(profileCapacity(profile([fact('😀'.repeat(201))])).exceedsLimits, true);
  assert.equal(profileCapacity(profile([fact('x', ['1', '2', '3', '4', '5', '6'])])).exceedsLimits, false);
  assert.equal(profileCapacity(profile([fact('x', Array.from({ length: 50 }, (_, i) => `source-${i}`))])).exceedsLimits, false);
  assert.equal(profileCapacity(profile([fact('x', ['s'.repeat(16000)])])).exceedsLimits, true);
  assert.equal(profileCapacity(profile([], { personId: 'p'.repeat(16000) })).exceedsLimits, true);
  assert.equal(profileCapacity(profile(Array.from({ length: 41 }, () => fact()))).exceedsLimits, true);
});

test('enforces content byte cap and exact hard boundaries', () => {
  const atContentLimit = profile(Array.from({ length: 30 }, () => fact('x'.repeat(200))));
  assert.equal(profileCapacity(atContentLimit).exceedsLimits, false);
  const overContentLimit = profile(Array.from({ length: 31 }, () => fact('x'.repeat(200))));
  assert.equal(profileCapacity(overContentLimit).exceedsLimits, true);
  assert.doesNotThrow(() => assertProfileCapacity(atContentLimit));
  assert.throws(() => assertProfileCapacity(profile([fact('x'.repeat(6001))])), PersonProfileCapacityError);
});

test('rejects malformed facts with a fixed safe error', () => {
  for (const malformed of [profile([{}]), profile([{ content: 7, messageIds: [] }]), profile([{ content: 'x', messageIds: [1] }])]) {
    assert.throws(() => profileCapacity(malformed), {
      name: 'PersonProfileCapacityError',
      message: '人物画像容量或格式无效',
    });
  }
});
