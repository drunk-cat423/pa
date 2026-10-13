import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredPersons, isMemoryOwner, isPrimaryPerson, validateHarnessPolicy } from '../dist/harness-policy.js';

const route = { channel: 'qq', accountId: 'app', roomId: 'group', roomType: 'group' };
const binding = { route, senderId: 'member-openid' };
const otherBinding = { route: { ...route, roomId: 'private-user', roomType: 'private' }, senderId: 'user-openid' };
const message = { route, senderId: 'member-openid' };

test('configured persons merge legacy primaryPerson while owner authority remains independent', () => {
  const policy = validateHarnessPolicy({
    version: 1,
    ownerBindings: [],
    primaryPerson: { id: 'legacy-primary', bindings: [binding] },
    persons: [{ id: 'managed-person', bindings: [otherBinding] }],
  });
  assert.deepEqual(configuredPersons(policy).map(person => person.id), ['legacy-primary', 'managed-person']);
  assert.equal(isPrimaryPerson(policy, message), true);
  assert.equal(isMemoryOwner(policy, message), false);
});

test('policy rejects duplicate bindings across distinct people and conflicts with primaryPerson', () => {
  assert.throws(() => validateHarnessPolicy({
    version: 1, ownerBindings: [], persons: [
      { id: 'one', bindings: [binding] }, { id: 'two', bindings: [{ route: { ...route }, senderId: 'member-openid' }] },
    ],
  }), /不同人物/);
  assert.throws(() => validateHarnessPolicy({
    version: 1, ownerBindings: [], primaryPerson: { id: 'primary', bindings: [binding] },
    persons: [{ id: 'primary', bindings: [otherBinding] }],
  }), /primaryPerson 冲突/);
});
