import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareMemoryExtraction, parseMemoryResponse } from '../dist/memory-provider.js';
import { memoryWireReferences } from '../dist/memory-wire.js';
import { validateSelfProfileProposal } from '../dist/self-profile-store.js';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const message = (number, extra = {}) => ({ id: id(number), conversationId: id(90), role: 'user',
  text: '正文 m0 p0 q0 s0 保持原样', ingestSeq: number, createdAt: '2026-10-20T01:00:00.000Z', ...extra });
const input = {
  extractionProtocol: 2, profileProtocol: 2, contextProtocol: 1, roomType: 'group',
  job: { id: id(91), conversationId: id(90), reason: 'capacity', status: 'running', startSeq: 1, endSeq: 2,
    messageIds: [id(1), id(2)], attempts: 1, leaseToken: 'secret-lease' },
  messages: [message(1, { personId: id(30), senderId: 'sender-A', senderName: '甲', sentAt: '2026-10-20T00:59:00.000Z', contextSeq: 1,
    replyToMessageId: id(2), replyToSenderId: 'sender-B', images: [{ imageId: 'image-hash', fileId: 'hidden-file-id',
      mimeType: 'image/png', bytes: 12, tokenEstimate: 1024, width: 3, height: 4, quoted: true, sourceSenderId: 'sender-B' }] }),
    message(2, { role: 'assistant', personId: id(31), senderId: 'sender-B', contextSeq: 2 })],
  profileSources: [message(3, { personId: id(30), senderId: 'sender-A', replyToMessageId: id(9) })],
  profiles: [
    { personId: id(30), baseVersion: 2, facts: [{ field: 'obsolete', content: '喜欢茶 m0', sourceType: 'self', messageIds: [id(4)] }],
      pending: [{ id: id(40), content: '长期偏好 q0', sourceMessageId: id(5), sourceType: 'self' }] },
    { personId: id(31), baseVersion: 1, facts: [], pending: [{ id: id(41), content: '长期目标', sourceMessageId: id(3), sourceType: 'third_party' }] },
  ],
  profileFragments: [{ personId: id(30), content: '历史证据 m0', sourceType: 'self', messageIds: [id(6)] }],
  selfProfile: { baseVersion: 3, content: '名称 m0', sourceMessageIds: [id(7)],
    pending: [{ id: id(50), content: '风格 s0', sourceMessageId: id(8) }] },
  selfProfileBudgetBytes: 20000, excludedProfileSourceIds: [id(10)],
  previousSummary: '旧摘要 m0', deferredRanges: [{ startSeq: 10, endSeq: 12 }],
  roomRules: [{ key: 'term', content: '术语约定 m0' }],
};
const prepare = value => prepareMemoryExtraction(value, 100000);
const parse = (value, taskInput = input) => parseMemoryResponse({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(value) }] }, taskInput);
const selfResult = { baseVersion: 3, content: '名称 m0', sourceMessageIds: ['m6', 'm7'], pendingIds: ['s0'] };
const profileResult = { personId: 'p0', baseVersion: 2,
  facts: [{ content: '喜欢茶 m0 p0 q0 s0', sourceType: 'self', messageIds: ['m0', 'm3'], occurredAt: null }],
  pendingResults: [{ pendingId: 'q0', status: 'merged', factIndex: 0 }] };
const output = () => ({ topics: [{ summary: '话题 m0' }], profiles: [structuredClone(profileResult)],
  continuationSummary: '摘要 m0 p0 s0', selfProfile: structuredClone(selfResult) });

test('wire request aliases every structured source and pending without a UUID dictionary', () => {
  const prepared = prepare(input), projection = JSON.parse(prepared.userContent);
  assert.equal(prepared.userContent, prepare(structuredClone(input)).userContent);
  assert.doesNotMatch(prepared.userContent, /00000000-0000-4000-8000-|secret-lease|hidden-file-id|obsolete/);
  assert.deepEqual(projection.messages.map(item => item.id), ['m0', 'm1']);
  assert.equal(projection.profileSources[0].id, 'm2');
  assert.deepEqual(projection.profiles[0].facts[0].messageIds, ['m3']);
  assert.equal(projection.profiles[0].pending[0].sourceMessageId, 'm4');
  assert.equal(projection.profiles[0].pending[0].id, 'q0');
  assert.equal(projection.profiles[1].pending[0].id, 'q1');
  assert.deepEqual(projection.profileFragments[0].messageIds, ['m5']);
  assert.deepEqual(projection.selfProfile.sourceMessageIds, ['m6']);
  assert.equal(projection.selfProfile.pending[0].sourceMessageId, 'm7');
  assert.equal(projection.selfProfile.pending[0].id, 's0');
  assert.deepEqual(projection.excludedProfileSourceIds, ['m8']);
  assert.equal(projection.profileSources[0].replyToMessageId, 'm9');
  assert.ok(projection.profiles[0].capacity.structureBytes > 0);
  assert.deepEqual(projection.deferredRanges, input.deferredRanges);
  assert.deepEqual(projection.roomRules, input.roomRules);
  assert.equal(projection.previousSummary, input.previousSummary);
  assert.equal(projection.messages[0].text, input.messages[0].text);
  assert.equal(projection.profiles[0].facts[0].content, '喜欢茶 m0');
});

