import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-service-locks-'));
  const group = join(directory, 'a'.repeat(64)), service = join(directory, 'qq-service');
  await mkdir(group); await mkdir(service);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = () => spawnSync(process.execPath, [resolve('scripts/clear-stale-locks.mjs')], {
    encoding: 'utf8', env: { ...process.env, PA_DATA_DIR: directory },
  });
  return { group, service, run };
}

test('服务启动保留活动进程及无法核实的锁，不清理其他已检查候选', async t => {
  const f = await fixture(t);
  const path = join(f.group, 'conversation.lock');
  await writeFile(path, JSON.stringify({ pid: process.pid }));
  assert.equal(f.run().status, 1);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid);
  await writeFile(path, 'invalid');
  assert.equal(f.run().status, 1);
  assert.equal(await readFile(path, 'utf8'), 'invalid');
});

test('服务启动仅移除已证实退出进程的服务锁和会话锁', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const pid = child.pid;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
  await writeFile(join(f.group, 'conversation.lock'), JSON.stringify({ pid }));
  await writeFile(join(f.service, 'service.lock'), JSON.stringify({ pid }));
  assert.equal(f.run().status, 0);
  await assert.rejects(readFile(join(f.group, 'conversation.lock')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.service, 'service.lock')), { code: 'ENOENT' });
});
