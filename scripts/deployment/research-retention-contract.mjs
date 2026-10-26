// Stable research-retention v1 dependency contract. Column order also preserves legacy pending hashes.
import { createHash } from 'node:crypto';
export const RESEARCH_COLUMNS = {
  research_tasks: 'id:TEXT:0:1 conversation_id:TEXT:1:0 source_message_id:TEXT:1:0 actor_id:TEXT:1:0 person_id:TEXT:1:0 item_key:TEXT:1:0 input_json:TEXT:1:0 title:TEXT:1:0 goal:TEXT:1:0 urls_json:TEXT:1:0 requires_original:INTEGER:1:0 status:TEXT:1:0 attempt:INTEGER:1:0 latest_version:INTEGER:0:0 reason:TEXT:0:0 created_at:TEXT:1:0 updated_at:TEXT:1:0',
  research_attempts: 'task_id:TEXT:1:1 attempt:INTEGER:1:2 source_message_id:TEXT:1:0 action_key:TEXT:1:0 status:TEXT:1:0 budget_json:TEXT:0:0 usage_json:TEXT:1:0 reason:TEXT:0:0 created_at:TEXT:1:0 updated_at:TEXT:1:0',
  research_workflow_plans: 'task_id:TEXT:0:1 attempt:INTEGER:1:0 cycle:INTEGER:1:0 plan_json:TEXT:1:0 created_at:TEXT:1:0',
  research_workflow_cycles: 'task_id:TEXT:1:1 cycle:INTEGER:1:2 attempt:INTEGER:1:0 phase:TEXT:1:0 section_id:TEXT:0:0 expected_version:INTEGER:0:0 input_json:TEXT:1:0 input_hash:TEXT:1:0 status:TEXT:1:0 reason:TEXT:0:0 created_at:TEXT:1:0 updated_at:TEXT:1:0',
  research_collection_cycles: 'task_id:TEXT:1:1 attempt:INTEGER:1:0 cycle:INTEGER:1:2 input_json:TEXT:1:0 input_hash:TEXT:1:0 status:TEXT:1:0 result_json:TEXT:0:0 reason:TEXT:0:0 created_at:TEXT:1:0 updated_at:TEXT:1:0',
  research_workflow_sections: 'task_id:TEXT:1:1 section_id:TEXT:1:2 version:INTEGER:1:0 status:TEXT:1:0 review_reason:TEXT:0:0 updated_at:TEXT:1:0',
  research_workflow_versions: 'task_id:TEXT:1:1 section_id:TEXT:1:2 version:INTEGER:1:3 attempt:INTEGER:1:0 cycle:INTEGER:1:0 mode:TEXT:1:0 status:TEXT:1:0 summary:TEXT:1:0 sources_json:TEXT:1:0 gaps_json:TEXT:1:0 content_hash:TEXT:1:0 content_bytes:INTEGER:1:0 created_at:TEXT:1:0',
  research_workflow_reviews: 'task_id:TEXT:1:1 cycle:INTEGER:1:2 section_id:TEXT:1:0 version:INTEGER:1:0 attempt:INTEGER:1:0 verdict:TEXT:1:0 reason:TEXT:1:0 created_at:TEXT:1:0',
  research_reports: 'task_id:TEXT:1:1 version:INTEGER:1:2 attempt:INTEGER:1:0 status:TEXT:1:0 abstract:TEXT:1:0 keywords_json:TEXT:1:0 content_hash:TEXT:1:0 created_at:TEXT:1:0',
  research_deliveries: 'id:TEXT:0:1 task_id:TEXT:1:0 version:INTEGER:1:0 source_message_id:TEXT:1:0 kind:TEXT:1:0 format:TEXT:1:0 attempt:INTEGER:1:0 text:TEXT:0:0 status:TEXT:1:0 external_message_id:TEXT:0:0 reference_index:TEXT:0:0 message_id:TEXT:0:0 created_at:TEXT:1:0 updated_at:TEXT:1:0',
  research_evidence: 'task_id:TEXT:1:1 attempt:INTEGER:1:2 ordinal:INTEGER:1:3 evidence_json:TEXT:1:0 created_at:TEXT:1:0',
  research_task_archives: 'task_id:TEXT:0:1 conversation_id:TEXT:1:0 source_message_id:TEXT:1:0 operator_actor_id:TEXT:1:0 operator_person_id:TEXT:1:0 reason:TEXT:1:0 created_at:TEXT:1:0 snapshot_hash:TEXT:1:0',
};

