import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectModelErrors, errorMetadata } from '../scripts/deployment/delegation-error-metadata.mjs';

test('recorded vision 503 remains distinct from unknown outcome while private error text is excluded', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-error-projection-'));
  const callId = '8b0a25d8-13b3-47ee-a696-dc67560a5226';
  const unknownId = '8b0a25d8-13b3-47ee-a696-dc67560a5227';
  let app, diagnostics;
  try {
    mkdirSync(join(root, 'diagnostics/calls', callId), { recursive: true });
    app = new DatabaseSync(join(root, 'pa.sqlite'));
    app.exec("CREATE TABLE rooms(id,room_type); CREATE TABLE conversations(id,room_id); CREATE TABLE agent_runs(started_at,error_kind,error_message,status,conversation_id); INSERT INTO rooms VALUES('secret-room','group'); INSERT INTO conversations VALUES('secret-conversation','secret-room');");
    diagnostics = new DatabaseSync(join(root, 'diagnostics/index.sqlite'));
    diagnostics.exec('CREATE TABLE calls(record_json); CREATE TABLE events(call_id,event_json);');
    const now = Date.parse('2026-11-06T00:00:00Z'), time = '2026-11-05T16:00:06Z';
    const error = '503: ' + JSON.stringify({code:'ServiceUnavailable', message:'ViT queue is full: admitted=384, capacity=384, requested=41 PRIVATE_PROMPT sk-private-secret'});
    const bytes = Buffer.from(JSON.stringify({stopReason:'error',errorMessage:error,content:[],other:'secret-profile'}));
    writeFileSync(join(root,'diagnostics/calls',callId,'response.json'),bytes);
    const record = {callId,status:'unknown',createdAt:time,conversationId:'secret-conversation',provider:'bailian',contextCalibration:'private'.repeat(50000),
      model:'deepseek-v4.1-flash-1017',phase:'response',responseRef:{path:'calls/'+callId+'/response.json',sha256:createHash('sha256').update(bytes).digest('hex')}};
    diagnostics.prepare('INSERT INTO calls VALUES(?)').run(JSON.stringify(record));
    diagnostics.prepare('INSERT INTO calls VALUES(?)').run(JSON.stringify({...record,callId:unknownId,responseRef:undefined}));
    diagnostics.prepare('INSERT INTO events VALUES(?,?)').run(callId,JSON.stringify({event:'model.request_prepared',details:{stage:'answer'}}));
    app.prepare('INSERT INTO agent_runs VALUES(?,?,?,?,?)').run(time,'error','模型请求失败：'+error,'failed','secret-conversation');
    const before = app.prepare('PRAGMA user_version').get().user_version;
    const snapshot = collectModelErrors({dataDir:root,now});
    assert.equal(snapshot.complete,true);
    const confirmed = snapshot.records.find(r=>r.callId===callId);
    assert.deepEqual({stage:confirmed.stage,roomType:confirmed.roomType,httpStatus:confirmed.httpStatus,cause:confirmed.cause,
      admitted:confirmed.admitted,capacity:confirmed.capacity,requested:confirmed.requested,evidence:confirmed.evidence},
      {stage:'answer',roomType:'group',httpStatus:503,cause:'vision_queue_full',admitted:384,capacity:384,requested:41,evidence:'provider_error_response'});
    assert.equal(snapshot.records.find(r=>r.callId===unknownId).evidence,'outcome_unknown');
    assert.equal(snapshot.records.find(r=>r.type==='agent_run').cause,'vision_queue_full');
    assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_PROMPT|sk-private|secret-room|secret-conversation|secret-profile/);
    assert.equal(app.prepare('PRAGMA user_version').get().user_version,before);
    assert.deepEqual(errorMetadata('private free-form text'),{});
    diagnostics.close(); diagnostics=undefined;
    rmSync(join(root,'diagnostics/index.sqlite'));
    assert.equal(collectModelErrors({dataDir:root,now}).complete,false);
  } finally { diagnostics?.close();app?.close();rmSync(root,{recursive:true,force:true}); }
});
