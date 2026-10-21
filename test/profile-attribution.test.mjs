import assert from 'node:assert/strict';
import test from 'node:test';
import { ProfileAttributionError, assertAiProfileEvidence, inferAiProfileEvidence,
  inferPersonProfileEvidence, resolveProfileSubject } from '../dist/profile-attribution.js';

const candidates = [{ personId: 'person-A', senderId: 'A', name: '阿甲' }, { personId: 'person-B', senderId: 'B', name: '阿乙' }];
const message = (text, extra = {}) => ({ id: 'message', role: 'user', text, personId: 'person-A', senderId: 'A',
  conversationId: 'room', ingestSeq: 1, createdAt: '2026-10-21T00:00:00Z', ...extra });
const evidence = (factQuote, subjectKind = 'self', subjectQuote = '我') => ({ messageId: 'message', factQuote, subjectKind, subjectQuote });

test('shared attribution resolves explicit self and does not relabel a named third party as the speaker', () => {
  const own = message('请记住我不吃辣');
  assert.deepEqual(resolveProfileSubject(evidence(own.text), own, candidates), { personId: 'person-A', sourceType: 'self' });
  assert.deepEqual(inferPersonProfileEvidence(own, own.text, candidates, 'person-A'), evidence(own.text));
  const nickname = message('我的昵称是“小白”');
  assert.deepEqual(resolveProfileSubject(evidence(nickname.text, 'self', '我的'), nickname, candidates),
    { personId: 'person-A', sourceType: 'self' });
  const other = message('阿乙不吃辣');
  assert.throws(() => resolveProfileSubject(evidence(other.text), other, candidates), ProfileAttributionError);
  assert.throws(() => inferPersonProfileEvidence(other, other.text, candidates, 'person-A'), ProfileAttributionError);
  assert.deepEqual(resolveProfileSubject(evidence(other.text, 'name', '阿乙'), other, candidates),
    { personId: 'person-B', sourceType: 'third_party' });
});

test('quoted first person, reported statements, friends and repeated excerpts cannot become current self facts', () => {
  for (const [text, quote] of [
    ['阿乙说：“我不吃辣”', '我不吃辣'], ['> 我不吃辣', '我不吃辣'], ['`我不吃辣`', '我不吃辣'],
    ['我觉得阿乙不吃辣', '我觉得阿乙不吃辣'], ['我的朋友不吃辣', '我的朋友不吃辣'],
    ['我朋友不吃辣', '我朋友不吃辣'], ['我爸不吃辣', '我爸不吃辣'], ['我妈妈不吃辣', '我妈妈不吃辣'],
    ['阿乙的自述：我不吃辣', '我不吃辣'],
    ['假如我不吃辣', '我不吃辣'], ['例如我不吃辣', '我不吃辣'], ['我不吃辣。我不吃辣', '我不吃辣'],
  ]) {
    assert.throws(() => resolveProfileSubject(evidence(quote), message(text), candidates), ProfileAttributionError, text);
  }
  for (const text of ['阿乙说我不吃辣', '阿乙认为自己不吃辣']) {
    assert.throws(() => resolveProfileSubject(evidence(text, 'name', '阿乙'), message(text), candidates), ProfileAttributionError);
  }
  assert.throws(() => resolveProfileSubject(evidence('阿乙不吃辣', 'name', '阿乙'), message('我觉得阿乙不吃辣'), candidates), ProfileAttributionError);
});

test('unique names bind one person, while ambiguous names and inferred mismatched targets fail', () => {
  const source = message('阿乙喜欢茶');
  assert.deepEqual(inferPersonProfileEvidence(source, source.text, candidates, 'person-B'), evidence(source.text, 'name', '阿乙'));
  const duplicated = [...candidates, { personId: 'person-C', senderId: 'C', name: '阿乙' }];
  assert.throws(() => resolveProfileSubject(evidence(source.text, 'name', '阿乙'), source, duplicated), ProfileAttributionError);
  assert.throws(() => inferPersonProfileEvidence(source, source.text, duplicated, 'person-B'), ProfileAttributionError);
  assert.throws(() => inferPersonProfileEvidence(source, source.text, candidates, 'person-A'), ProfileAttributionError);
});

test('mention attribution requires actual platform mention metadata, not textual markup alone', () => {
  for (const token of ['<@B>', '<@!B>', '@B']) {
    const text = `${token}不吃辣`, proof = evidence(text, 'mention', token);
    assert.throws(() => resolveProfileSubject(proof, message(text), candidates), ProfileAttributionError);
    assert.throws(() => resolveProfileSubject(proof, message(text, { mentionedSenderIds: ['C'] }), candidates), ProfileAttributionError);
    assert.deepEqual(resolveProfileSubject(proof, message(text, { mentionedSenderIds: ['B'] }), candidates),
      { personId: 'person-B', sourceType: 'third_party' });
  }
});

test('evidence is bound to the exact original and human role; extra identity fields cannot grant authority', () => {
  const source = message('我喜欢茶'), valid = evidence(source.text);
  for (const proof of [{ ...valid, messageId: 'another' }, { ...valid, factQuote: '我喜欢咖啡' },
    { ...valid, subjectQuote: '本人' }, { ...valid, personId: 'person-B' }, { ...valid, speaker: 'B' }]) {
    assert.throws(() => resolveProfileSubject(proof, source, candidates), ProfileAttributionError);
  }
  assert.throws(() => resolveProfileSubject(valid, { ...source, role: 'assistant' }, candidates), ProfileAttributionError);
});

test('AI inference accepts explicit local style instructions and rejects other bots, quotes and evaluations', () => {
  for (const text of ['你以后回复简洁一点', '以后回复简洁一点', '解释复杂问题时先给例子', '你以后叫“小白”']) {
    const source = message(text), proof = inferAiProfileEvidence(source.id, text);
    assert.equal(proof.subjectKind, 'ai');
    assert.doesNotThrow(() => assertAiProfileEvidence(proof, source));
  }
  for (const text of ['另一个Bot以后回复简洁', '那个机器人以后叫小白', '他说“你以后回答简洁”', '我觉得你回答很好',
    '你回答很好', '你回复太慢了', '如果你以后回答都只有一句话，用户会听不懂']) {
    assert.throws(() => inferAiProfileEvidence('message', text), ProfileAttributionError, text);
  }
  const reported = message('另一个Bot的设定：你以后叫小坏');
  assert.throws(() => assertAiProfileEvidence(evidence('你以后叫小坏', 'ai', '你'), reported), ProfileAttributionError);
});