export const RESEARCH_RETENTION_CONTRACT = Object.freeze({ domain: 'research-retention', version: 1 });
// Exact ledger-only DDL from migrateSessionIntegrity; never authorize by name alone.
// Kept here so the maintenance script remains usable without importing application code.
const SAFE_RUN_TRIGGERS = {
  session_integrity_runs_insert: 'a5e0dcefd4f18cd72edcfbc097beb6113d7ea7674d04c8eccbd0af5cec92b653',
  session_integrity_runs_update: 'de3c1493770abee2f0655e009f0c41ae64f426740c2956f3fd60fd55ac96e804',
  session_integrity_runs_delete: 'ee06de02d6710f08593af6a7f9114c811d736d1cfa9a06aea4acc6e300106c49',
};
const SESSION_LEDGER_COLUMNS = {
  session_integrity: 'id:INTEGER:0:1 conversation_id:TEXT:1:0 file:TEXT:1:0 run_id:TEXT:1:0 input_message_id:TEXT:1:0 status:TEXT:1:0 revision:INTEGER:1:0 verified_revision:INTEGER:0:0 hash:TEXT:0:0 changed_at:TEXT:1:0 verified_at:TEXT:0:0 audited_at:TEXT:0:0 error:TEXT:0:0',
  session_integrity_canonical_messages: 'message_id:TEXT:0:1 conversation_id:TEXT:1:0 message_rowid:INTEGER:1:0',
  session_integrity_sweeps: 'conversation_id:TEXT:0:1 last_id:INTEGER:1:0 updated_at:TEXT:1:0',
};
const reject = reason => { throw new Error(`研究清理结构契约不兼容：${reason}`); };
const quote = name => '"' + name.replaceAll('"', '""') + '"';
export const researchProjection = table => RESEARCH_COLUMNS[table].split(' ').map(column => quote(column.split(':')[0])).join(',');

function columns(db, table, specification, optional = false) {
  const object = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(table);
  if (!object && optional) return false;
  if (!object || object.type !== 'table' || /\b(?:VIRTUAL|WITHOUT\s+ROWID)\b/i.test(object.sql)) reject(`缺少常规表 ${table}`);
  const actual = db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all();
  if (actual.some(column => ['rowid','oid','_rowid_'].includes(column.name.toLowerCase()))) reject(`${table} 物理行号被遮蔽`);
  const expected = specification.split(' ').map(column => column.split(':'));
  for (const [name,type,notnull,pk] of expected) {
    const column = actual.find(item => item.name === name);
    if (!column || column.type.toUpperCase() !== type || column.notnull !== Number(notnull)
      || column.pk !== Number(pk) || column.hidden !== 0) reject(`${table}.${name}`);
  }
  if (actual.some(column => column.pk && !expected.some(([name]) => name === column.name))) reject(`${table} 主键变化`);
  return true;
}

function foreignKeys(rows) {
  const groups = new Map();
  for (const [id,seq,table,from,to,onUpdate,onDelete,match] of rows) {
    if (!groups.has(id)) groups.set(id, {table,onUpdate,onDelete,match,columns:[]});
    groups.get(id).columns[seq] = [from,to];
  }
  return [...groups.values()].map(value => JSON.stringify(value)).sort();
}

