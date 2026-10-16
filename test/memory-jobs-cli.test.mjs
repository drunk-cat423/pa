import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';

test('任务CLI离线状态不泄露原文，retry仅把失败批次重新排队', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-jobs-cli-'));
  const path = join(directory, 'pa.sqlite');
  let store = new ConversationStore(path);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const conversation = store.ensureConversation('room', join(directory, 'session.jsonl'), {
    channel: 'qq', accountId: 'a', roomId: 'g', roomType: 'group',
  });
  store.recordInbound(conversation.id, 'PRIVATE_RAW_TEXT', { eventId: 'event', senderId: 'a', modelInputText: 'PRIVATE_RAW_TEXT' });
  const job = store.autoMemory.reserveBatch(conversation.id, 'capacity');
  const lease = store.autoMemory.claimNext(conversation.id, { owner: 'fixture', leaseMs: 10000 });
  store.autoMemory.fail(job.id, lease.leaseToken, 'fixture_failure'); store.close();
  const run = args => promisify(execFile)(process.execPath, [resolve('dist/memory-jobs-cli.js'), ...args], {
    env: { ...process.env, PA_DATA_DIR: directory, PA_API_KEY: '', PA_MEMORY_ENABLED: 'false' },
  });
  const status = await run(['status']);
  assert.doesNotMatch(status.stdout, /PRIVATE_RAW_TEXT/);
  assert.equal(JSON.parse(status.stdout).jobs[0].status, 'failed');
  const retried = await run(['retry', job.id]);
  assert.equal(JSON.parse(retried.stdout).queued, job.id);
  store = new ConversationStore(path);
  assert.equal(store.autoMemory.status(conversation.id).queued, 1);
  assert.equal(store.autoMemory.status(conversation.id).completed, 0);
});

test('任务CLI显式defer保留失败状态，不带密钥且不清空输入进度，普通retry拒绝', async t => {
  const directory=await mkdtemp(join(tmpdir(),'pa-jobs-defer-'));
  const path=join(directory,'pa.sqlite');
  const store=new ConversationStore(path);
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const conversation=store.ensureConversation('room',join(directory,'session.jsonl'),{channel:'qq',accountId:'a',roomId:'g',roomType:'group'});
  store.recordInbound(conversation.id,'PRIVATE_RAW_TEXT',{eventId:'event',senderId:'a',modelInputText:'PRIVATE_RAW_TEXT'});
  store.autoMemory.reserveBatch(conversation.id,'capacity');
  const job=store.autoMemory.claimNext(conversation.id,{owner:'fixture',leaseMs:60000});
  store.autoMemory.saveProgress(job.id,job.leaseToken,{privateProgress:'PRIVATE_PROGRESS'});
  store.autoMemory.fail(job.id,job.leaseToken,'fixture_failure');
  const run=args=>promisify(execFile)(process.execPath,[resolve('dist/memory-jobs-cli.js'),...args],{
    env:{...process.env,PA_DATA_DIR:directory,PA_API_KEY:'',PA_MEMORY_ENABLED:'false'},
  });
  const result=await run(['defer',job.id,'保留旧批，等待单独补录']);
  assert.doesNotMatch(result.stdout,/PRIVATE_RAW_TEXT|PRIVATE_PROGRESS/);
  const output=JSON.parse(result.stdout);
  assert.equal(output.deferred,job.id);assert.equal(output.jobs[0].status,'failed');assert.equal(output.jobs[0].deferred,true);
  assert.equal(store.autoMemory.status(conversation.id).deferred,1);
  assert.equal(store.autoMemory.status(conversation.id).completed,0);
  await assert.rejects(run(['retry',job.id]),/搁置/);
});
