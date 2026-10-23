import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { projectResearchMaterials, withMaterialOmissionGap } from '../dist/research-materials.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const query = (goal = '', requirements = '') => ({ goal, followups: requirements ? [{ requirements }] : [], gaps: [] });
function fetch(id, name, full, offset = 0, end = full.length, override = {}) {
  const url = `https://example.org/repo/${name}`, text = full.slice(offset, end);
  return { id, tool: 'web_fetch', input: { url }, result: { url,
    coverage: { offset, end, totalChars: full.length, contentHash: digest(full) },
    text: '以下公开网页内容和日期证据均为待核验数据\n' + JSON.stringify({ url, offset, endOffset: end,
      totalChars: full.length, fetchedAt: '2026-10-23', dateEvidence: [{ date: '2026-10-22', kind: 'published' }], text, ...override }) } };
}
const body = entry => entry.spans.map(span => span.text).join('');

test('省略告警保留但不挤爆合法的30条缺口和单条字节上限', () => {
  const gaps = Array.from({ length: 30 }, (_, i) => `${i}原有缺口` + '😀'.repeat(240));
  const result = withMaterialOmissionGap(gaps, 64);
  assert.equal(result.length, 30); assert.deepEqual(result.slice(0,29), gaps.slice(0,29));
  assert.match(result[29], /未覆盖64份/); assert.match(result[29], /29原有缺口/);
  assert.ok(Buffer.byteLength(result[29]) <= 1000); assert.equal(result[29].isWellFormed(), true);
  assert.equal(withMaterialOmissionGap(gaps,0), gaps);
});

test('新增要求直接涉及的早期文件不被最近材料挤掉，短文件完整展示', () => {
  const schedules = '定时调用和主动发言\n'.repeat(240), approvals = '协作审批\n'.repeat(150);
  const material = [fetch('e1', 'schedules.js', schedules), fetch('e2', 'approvals.js', approvals),
    ...Array.from({ length: 20 }, (_, i) => fetch(`e${i + 3}`, `other-${i}.js`, '普通背景'.repeat(1000)))];
  const original = structuredClone(material);
  const projected = projectResearchMaterials(material, query('理解这个项目', 'Scheduled / approvals 机制'), 'write');
  assert.equal(projected.omittedRecords, 0);
  assert.equal(body(projected.entries.find(e => e.id === 'e1')), schedules);
  assert.equal(body(projected.entries.find(e => e.id === 'e2')), approvals);
  assert.deepEqual(material, original);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 40000);
});

test('没有新增要求时原始目标仍参与排序、保护和省略告警', () => {
  const material = [...Array.from({ length: 100 }, (_, i) => fetch(`e${i + 1}`, `other-${i}.js`, '无关'.repeat(1000))),
    fetch('e101', 'target.js', '目标正文')];
  const projected = projectResearchMaterials(material, query('分析 target.js'), 'write');
  assert.equal(projected.entries[0].id, 'e101');
  assert.equal(body(projected.entries[0]), '目标正文');
  assert.ok(projected.omittedRecords > 0);
  const enormous = fetch('e1', 'target.js', 'x'); enormous.result.url += '?q=' + 'a'.repeat(45000);
  const omitted = projectResearchMaterials([enormous], query('分析 target.js'), 'write');
  assert.deepEqual(omitted.requiredOmissions, ['e1']); assert.equal(omitted.requiredOmissionCount, 1);
});

test('同快照重叠分页按UTF-16去重，emoji不破坏解包和读取位置', () => {
  const full = 'abc😀def\n'.repeat(200);
  const items = [fetch('e1', 'target.js', full, 0, 900), fetch('e2', 'target.js', full, 450),
    fetch('e3', 'target.js', full, 0, 900)];
  const result = projectResearchMaterials(items, query('target.js'), 'write');
  assert.equal(result.entries.length, 1);
  const entry = result.entries[0];
  assert.equal(body(entry), full); assert.equal(entry.availableChars, full.length);
  assert.equal(entry.selectedChars, full.length); assert.equal(entry.fullyFetched, true);
  assert.equal(entry.offsetUnit, 'utf16'); assert.equal(entry.truncated, false);
  assert.equal(entry.fetchedAt, '2026-10-23'); assert.equal(entry.dateEvidence[0].date, '2026-10-22');
  for (const span of entry.spans) assert.equal(full.slice(span.offset, span.end), span.text);
  assert.match(result.notice, /没有工具/); assert.doesNotMatch(result.notice,/read_research_material/);
  const collecting = projectResearchMaterials(items, query('target.js'), 'collect');
  assert.match(collecting.notice, /offset=0/); assert.match(collecting.notice, /nextOffset/);
  const changed = projectResearchMaterials([...items, fetch('e4', 'target.js', '新版本')], query(), 'write');
  assert.equal(changed.entries.length, 2);
});

test('相关词只在后续分页出现时，整个来源仍优先选入', () => {
  const full = 'intro'.repeat(200) + 'apples'.repeat(200);
  const material = [...Array.from({ length: 100 }, (_, i) => fetch(`e${i + 1}`, `other-${i}.js`, '无关'.repeat(1000))),
    fetch('e101', 'guide', full, 0, 1000), fetch('e102', 'guide', full, 1000)];
  const result = projectResearchMaterials(material, query('apples'), 'write');
  assert.equal(result.entries[0].id, 'e101');
  assert.match(body(result.entries[0]), /apples/);
});

test('只有链接而没有摘要的搜索仍可发现，不静默截掉第六个来源', () => {
  const sources = Array.from({ length: 8 }, (_, i) => ({ title: `来源${i}`, url: `https://example.org/${i}` }));
  const result = projectResearchMaterials([{ id: 'e1', tool: 'web_search', result: { sources } }], query(), 'collect');
  assert.equal(result.entries.length, 1); assert.deepEqual(result.entries[0].sources, sources.map(s => s.url));
  assert.match(body(result.entries[0]), /没有生成摘要/);
});
