import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { projectResearchMaterials, withMaterialOmissionGap } from '../dist/research-materials.js';
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

test('重复材料读取返回准确已读范围，跳读保留缺口且可显式重读被省略正文', () => {
  const saved=fetch('e1','body.js','x'.repeat(7000));
  const reader=new ResearchMaterialReader(()=>saved);
  const tail=reader.read({id:'e1',offset:2800},16000);
  assert.equal(tail.nextUnreadOffset,0); assert.equal(tail.complete,false);
  const first=reader.read({id:'e1'},16000);
  assert.equal(first.offset,0); assert.equal(first.nextUnreadOffset,5600);
  const duplicate=reader.read({id:'e1',offset:0},16000);
  assert.equal(duplicate.alreadyRead,true); assert.equal(duplicate.text,'');
  assert.equal(duplicate.endOffset,2800); assert.equal(duplicate.nextUnreadOffset,5600);
  const partial=reader.read({id:'e1',offset:5500},16000);
  assert.equal(partial.endOffset,5600); assert.equal(partial.nextUnreadOffset,5600);
  assert.equal(partial.complete,false);
  const reread=reader.read({id:'e1',offset:0,reread:true},16000);
  assert.equal(reread.text,first.text); assert.equal(reread.nextUnreadOffset,5600);
  const end=reader.read({id:'e1'},16000);
  assert.equal(end.offset,5600); assert.equal(end.complete,true); assert.equal(end.nextOffset,undefined);
  // A byte-limited short page is also suppressed on an identical read.
  const short=new ResearchMaterialReader(()=>saved), page=short.read({id:'e1'},1000);
  const shortRepeat=short.read({id:'e1',offset:0},1000);
  assert.equal(shortRepeat.alreadyRead,true); assert.equal(shortRepeat.endOffset,page.endOffset);
  const fresh=new ResearchMaterialReader(()=>saved);
  assert.equal(fresh.read({id:'e1'},16000).offset,0);
  const raw=new ResearchMaterialReader(()=>({...saved,result:{...saved.result,coverage:undefined}}));
  assert.equal(raw.read({id:'e1'},16000).format,'raw_record');
  const search=new ResearchMaterialReader(()=>({id:'e1',tool:'web_search',result:{summary:'摘要',sources:[{url:'https://example.org'}]}}));
  const summary=search.read({id:'e1'},16000);
  assert.equal(summary.format,'search_summary'); assert.match(summary.text,/不代表已读取网页原文/);
});

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
  assert.match(collecting.notice, /不传offset/); assert.match(collecting.notice, /nextUnreadOffset/);
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
