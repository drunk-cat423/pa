import assert from 'node:assert/strict';
import test from 'node:test';
import { validateExtract } from '../dist/auto-memory.js';
import { decodeMemoryWireResponse } from '../dist/memory-wire.js';
import {profileOmissionIncidents} from './fixtures/production-incidents.mjs';

function inputWithFacts(count = 46) {
  const old = { id: 'old', conversationId: 'room', personId: 'alice', role: 'user', text: '我的稳定偏好',
    ingestSeq: 1, createdAt: '2026-10-01T00:00:00Z' };
  const message = { ...old, id: 'new', text: '我现在喜欢茶，也喜欢阅读', ingestSeq: 2, createdAt: '2026-10-02T00:00:00Z' };
  return { pipeline: 'materials', materialsProtocol: 3, profileProposalProtocol: 'delta-v1', extractionProtocol: 2,
    profileProtocol: 2, profileBaselineProtocol: 1, profileAttributionProtocol: 1, selfProfileProtocol: 2,
    job: { id: 'job', conversationId: 'room', messageIds: ['new'] }, mode: 'profiles', roomType: 'group',
    messages: [message], profileSources: [old], profiles: [{ personId: 'alice', baseVersion: 7,
      facts: Array.from({ length: count }, (_, index) => ({ content: `稳定偏好${index}`, sourceType: 'self', messageIds: ['old'] })),
      pending: [{ id: 'p0', content: '我现在喜欢茶', sourceMessageId: 'new', sourceType: 'self' },
        { id: 'p1', content: '也喜欢阅读', sourceMessageId: 'new', sourceType: 'self' }] }] };
}
const decode = (proposal, input) => decodeMemoryWireResponse(proposal, input);
const checked = (proposal, input) => validateExtract(decode(proposal, input), input);


test('五次历史画像遗漏事故按旧契约拒绝，新任务仅提交真实修改仍继承遗漏条目',()=>{
  for(const incident of profileOmissionIncidents) {
    const input=inputWithFacts(),legacy=structuredClone(input);delete legacy.profileProposalProtocol;
    const covered=new Set(incident.proposal.facts.flatMap(fact=>fact.keep?[fact.keep]:fact.replaces??[]));
    assert.deepEqual(input.profiles[0].facts.flatMap((_,index)=>covered.has(`f${index}`)?[]:[index]),[incident.omitted]);
    assert.throws(()=>decode(incident.proposal,legacy),/单人物画像提案/);
    // Explicitly translate the old proposal into a new-task delta; do not silently upgrade frozen jobs.
    const changes=incident.proposal.facts.filter(fact=>!fact.keep),replaced=new Set(changes.flatMap(fact=>fact.replaces));
    const result=checked({changes},input).profiles[0],inherited=input.profiles[0].facts.filter((_,index)=>!replaced.has(`f${index}`));
    assert.deepEqual(result.facts.slice(0,inherited.length),inherited,incident.id);
    assert.ok(result.facts.some(fact=>fact.content===input.profiles[0].facts[incident.omitted].content));
    assert.equal(result.facts.length,46);
    assert.deepEqual(result.facts.slice(inherited.length).map(fact=>fact.content),changes.map(fact=>fact.content));
  }
});
