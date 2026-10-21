import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERSON_PROFILE_LIMITS,
  PERSON_PROFILE_TARGET,
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
  const input = profile([fact('😀'.repeat(120), ['a', 'b', 'c', 'd', 'e'])]);
  const before = structuredClone(input);
  const capacity = profileCapacity(input);

  assert.equal(capacity.facts, 1);
  assert.equal(capacity.contentBytes, 480);
  assert.equal(capacity.exceedsLimits, false);
  assert.equal(capacity.needsConsolidation, false);
  assert.equal(capacity.structureBytes, Buffer.byteLength(JSON.stringify(input), 'utf8'));
  assert.deepEqual(input, before);
  assert.equal(PERSON_PROFILE_LIMITS.softRatio, 0.75);
});

test('soft thresholds signal consolidation, while normal source metadata does not', () => {
  assert.equal(profileCapacity(profile([fact('x', ['1', '2', '3', '4', '5'])])).needsConsolidation, false);
  assert.equal(PERSON_PROFILE_TARGET.maxFacts, 60);
  assert.equal(PERSON_PROFILE_TARGET.maxContentBytes, 6000);
  assert.equal(PERSON_PROFILE_TARGET.maxStructureBytes, 12000);
  assert.equal(profileCapacity(profile(Array.from({ length: 59 }, () => fact()))).needsConsolidation, false);
  assert.equal(profileCapacity(profile(Array.from({ length: 60 }, () => fact()))).needsConsolidation, true);
  assert.equal(profileCapacity(profile(Array.from({ length: 50 }, () => fact('x'.repeat(119)))))
    .needsConsolidation, false);
  assert.equal(profileCapacity(profile(Array.from({ length: 50 }, () => fact('x'.repeat(120)))))
    .needsConsolidation, true);
  const atSoftStructureLimit = profile([], { personId: 'p'.repeat(12000 - Buffer.byteLength('{"personId":"","baseVersion":1,"facts":[]}')) });
  assert.equal(profileCapacity(atSoftStructureLimit).structureBytes, 12000);
  assert.equal(profileCapacity(atSoftStructureLimit).needsConsolidation, true);
});

test('hard limits include structure metadata and per-fact code points, without a source-count quota', () => {
  assert.equal(profileCapacity(profile([fact('😀'.repeat(120))])).exceedsLimits, false);
  assert.equal(profileCapacity(profile([fact('😀'.repeat(121))])).exceedsLimits, true);
  assert.equal(profileCapacity(profile([fact('x', ['1', '2', '3', '4', '5', '6'])])).exceedsLimits, false);
  assert.equal(profileCapacity(profile([fact('x', Array.from({ length: 50 }, (_, i) => `source-${i}`))])).exceedsLimits, false);
  assert.equal(profileCapacity(profile([fact('x', ['s'.repeat(16000)])])).exceedsLimits, true);
  const atStructureLimit = profile([], { personId: 'p'.repeat(16000 - Buffer.byteLength('{"personId":"","baseVersion":1,"facts":[]}')) });
  assert.equal(profileCapacity(atStructureLimit).structureBytes, 16000);
  assert.equal(profileCapacity(atStructureLimit).exceedsLimits, false);
  assert.equal(profileCapacity(profile([], { personId: `${atStructureLimit.personId}p` })).exceedsLimits, true);
  assert.equal(profileCapacity(profile(Array.from({ length: 80 }, () => fact()))).exceedsLimits, false);
  assert.equal(profileCapacity(profile(Array.from({ length: 81 }, () => fact()))).exceedsLimits, true);
});

test('enforces content byte cap and exact hard boundaries', () => {
  const exactContentLimit = profile(Array.from({ length: 80 }, () => fact('x'.repeat(100))));
  assert.equal(profileCapacity(exactContentLimit).contentBytes, 8000);
  assert.equal(profileCapacity(exactContentLimit).exceedsLimits, false);
  const overContentLimit = profile(Array.from({ length: 80 }, (_, i) => fact('x'.repeat(i === 79 ? 101 : 100))));
  assert.equal(profileCapacity(overContentLimit).contentBytes, 8001);
  assert.equal(profileCapacity(overContentLimit).exceedsLimits, true);
  assert.doesNotThrow(() => assertProfileCapacity(exactContentLimit));
  assert.throws(() => assertProfileCapacity(overContentLimit), PersonProfileCapacityError);
});

test('rejects malformed facts with a fixed safe error', () => {
  for (const malformed of [profile([{}]), profile([{ content: 7, messageIds: [] }]), profile([{ content: 'x', messageIds: [1] }])]) {
    assert.throws(() => profileCapacity(malformed), {
      name: 'PersonProfileCapacityError',
      message: '人物画像容量或格式无效',
    });
  }
});
