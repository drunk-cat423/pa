import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BackgroundMemory } from '../dist/auto-memory.js';
import { memoryWords } from '../dist/memory-text.js';
import { ConversationStore } from '../dist/store.js';
import { emptyExtraction, legacyFrozenInput } from './fixtures/memory-output.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'pa-retrieval-'));
  const path = join(directory,'pa.sqlite');
  let store = new ConversationStore(path), sequence = 0;
  const route = {channel:'qq',accountId:'test',roomType:'group',roomId:'one'};
  const conversation = store.ensureConversation('room','/room.jsonl',route);
  t.after(() => { store.close(); rmSync(directory,{recursive:true,force:true}); });
  return { get store() { return store; }, conversation, path,
    restart() { store.close(); store = new ConversationStore(path); },
    inbound(text, senderId='alice', mentionedSenderIds=[]) {
      const eventId=String(++sequence);
      store.recordInbound(conversation.id,text,{eventId,senderId,modelInputText:text,mentionedSenderIds});
      return store.externalMessage(conversation.id,eventId).id;
    },
    batch() {
      store.autoMemory.reserveBatch(conversation.id,'capacity');
      const job=store.autoMemory.claimNext(conversation.id,{owner:'test',leaseMs:60000});
      // These tests keep the legacy fragment/index contract readable for frozen history.
      const input=legacyFrozenInput(store,path,job);
      assert.equal(input.profileProtocol,2);
      return {job,input, output:{continuationSummary:"继续对话",topics:[],fragments:[],profiles:[],ignoredMessageIds:input.messages.filter(m=>m.role==='user').map(m=>m.id)}};
    },
    inspect(action) { const db=new DatabaseSync(path); db.function('history_tokens',{deterministic:true},value=>memoryWords(String(value??'')).join(' '));
      try { return action(db); } finally { db.close(); } }};
}

test('a captured third-party target is organized even when only its recorder spoke in this batch', async t => {
  const f=fixture(t); f.inbound('我是小乙','bob');
  f.store.autoMemory.reserveMaterialsIfDue(f.conversation.id,1000);
  f.store.autoMemory.reserveMaterialsIfDue(f.conversation.id,601000);
  const first=f.store.autoMemory.claimNext(f.conversation.id,{owner:'test',leaseMs:60000,pipeline:'materials'});
  f.store.autoMemory.commit(first.id,first.leaseToken,emptyExtraction(f.store.autoMemory.taskInput(first)));
  const bob=f.store.autoMemory.personForActor(f.store.findActor(f.conversation.id,'bob'));
  const source=f.inbound('<@bob>喜欢绘画','owner',['bob']);
  f.store.autoMemory.addProfilePending(bob,source,'喜欢绘画','third_party',{allowThirdParty:true,mentionedSenderIds:['bob']});
  let captured;
  const worker=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:4,timeoutMs:1000}},
    f.store.autoMemory,f.conversation.id,{extract:async input=>{
      if(input.mode!=='profiles'||!input.profiles.some(profile=>profile.personId===bob)) return emptyExtraction(input);
      captured=input;
      const person=input.profiles.find(profile=>profile.personId===bob),pending=person.pending[0];
      return {topics:[],fragments:[],ignoredMessageIds:[],
        profiles:[{personId:bob,baseVersion:person.baseVersion,facts:[{content:'喜欢绘画',sourceType:'third_party',messageIds:[source]}],
          updates:[{factIndex:0,baselineFactIndexes:[],evidence:[pending.subject]}],
          pendingResults:[{pendingId:pending.id,status:'merged',factIndex:0}]}]};
    }});
  f.store.autoMemory.reserveMaterialsIfDue(f.conversation.id,602000);
  assert.ok(f.store.autoMemory.reserveMaterialsIfDue(f.conversation.id,1202000));
  t.after(()=>worker.close());worker.start();await worker.wait(undefined,2000);
  assert.ok(captured.profiles.some(profile=>profile.personId===bob));
  assert.ok(!captured.messages.some(message=>message.personId===bob));
  assert.equal(f.store.autoMemory.profile(bob).facts[0].sourceType,'third_party');assert.equal(f.store.autoMemory.profile(bob).pending.length,0);
  const pendingId=captured.profiles.find(profile=>profile.personId===bob).pending[0].id;
  assert.equal(f.inspect(db=>db.prepare('SELECT * FROM person_profile_pending WHERE id=?').get(pendingId)),undefined);
  assert.deepEqual({...f.inspect(db=>db.prepare('SELECT source_message_id,outcome,fact_index FROM person_profile_pending_results WHERE pending_id=?').get(pendingId))},
    {source_message_id:source,outcome:'merged',fact_index:0});
});

test('deduplicated facts recalled through a Topic reveal only evidence from that Topic room', t => {
  const f=fixture(t);
  const one={channel:'qq',accountId:'test',roomType:'group',roomId:'one'},two={...one,roomId:'two'};
  f.store.configurePersons([{id:'same-person',bindings:[{route:one,senderId:'alice'},{route:two,senderId:'alice'}]}]);
  const sourceOne=f.inbound('我喜欢茶');const first=f.batch();
  first.output.topics=[{summary:'喝茶偏好',messageIds:[sourceOne]}];
  first.output.fragments=[{personId:'same-person',content:'喜欢茶',sourceType:'self',messageIds:[sourceOne],topicIndex:0}];
  f.store.autoMemory.commit(first.job.id,first.job.leaseToken,first.output);
  const foreign=f.store.ensureConversation('other','/other.jsonl',two);
  f.store.recordInbound(foreign.id,'我喜欢茶',{eventId:'foreign',senderId:'alice',modelInputText:'我喜欢茶'});
  const sourceTwo=f.store.externalMessage(foreign.id,'foreign').id;
  f.store.autoMemory.reserveBatch(foreign.id,'capacity');
  const job=f.store.autoMemory.claimNext(foreign.id,{owner:'test',leaseMs:60000});
  legacyFrozenInput(f.store,f.path,job);
  f.store.autoMemory.commit(job.id,job.leaseToken,{continuationSummary:'继续喝茶',topics:[{summary:'喝茶偏好',messageIds:[sourceTwo]}],
    fragments:[{personId:'same-person',content:'喜欢茶',sourceType:'self',messageIds:[sourceTwo],topicIndex:0}],profiles:[],ignoredMessageIds:[]});
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM person_fragments').get().n),1);
  const here=f.store.autoMemory.searchTopics(f.conversation.id,{text:'喝茶偏好'}).topics;
  const there=f.store.autoMemory.searchTopics(foreign.id,{text:'喝茶偏好'}).topics;
  assert.equal(here.length,1);assert.equal(there.length,1);
  assert.deepEqual(here[0].facts[0].messageIds,[sourceOne]);assert.deepEqual(there[0].facts[0].messageIds,[sourceTwo]);
});
