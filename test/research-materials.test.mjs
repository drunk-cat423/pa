import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { projectResearchMaterials } from '../dist/research-materials.js';
import { ResearchMaterialReader, RESEARCH_MATERIAL_PREFIX } from '../dist/research-material-reader.js';

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

test('材料正文分页不再切JSON外壳，按实际返回范围续读且不被工具字节上限截断', () => {
  const full = '头部😀\n' + 'const value = "转义\\与表情😀";\n'.repeat(350);
  const saved = fetch('e1','body.js',full,5,full.length);
  const original = structuredClone(saved), expected = full.slice(5);
  const reader = new ResearchMaterialReader(id=>id==='e1'?saved:undefined);
  let actual='', offset=0, reads=0;
  while (true) {
    const value=reader.read({id:'e1',offset},1600);
    assert.equal(value.format,'web_body'); assert.equal(value.offset,offset);
    assert.equal(value.text,[...expected].slice(offset,value.endOffset).join(''));
    assert.ok(value.endOffset-offset<=2800); assert.ok(value.text.isWellFormed());
    assert.ok(Buffer.byteLength(RESEARCH_MATERIAL_PREFIX+JSON.stringify(value))<=1600);
    assert.deepEqual(value.sourceCoverage,{offset:5,end:full.length,totalChars:full.length,contentHash:digest(full),unit:'utf16'});
    actual+=value.text; reads++;
    if (value.complete) break;
    assert.equal(value.nextUnreadOffset,value.nextOffset); offset=value.nextUnreadOffset;
  }
  assert.ok(reads>3); assert.equal(actual,expected); assert.deepEqual(saved,original);
  assert.throws(()=>reader.read({id:'e2'},1600),/当前任务/);
  assert.throws(()=>reader.read({id:'e1',offset:[...expected].length+1},1600),/游标/);
  const tight = new ResearchMaterialReader(()=>saved);
  assert.throws(()=>tight.read({id:'e1'},256),/预算/);
  assert.equal(tight.read({id:'e1'},1600).offset,0);
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