/** Read-only capability and structural validation, independent of the global schema version. */
export function validateResearchRetentionContract(db) {
  const schema = Number(db.prepare('PRAGMA user_version').get().user_version);
  const marker = columns(db,'maintenance_contracts','domain:TEXT:0:1 version:INTEGER:1:0',true);
  if (marker) {
    const value = db.prepare('SELECT version FROM maintenance_contracts WHERE domain=?').get(RESEARCH_RETENTION_CONTRACT.domain);
    if (value?.version !== RESEARCH_RETENTION_CONTRACT.version) reject('未知 maintenance contract');
  } else if (!Number.isInteger(schema) || schema < 27 || schema > 30) reject('缺少 maintenance contract；无标记仅兼容 schema27至30');
  for (const [table,specification] of Object.entries(RESEARCH_COLUMNS)) {
    columns(db,table,specification);
    const actual = db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()
      .filter(row => specification.split(' ').some(column => column.startsWith(row.from+':')))
      .map(row => [row.id,row.seq,row.table,row.from,row.to,row.on_update,row.on_delete,row.match]);
    if (JSON.stringify(foreignKeys(actual)) !== JSON.stringify(foreignKeys(FOREIGN_KEYS[table]))) reject(`${table} 外键变化`);
  }
  columns(db,'conversations','id:TEXT:0:1 pi_session_file:TEXT:1:0');
  columns(db,'agent_runs','id:TEXT:0:1 pi_session_file:TEXT:0:0');
  columns(db,'research_retention_runs','id:TEXT:0:1 policy_version:INTEGER:1:0 plan_json:TEXT:1:0 post_hashes_json:TEXT:1:0 status:TEXT:1:0 created_at:TEXT:1:0 completed_at:TEXT:0:0',true);
  const triggers=db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'").all();
  const hasRunTriggers=triggers.some(trigger=>trigger.tbl_name.toLowerCase()==='agent_runs');
  const ledgerTables=new Set(Object.keys(SESSION_LEDGER_COLUMNS));
  for (const [table,specification] of Object.entries(SESSION_LEDGER_COLUMNS)) {
    if (!columns(db,table,specification,!hasRunTriggers)) continue;
    if (db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().some(column=>column.hidden)) reject(`账本存在未核验生成列 ${table}`);
    const expectedKey={session_integrity:'file',session_integrity_canonical_messages:'message_id',session_integrity_sweeps:'conversation_id'}[table];
    const unique=db.prepare(`PRAGMA index_list(${quote(table)})`).all().filter(index=>index.unique);
    if (unique.length!==1) reject(`账本唯一键变化 ${table}`);
    const key=db.prepare(`PRAGMA index_xinfo(${quote(unique[0].name)})`).all().filter(column=>column.key);
    if (unique[0].partial || key.length!==1 || key[0].name!==expectedKey || key[0].coll!=='BINARY' || key[0].desc) reject(`账本唯一键变化 ${table}`);
  }
  const protectedTables = new Set([...Object.keys(RESEARCH_COLUMNS),...ledgerTables,
    'conversations','agent_runs','research_retention_runs','maintenance_contracts']);
  for (const trigger of triggers) {
    const known = trigger.tbl_name.toLowerCase()==='agent_runs' && SAFE_RUN_TRIGGERS[trigger.name]
      === createHash('sha256').update(trigger.sql.replace(/\s+/g,' ').trim()).digest('hex');
    if (protectedTables.has(trigger.tbl_name.toLowerCase()) && !known) reject(`相关表存在未核验触发器 ${trigger.name}`);
  }
  // A new child FK on one of the replaced payloads could cascade writes outside research.
  const updated = { research_evidence:['evidence_json'],research_workflow_cycles:['input_json'],
    research_collection_cycles:['input_json','result_json'],research_retention_runs:['status','completed_at'] };
  for (const [table,payloads] of Object.entries(updated)) {
    // UNIQUE ... ON CONFLICT REPLACE can silently delete a different row when
    // two payloads receive the same tombstone. Expression/generated keys are
    // equally unsafe without a new reviewed contract.
    const metadata=db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all();
    if (metadata.some(column=>column.hidden)) reject(`正文更新表存在未核验生成列 ${table}`);
    for (const index of db.prepare(`PRAGMA index_list(${quote(table)})`).all().filter(index=>index.unique)) {
      for (const column of db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all().filter(column=>column.key)) {
        if (column.cid < 0 || payloads.includes(column.name)
          || (table==='research_retention_runs' && (column.name!=='id' || index.origin!=='pk'))) reject(`正文更新关联未知唯一索引 ${index.name}`);
      }
    }
  }
  for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()) {
      // The known run triggers write ledger rows and delete canonical links.
      // Any added FK (either direction) could turn these operations into writes
      // to raw data or another trigger-bearing table; the reviewed ledger has none.
      if (ledgerTables.has(name.toLowerCase()) || ledgerTables.has(fk.table.toLowerCase())) reject(`账本关联未知外键 ${name}`);
      if (updated[fk.table.toLowerCase()]?.includes(fk.to?.toLowerCase())
        || updated[name.toLowerCase()]?.includes(fk.from.toLowerCase())) reject(`正文更新关联未知外键 ${name}`);
    }
  }
  return RESEARCH_RETENTION_CONTRACT;
}

