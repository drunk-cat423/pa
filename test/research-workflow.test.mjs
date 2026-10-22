import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleResearchReport, hasFetchedSource, isResearchSourceMaterial, parseResearchPlan, parseResearchReview, parseResearchSection, researchSources } from '../dist/research-workflow.js';

const url = 'https://example.com/source';
const evidence = [{ tool: 'web_fetch', input: { url }, result: { url, text: '实际网页正文' } }];
const section = { id: 's1', title: '结论', objective: '回答问题', acceptance: '有来源的结论', version: 0, status: 'pending', markdown: '', summary: '', sources: [], gaps: [] };
const output = (values = {}, body = '已核验的正文。') => `<research_section>${JSON.stringify({ status: 'written', summary: '结论摘要', sources: [url], gaps: [], ...values })}</research_section>\n${body}`;

test('研究计划由程序赋ID，拒绝空计划、截断、过多章节与不完整验收', () => {
  assert.deepEqual(parseResearchPlan(JSON.stringify({ sections: [{ ...section, id: '../../other' }] }), 'stop'),
    { version: 1, sections: [{ id: 's1', title: section.title, objective: section.objective, acceptance: section.acceptance }] });
  for (const sections of [[], Array(9).fill(section), [{ title: '遗漏目标' }]]) assert.throws(() => parseResearchPlan(JSON.stringify({ sections }), 'stop'));
  assert.throws(() => parseResearchPlan(JSON.stringify({ sections: [section] }), 'length'));
});

test('已知截断保留可读正文并强制draft；续写只能追加到原章节版本', () => {
  const first = parseResearchSection(output({ sectionId: 's8', expectedVersion: 99 }), 'length', section, evidence);
  assert.equal(first.status, 'draft'); assert.equal(first.sectionId, 's1'); assert.equal(first.expectedVersion, 0);
  assert.equal(first.mode, 'replace');
  const next = parseResearchSection(output({ sources: [] }, '下一段正文。'), 'stop', { ...section, ...first, version: 2, status: 'draft' }, evidence);
  assert.equal(next.mode, 'append'); assert.equal(next.expectedVersion, 2); assert.deepEqual(next.sources, [url]);
  assert.equal(next.markdown, '下一段正文。'); assert.equal(next.status, 'written');
});

test('章节拒绝伪造来源、错误响应与被截断的元数据，允许明确缺材料的空blocked', () => {
  assert.throws(() => parseResearchSection(output({ sources: ['https://unknown.example/'] }), 'stop', section, evidence), /尚未取得/);
  for (const raw of ['<research_section>{', '<｜DSML｜calls>web_fetch', '{}']) assert.throws(() => parseResearchSection(raw, 'length', section, evidence));
  assert.throws(() => parseResearchSection(output(), 'error', section, evidence));
  const blocked = parseResearchSection(output({ status: 'blocked', sources: [], gaps: ['缺原文'] }, ''), 'stop', section, []);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.markdown, '');
});

test('来源许可来自本任务成功工具结果，搜索命中不等于读取正文', () => {
  const search = [{ tool: 'web_search', input: {}, result: { sources: [{ url }] } }];
  assert.deepEqual([...researchSources(search)], [url]);
  assert.equal(hasFetchedSource({ ...section, sources: [url] }, search), false);
  assert.equal(hasFetchedSource({ ...section, sources: [url] }, evidence), true);
  assert.equal(hasFetchedSource({ ...section, sources: [url] }, [{ ...evidence[0], error: 'failed' }]), false);
  assert.deepEqual([...researchSources([{ ...evidence[0], error: 'failed' }])], []);
  const variants = [{ tool: 'web_search', input: {}, result: { sources: [{ url: 'https://docs.example#part' }, { url: 'https://docs.example/a#top' }] } }];
  assert.deepEqual([...researchSources(variants)], ['https://docs.example/', 'https://docs.example/a']);
  assert.equal(isResearchSourceMaterial(variants[0], ['https://docs.example/']), true);
  assert.equal(isResearchSourceMaterial(variants[0], ['https://docs.example/a']), true);
  assert.equal(isResearchSourceMaterial(variants[0], ['https://other.example/']), false);
});

test('审查绑定当前版本，拒绝格式错误与length；程序组装保留正文和状态但不再生成', () => {
  const current = { ...section, version: 3, status: 'written', markdown: '独立正文', summary: '已写', sources: [url] };
  assert.deepEqual(parseResearchReview('{"verdict":"pass","reason":"来源充分","expectedVersion":999}', 'stop', current),
    { sectionId: 's1', expectedVersion: 3, verdict: 'pass', reason: '来源充分' });
  assert.throws(() => parseResearchReview('{"verdict":"pass","reason":"ok"}', 'length', current));
  assert.throws(() => parseResearchReview('{"verdict":"completed"}', 'stop', current));
  const assembled = assembleResearchReport({ title: '固定任务' }, { sections: [current, { ...section, id: 's2', title: '待写章' }] }, 'partial', '额度耗尽');
  assert.equal(assembled.status, 'partial'); assert.match(assembled.markdown, /未完成.*额度耗尽/);
  assert.match(assembled.markdown, /独立正文/); assert.match(assembled.markdown, /本章尚无正文/); assert.match(assembled.markdown, /https:\/\/example.com\/source/);
  assert.throws(() => assembleResearchReport({ title: '固定任务' }, { sections: [{ ...current, markdown: 'a'.repeat(200000) }] }, 'completed'), /容量上限/);
});