test('wire projection preserves roles, identity/reply relationships, chronology and image metadata', () => {
  const projection = JSON.parse(prepare(input).userContent);
  const [a, b] = projection.messages;
  assert.equal(a.role, 'user'); assert.equal(b.role, 'assistant');
  assert.equal(a.personId, projection.profiles[0].personId);
  assert.equal(a.senderId, projection.profileSources[0].senderId);
  assert.equal(a.replyToMessageId, b.id); assert.equal(a.replyToSenderId, b.senderId);
  for (const key of ['createdAt', 'sentAt', 'ingestSeq', 'contextSeq', 'senderName']) assert.equal(a[key], input.messages[0][key]);
  assert.deepEqual(a.images, [{ imageId: 'image-hash', mimeType: 'image/png', bytes: 12, tokenEstimate: 1024,
    width: 3, height: 4, quoted: true, sourceSenderId: 'sender-B' }]);
});

test('new prompt sets bounded topics, full stable profiles, pending contracts and structure budget', () => {
  const { systemPrompt } = prepare(input);
  for (const text of ['最多8个Topic', '400个Unicode', '2000个Unicode', '最多40条facts', '6000字节', '16000字节',
    '最多5个代表来源', 'pendingResults', 'superseded', 'replacementMessageId', '70%', '30%', '不能新写为人物事实或AI自我画像',
    '不增加与某个人的相处模式', '不要求管理者身份', '不把缺口当作已整理']) assert.ok(systemPrompt.includes(text), text);
  assert.doesNotMatch(systemPrompt, /每条必须出现在|必须进入 topics|"ignoredMessageIds":|"fragments":/);
});

test('frozen output budgets are projected and used by every relevant prompt limit', () => {
  const outputBudget = { summaryCharacters: 900, topicCount: 3, topicCharacters: 180, topicTotalCharacters: 500 };
  const prepared = prepare({ ...input, outputBudget });
  assert.deepEqual(JSON.parse(prepared.userContent).outputBudget, outputBudget);
  for (const text of ['最多3个Topic', 'summary最多180个Unicode', 'summary合计最多500个Unicode', '续聊摘要最多900个Unicode']) {
    assert.ok(prepared.systemPrompt.includes(text), text);
  }
  assert.deepEqual(JSON.parse(prepare(input).userContent).outputBudget,
    { summaryCharacters: 2000, topicCount: 8, topicCharacters: 400, topicTotalCharacters: 2000 });
});

test('wire decoder restores only typed references and supplies internal legacy defaults', () => {
  const decoded = parse(output());
  assert.deepEqual(decoded.topics, [{ summary: '话题 m0', messageIds: [] }]);
  assert.deepEqual(decoded.ignoredMessageIds, []); assert.deepEqual(decoded.fragments, []);
  assert.equal(decoded.profiles[0].personId, id(30));
  assert.equal(decoded.profiles[0].facts[0].content, profileResult.facts[0].content);
  assert.deepEqual(decoded.profiles[0].facts[0].messageIds, [id(1), id(4)]);
  assert.deepEqual(decoded.profiles[0].pendingResults, [{ pendingId: id(40), status: 'merged', factIndex: 0 }]);
  assert.deepEqual(decoded.selfProfile, { ...selfResult, sourceMessageIds: [id(7), id(8)], pendingIds: [id(50)] });
  assert.equal(decoded.continuationSummary, '摘要 m0 p0 s0');
});

test('every pending status decodes exactly its own allowed fields', () => {
  for (const decision of [
    { pendingId: 'q0', status: 'superseded', replacementMessageId: 'm0' },
    { pendingId: 'q0', status: 'not_profile', reason: 'temporary' },
    { pendingId: 'q0', status: 'deferred' },
  ]) {
    const value = output(); value.profiles[0].pendingResults = [decision];
    const expected = { ...decision, pendingId: id(40), ...(decision.replacementMessageId ? { replacementMessageId: id(1) } : {}) };
    assert.deepEqual(parse(value).profiles[0].pendingResults, [expected]);
  }
});

test('unknown/raw IDs, wrong namespaces, foreign pending and out of bounds fact indices fail closed', () => {
  const mutations = [
    value => { value.profiles[0].personId = 'p999'; },
    value => { value.profiles[0].facts[0].messageIds = ['m999']; },
    value => { value.profiles[0].facts[0].messageIds = [id(1)]; },
    value => { value.profiles[0].facts[0].messageIds = ['m0', 'm0']; },
    value => { value.profiles[0].pendingResults[0].pendingId = 'q1'; },
    value => { value.profiles[0].pendingResults[0].pendingId = 's0'; },
    value => { value.profiles[0].pendingResults[0].factIndex = 1; },
    value => { value.profiles[0].pendingResults[0].factIndex = -1; },
    value => { value.profiles[0].pendingResults[0].factIndex = 0.5; },
    value => { value.selfProfile.pendingIds = ['q0']; },
    value => { value.selfProfile.sourceMessageIds = ['s0']; },
    value => { value.profiles[0].baseVersion = '2'; },
    value => { value.profiles[0].facts[0].sourceType = 'user'; },
  ];
  for (const mutate of mutations) { const value = output(); mutate(value); assert.throws(() => parse(value), error => error.code === 'model_contract'); }
});

