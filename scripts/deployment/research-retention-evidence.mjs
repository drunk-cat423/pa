import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateResearchDiagnosticContract } from './research-retention-contract.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function inspectEvidence(path, optional = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
    if (stat.isSymbolicLink() || (cursor !== absolute && !stat.isDirectory())) throw new Error('研究证据路径不安全。');
    if (cursor === absolute) return stat;
  }
}

function readEvidence(root, path, limit) {
  const stat = inspectEvidence(join(root,path));
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('研究证据文件类型或容量无效。');
  const data = readFileSync(join(root,path));
  if (data.length !== stat.size) throw new Error('研究证据读取时已变化。');
  return { data, file:{path,sha256:digest(data),bytes:data.length} };
}

/** Exact task binding only. No Store initialization, glob deletion or diagnostic mutation. */
export function researchEvidence(root, task, rows, removed = new Map()) {
  const files = [], excluded = [], traces = new Set();
  let diagnostics = null;
  const index = join(root,'diagnostics','index.sqlite');
  const indexStat = inspectEvidence(index,true);
  if (indexStat) {
    if (!indexStat.isFile() || indexStat.nlink !== 1) throw new Error('诊断索引无效。');
    for (const suffix of ['-wal','-shm','-journal']) {
      const sidecar = inspectEvidence(index+suffix,true);
      if (sidecar && (!sidecar.isFile() || sidecar.nlink !== 1)) throw new Error('诊断索引附属文件无效。');
    }
    const db = new DatabaseSync(index,{readOnly:true});
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN');
      validateResearchDiagnosticContract(db);
      const calls = db.prepare("SELECT call_id,job_id,task_id,trace_id,record_json FROM calls WHERE task_id=? OR json_extract(record_json,'$.taskId')=? ORDER BY call_id").all(task.id,task.id);
      diagnostics = {dev:String(indexStat.dev),ino:String(indexStat.ino),rowsHash:digest(JSON.stringify(calls)),callIds:calls.map(row=>row.call_id)};
      for (const row of calls) {
        const call = JSON.parse(row.record_json);
        if (!UUID.test(row.call_id) || call.callId !== row.call_id || call.taskId !== task.id || row.task_id !== task.id
          || call.conversationId !== task.conversation_id || call.traceId !== row.trace_id || !UUID.test(call.traceId)
          || call.runId !== call.traceId || row.job_id !== null || call.jobId !== undefined || !['chat','search'].includes(call.kind)) {
          throw new Error('诊断调用的研究归属不一致。');
        }
        traces.add(call.traceId);
        for (const name of ['request','response','input']) {
          const ref = call[`${name}Ref`];
          if (!ref) { if (name === 'request') throw new Error('诊断请求引用缺失。'); continue; }
          const path = `diagnostics/calls/${call.callId}/${name}.json`;
          if (ref.path !== `calls/${call.callId}/${name}.json` || !/^[0-9a-f]{64}$/.test(ref.sha256)
            || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > 16*1024*1024) throw new Error('诊断引用无效。');
          if (removed.get(path) === ref.sha256 && !inspectEvidence(join(root,path),true)) continue;
          const {file} = readEvidence(root,path,16*1024*1024);
          if (file.sha256 !== ref.sha256 || file.bytes !== ref.bytes) throw new Error('诊断正文校验失败。');
          files.push({...file,kind:'diagnostic',callId:call.callId,artifact:name});
        }
      }
      db.exec('COMMIT');
    } finally { db.close(); }
  }
  const keys = new Set(rows.research_attempts.map(row=>`research:${task.id}:${row.attempt}`));
  for (const row of [...rows.research_workflow_cycles,...rows.research_collection_cycles]) keys.add(`research:${task.id}:${row.attempt}:cycle:${row.cycle}`);
  for (const key of [...keys].sort()) {
    const path = `${digest(key)}/session.jsonl`, absolute = join(root,path);
    if (!inspectEvidence(absolute,true)) continue;
    if (inspectEvidence(join(dirname(absolute),'conversation.lock'),true)) { excluded.push({path,reason:'session_locked'}); continue; }
    const {data,file} = readEvidence(root,path,128*1024*1024);
    let entries;
    try { entries = data.toString('utf8').trim().split('\n').map(line=>JSON.parse(line)); }
    catch { excluded.push({path,reason:'unverified_session'}); continue; }
    const runs = entries.filter(entry=>entry.type==='custom' && entry.customType==='pa_run').map(entry=>entry.data?.runId);
    if (entries[0]?.type !== 'session' || !runs.length || runs.some(run=>!traces.has(run))) {
      excluded.push({path,reason:'unverified_session'}); continue;
    }
    files.push({...file,kind:'pi_session',sessionKey:key});
  }
  return {files,excluded,diagnostics};
}

/** Revalidate diagnostic ownership/metadata and Pi locks at both apply phases. */
export function validateResearchEvidence(root, candidate, rows, allowMissing, ordinary = new Set()) {
  if (!candidate.evidence) return; // previously committed v1-v3 manifests keep their original scope
  const task = rows.research_tasks[0];
  const removed = new Map(allowMissing ? candidate.files.map(file=>[file.path,file.sha256]) : []);
  const current = researchEvidence(root,task,rows,removed);
  current.files = current.files.filter(file=>file.kind !== 'pi_session' || !ordinary.has(resolve(root,file.path)));
  if (JSON.stringify(current.diagnostics) !== JSON.stringify(candidate.evidence.diagnostics)) throw new Error('研究诊断索引已变化。');
  const expected = candidate.files.filter(file=>file.kind==='diagnostic'||file.kind==='pi_session');
  for (const file of expected) {
    const found = current.files.find(item=>item.path===file.path);
    if (!found && allowMissing && !inspectEvidence(join(root,file.path),true)) continue;
    if (JSON.stringify(found) !== JSON.stringify(file)) throw new Error('研究证据归属、锁或内容已变化。');
  }
  if (current.files.some(file=>!expected.some(item=>item.path===file.path))) throw new Error('新增研究证据需要重新预览。');
}