export function validateResearchDiagnosticContract(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 1) reject('诊断索引协议未知');
  columns(db,'calls','call_id:TEXT:0:1 job_id:TEXT:0:0 task_id:TEXT:0:0 trace_id:TEXT:1:0 record_json:TEXT:1:0');
}
const FOREIGN_KEYS = {
  research_tasks: [[0,0,"actors","actor_id","id","NO ACTION","NO ACTION","NONE"],[1,0,"messages","source_message_id","id","NO ACTION","NO ACTION","NONE"],[2,0,"conversations","conversation_id","id","NO ACTION","NO ACTION","NONE"]],
  research_attempts: [[0,0,"messages","source_message_id","id","NO ACTION","NO ACTION","NONE"],[1,0,"research_tasks","task_id","id","NO ACTION","NO ACTION","NONE"]],
  research_workflow_plans: [[0,0,"research_attempts","task_id","task_id","NO ACTION","NO ACTION","NONE"],[0,1,"research_attempts","attempt","attempt","NO ACTION","NO ACTION","NONE"],[1,0,"research_tasks","task_id","id","NO ACTION","NO ACTION","NONE"]],
  research_workflow_cycles: [[0,0,"research_attempts","task_id","task_id","NO ACTION","NO ACTION","NONE"],[0,1,"research_attempts","attempt","attempt","NO ACTION","NO ACTION","NONE"],[1,0,"research_tasks","task_id","id","NO ACTION","NO ACTION","NONE"]],
  research_collection_cycles: [[0,0,"research_attempts","task_id","task_id","NO ACTION","NO ACTION","NONE"],[0,1,"research_attempts","attempt","attempt","NO ACTION","NO ACTION","NONE"],[1,0,"research_tasks","task_id","id","NO ACTION","NO ACTION","NONE"]],
  research_workflow_sections: [[0,0,"research_tasks","task_id","id","NO ACTION","NO ACTION","NONE"]],
  research_workflow_versions: [[0,0,"research_workflow_cycles","task_id","task_id","NO ACTION","NO ACTION","NONE"],[0,1,"research_workflow_cycles","cycle","cycle","NO ACTION","NO ACTION","NONE"],[1,0,"research_workflow_sections","task_id","task_id","NO ACTION","NO ACTION","NONE"],[1,1,"research_workflow_sections","section_id","section_id","NO ACTION","NO ACTION","NONE"]],
  research_workflow_reviews: [[0,0,"research_workflow_cycles","task_id","task_id","NO ACTION","NO ACTION","NONE"],[0,1,"research_workflow_cycles","cycle","cycle","NO ACTION","NO ACTION","NONE"],[1,0,"research_workflow_versions","task_id","task_id","NO ACTION","NO ACTION","NONE"],[1,1,"research_workflow_versions","section_id","section_id","NO ACTION","NO ACTION","NONE"],[1,2,"research_workflow_versions","version","version","NO ACTION","NO ACTION","NONE"]],
  research_reports: [[0,0,"research_attempts","task_id","task_id","NO ACTION","NO ACTION","NONE"],[0,1,"research_attempts","attempt","attempt","NO ACTION","NO ACTION","NONE"],[1,0,"research_tasks","task_id","id","NO ACTION","NO ACTION","NONE"]],
  research_deliveries: [[0,0,"messages","message_id","id","NO ACTION","NO ACTION","NONE"],[1,0,"messages","source_message_id","id","NO ACTION","NO ACTION","NONE"],[2,0,"research_tasks","task_id","id","NO ACTION","NO ACTION","NONE"]],
  research_evidence: [[0,0,"research_attempts","task_id","task_id","NO ACTION","NO ACTION","NONE"],[0,1,"research_attempts","attempt","attempt","NO ACTION","NO ACTION","NONE"]],
  research_task_archives: [[0,0,"actors","operator_actor_id","id","NO ACTION","NO ACTION","NONE"],[1,0,"messages","source_message_id","id","NO ACTION","NO ACTION","NONE"],[2,0,"conversations","conversation_id","id","NO ACTION","NO ACTION","NONE"],[3,0,"research_tasks","task_id","id","NO ACTION","NO ACTION","NONE"]],
};