test('unexpected fields fail before adding defaults, including program-owned provenance metadata', () => {
  const mutations = [
    value => { value.ignoredMessageIds = []; }, value => { value.fragments = []; },
    value => { value.processedRanges = []; }, value => { value.sourceRange = { startSeq: 1, endSeq: 2 }; },
    value => { value.topics[0].messageIds = []; }, value => { value.topics[0].sourceRange = {}; },
    value => { value.profiles[0].facts[0].field = 'diet'; }, value => { value.profiles[0].pendingIds = []; },
    value => { value.profiles[0].pendingResults[0].reason = 'temporary'; },
    value => { value.selfProfile.pendingResults = []; },
    value => { value.continuationSummary = {}; },
  ];
  for (const mutate of mutations) { const value = output(); mutate(value); assert.throws(() => parse(value), error => error.code === 'model_contract'); }
});

test('mode-specific response shapes reject unrelated output and self mode needs no summary', () => {
  const messages = { ...input, mode: 'messages', selfProfile: undefined };
  assert.deepEqual(parse({ topics: [], profiles: [], continuationSummary: '续聊' }, messages), {
    ignoredMessageIds: [], topics: [], fragments: [], profiles: [], continuationSummary: '续聊' });
  assert.throws(() => parse({ topics: [], profiles: [profileResult] }, messages));
  assert.throws(() => parse({ topics: [], profiles: [], selfProfile: selfResult }, messages));
  const profiles = { ...input, mode: 'profiles' };
  assert.deepEqual(parse({ profiles: [profileResult] }, profiles).profiles[0].personId, id(30));
  for (const field of ['topics', 'selfProfile', 'continuationSummary', 'fragments']) {
    assert.throws(() => parse({ profiles: [], [field]: field === 'continuationSummary' ? '' : [] }, profiles));
  }
  const self = { ...input, mode: 'self' };
  assert.deepEqual(parse({ selfProfile: selfResult }, self), { ignoredMessageIds: [], topics: [], fragments: [], profiles: [],
    selfProfile: { ...selfResult, sourceMessageIds: [id(7), id(8)], pendingIds: [id(50)] } });
  for (const field of ['topics', 'profiles', 'continuationSummary', 'processedRanges']) assert.throws(() => parse({ selfProfile: selfResult, [field]: [] }, self));
  assert.throws(() => parse({ selfProfile: selfResult }, { ...self, selfProfile: undefined }));
  assert.throws(() => parse({ topics: [], profiles: [] }));
  assert.match(prepare(self).systemPrompt, /mode=self：只返回/);
  assert.match(prepare(profiles).systemPrompt, /mode=profiles：只返回/);
  assert.match(prepare(messages).systemPrompt, /profiles必须为\[\]/);
});

test('mapping scope follows each frozen input and retains downstream self-source permission checks', () => {
  const other = structuredClone(input); other.messages.unshift(message(20));
  assert.equal(memoryWireReferences(input).messages.get(id(1)), 'm0');
  assert.equal(memoryWireReferences(other).messages.get(id(1)), 'm1');
  const value = output(); value.selfProfile.sourceMessageIds = ['m3']; value.selfProfile.pendingIds = [];
  const decoded = parse(value);
  assert.deepEqual(decoded.selfProfile.sourceMessageIds, [id(4)]);
  assert.throws(() => validateSelfProfileProposal(decoded.selfProfile, input.selfProfile, input.messages), /原始真人来源/);
});

test('legacy frozen inputs retain original source IDs and original response shape', () => {
  const legacy = { ...input }; delete legacy.extractionProtocol;
  const prepared = prepare(legacy);
  assert.ok(prepared.userContent.includes(id(1)));
  assert.match(prepared.systemPrompt, /完整覆盖严格针对/);
  const result = { ignoredMessageIds: [id(1)], topics: [], fragments: [], profiles: [], selfProfile: {
    baseVersion: 3, content: '名称 m0', sourceMessageIds: [id(7)], pendingIds: [] } };
  assert.deepEqual(parse(result, legacy), result);
});

test('new response still honors normalized SDK errors before wire decoding', () => {
  for (const [response, code] of [
    [{ stopReason: 'length' }, 'model_length'],
    [{ stopReason: 'error', errorMessage: 'HTTP 503' }, 'model_request'],
    [{ stopReason: 'aborted' }, 'model_request'],
    [{ stopReason: 'toolUse' }, 'model_contract'],
    [{ stopReason: 'stop', content: [] }, 'model_empty'],
    [{ stopReason: 'stop', content: [{ type: 'text', text: '{invalid' }] }, 'model_json'],
  ]) assert.throws(() => parseMemoryResponse(response, input), error => error.code === code);
});
