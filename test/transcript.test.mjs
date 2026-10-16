import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRecordedTurns } from '../dist/transcript.js';

const timestamp = '2026-10-16T00:00:00.000Z';
const header = { type: 'session', version: 3, id: 'fixture', cwd: 'fixture', timestamp };
const marker = (id, parentId, runId) => ({ type: 'custom', id, parentId, timestamp, customType: 'pa_run', data: { runId } });
const message = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp,
  message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { stopReason: 'stop' } : {}) } });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pa-transcript-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  return { dir, file, save: entries => writeFile(file, entries.map(JSON.stringify).join('\n') + '\n') };
}

test('只读恢复沿最后entry的parent分支读取marker与entry id，不混入旁支或上下文删除投影', async t => {
  const f = await fixture(t);
  await f.save([header, marker('r1', null, 'run-one'), message('u1', 'r1', 'user', '问题一'),
    message('a1', 'u1', 'assistant', '答案一'), marker('unused', 'a1', 'other-run'),
    message('unused-u', 'unused', 'user', '旁支问题'), message('unused-a', 'unused-u', 'assistant', '旁支答案'),
    marker('r2', 'a1', 'run-two'), message('u2', 'r2', 'user', '问题二'),
    message('a2', 'u2', 'assistant', '答案二'), { type: 'context_edit', id: 'hide', parentId: 'a2', timestamp, targetId: 'u1', replacement: null }]);
  const before = await readFile(f.file, 'utf8');
  assert.deepEqual(await readRecordedTurns(f.file), [
    { runId: 'run-one', user: { entryId: 'u1', text: '问题一' }, assistant: { entryId: 'a1', text: '答案一', stopReason: 'stop' } },
    { runId: 'run-two', user: { entryId: 'u2', text: '问题二' }, assistant: { entryId: 'a2', text: '答案二', stopReason: 'stop' } },
  ]);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('旧工具结果可读取，未标记的第二用户消息不能借用后续答案', async t => {
  const f = await fixture(t);
  await f.save([header, marker('r', null, 'run'), message('u', 'r', 'user', '问题'),
    ...['update_profile', 'answer_in_depth'].map((toolName, i) => ({ type: 'message', id: 't' + i,
      parentId: i ? 't0' : 'u', timestamp, message: { role: 'toolResult', toolName, toolCallId: 'old-' + i,
        isError: false, content: [{ type: 'text', text: '旧结果' }] } })),
    message('a', 't1', 'assistant', '原答案'), message('unmarked-u', 'a', 'user', '未标记问题'),
    message('unmarked-a', 'unmarked-u', 'assistant', '不能归给run')]);
  const turns = await readRecordedTurns(f.file);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].assistant.text, '原答案');
});

test('不存在会话返回空；坏行、父链、marker、重复id严格拒绝并不改文件', async t => {
  const f = await fixture(t);
  assert.deepEqual(await readRecordedTurns(f.file), []);
  for (const entries of [[header, marker('r', 'missing', 'run')], [header, marker('r', null, '')],
    [header, marker('r', null, 'run'), marker('r', null, 'duplicate')]]) {
    await f.save(entries);
    const before = await readFile(f.file, 'utf8');
    await assert.rejects(readRecordedTurns(f.file), /会话文件损坏/);
    assert.equal(await readFile(f.file, 'utf8'), before);
  }
  for (const content of ['', JSON.stringify(header) + '\n{bad-json\n']) {
    await writeFile(f.file, content);
    await assert.rejects(readRecordedTurns(f.file), /会话文件损坏/);
    assert.equal(await readFile(f.file, 'utf8'), content);
  }
  await assert.rejects(readRecordedTurns(f.dir), /普通文件/);
});

test('只读reader拒绝符号链接会话文件', async t => {
  const f = await fixture(t);
  await f.save([header]);
  const link = join(f.dir, 'linked.jsonl');
  try { await symlink(f.file, link, 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('当前Windows账号没有创建文件symlink权限'); throw error; }
  await assert.rejects(readRecordedTurns(link), /普通文件/);
});
