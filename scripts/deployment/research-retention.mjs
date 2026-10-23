import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86400000;
const TABLE = 'research_retention_runs';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const tables = ['research_tasks', 'research_attempts', 'research_workflow_plans', 'research_workflow_cycles',
  'research_collection_cycles', 'research_workflow_sections', 'research_workflow_versions', 'research_workflow_reviews',
  'research_reports', 'research_deliveries', 'research_evidence', 'research_task_archives'];

function inspect(path, missing = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let cursor = root;
  const parts = absolute.slice(root.length).split(sep);
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) {
      if (missing && error.code === 'ENOENT' && i === parts.length - 1) return null;
      throw error;
    }
    if (stat.isSymbolicLink()) fail('清理路径含符号链接，拒绝执行。');
    if (i < parts.length - 1 && !stat.isDirectory()) fail('清理父路径不是目录。');
    if (i === parts.length - 1) return stat;
  }
}

function openDatabase(dataDir, readOnly) {
  const root = resolve(dataDir);
  if (!inspect(root).isDirectory()) fail('数据目录无效。');
  const path = join(root, 'pa.sqlite'), stat = inspect(path);
  if (!stat.isFile() || stat.nlink !== 1) fail('数据库不是独立常规文件。');
  // SQLite may follow sidecar paths even when the main filename is safe.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = inspect(path + suffix, true);
    if (sidecar && (!sidecar.isFile() || sidecar.nlink !== 1)) fail('数据库附属文件无效。');
  }
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const schemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (schemaVersion !== 27) fail('只支持已核验的schema27，不自动迁移数据。');
    for (const table of tables) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) fail('缺少研究数据表。');
    return { db, root, identity: { dev: String(stat.dev), ino: String(stat.ino), schemaVersion } };
  } catch (error) { db.close(); throw error; }
}

function records(db, taskId) {
  const result = {};
  for (const table of tables) {
    result[table] = db.prepare(`SELECT * FROM ${table} WHERE ${table === 'research_tasks' ? 'id' : 'task_id'}=? ORDER BY rowid`).all(taskId);
  }
  return result;
}

function recoveryHash(db, taskId) {
  const rows = records(db, taskId);
  // Receiving a preserved final report or hiding a completed task does not
  // change its immutable research payload. These normal actions must not strand
  // a cleanup that has already committed; all execution/content state remains fenced.
  delete rows.research_deliveries;
  delete rows.research_task_archives;
  return hash(JSON.stringify(rows));
}

function fileInfo(root, path, expectedHash) {
  const stat = inspect(join(root, path));
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2_000_000) fail('研究文件不是独立常规文件或超过容量。');
  const sha256 = hash(readFileSync(join(root, path)));
  if (sha256 !== expectedHash) fail('研究文件哈希与数据库不一致。');
  return { path, sha256, bytes: stat.size };
}

function timestamp(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail('研究保留时间无效。');
  return time;
}

function buildPlan(db, root, identity, now) {
  const createdAt = now.toISOString(), cutoff = now.getTime() - 30 * DAY;
  const candidates = [], skipped = [];
  const done = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)
    ? db.prepare(`SELECT plan_json,status FROM ${TABLE}`).all().flatMap(row => JSON.parse(row.plan_json).candidates.map(c => [c.taskId, row.status])) : [];
  const cleaned = new Map(done);
  for (const task of db.prepare('SELECT * FROM research_tasks ORDER BY id').all()) {
    const skip = reason => skipped.push({ taskId: task.id, reason });
    if (!/^R[0-9a-f]{32}$/.test(task.id)) { skip('invalid_task_id'); continue; }
    if (cleaned.has(task.id)) { skip(cleaned.get(task.id) === 'done' ? 'already_cleaned' : 'cleanup_pending'); continue; }
    if (task.status !== 'completed') { skip('unfinished_protected'); continue; }
    const rows = records(db, task.id);
    if (rows.research_workflow_plans.length !== 1) { skip('legacy_without_fixed_plan_protected'); continue; }
    if (rows.research_workflow_cycles.some(r => r.status === 'running') || rows.research_collection_cycles.some(r => r.status === 'running')
      || rows.research_attempts.some(r => r.status === 'running' || r.status === 'queued')
      || rows.research_deliveries.some(r => r.status === 'sending')) { skip('active_work_protected'); continue; }
    let eligibleSince;
    try {
      const completed = rows.research_attempts.find(r => r.attempt === task.attempt && r.status === 'completed');
      if (!completed) throw new Error('missing completed attempt');
      eligibleSince = new Date(Math.max(timestamp(task.updated_at), timestamp(completed.updated_at),
        ...rows.research_task_archives.map(r => timestamp(r.created_at)))).toISOString();
    } catch { skip('invalid_completion_time'); continue; }
    if (Date.parse(eligibleSince) > cutoff) { skip('retention_30_days'); continue; }
    try {
      const reportRows = rows.research_reports;
      if (!reportRows.length || !reportRows.some(r => r.version === task.latest_version && r.status === 'completed')) throw new Error('missing final report');
      const protectedFiles = [];
      for (const report of reportRows) {
        if (!Number.isSafeInteger(report.version) || report.version < 1) throw new Error('invalid report version');
        for (const ext of ['md','txt']) protectedFiles.push(fileInfo(root, `research/${task.id}/${report.version}.${ext}`, report.content_hash));
      }
      const sections = rows.research_workflow_sections;
      const plan = JSON.parse(rows.research_workflow_plans[0].plan_json);
      if (!Array.isArray(plan.sections) || plan.sections.length !== sections.length || !sections.length
        || plan.sections.some(s => !sections.some(r => r.section_id === s.id))) throw new Error('invalid sections');
      const files = [];
      for (const section of sections) {
        if (!/^s[1-8]$/.test(section.section_id) || section.version < 1) throw new Error('invalid section');
        const versions = rows.research_workflow_versions.filter(v => v.section_id === section.section_id);
        if (!versions.some(v => v.version === section.version)) throw new Error('missing current version');
        for (const version of versions) {
          if (!Number.isSafeInteger(version.version) || version.version < 1) throw new Error('invalid version');
          const file = fileInfo(root, `research/${task.id}/sections/${section.section_id}/${version.version}.md`, version.content_hash);
          (version.version === section.version ? protectedFiles : files).push(file);
        }
      }
      const databasePayloadBytes = rows.research_evidence.reduce((n, r) => n + Buffer.byteLength(r.evidence_json), 0)
        + rows.research_workflow_cycles.reduce((n, r) => n + Buffer.byteLength(r.input_json), 0)
        + rows.research_collection_cycles.reduce((n, r) => n + Buffer.byteLength(r.input_json) + Buffer.byteLength(r.result_json ?? ''), 0);
      candidates.push({ taskId: task.id, eligibleSince, rowsHash: hash(JSON.stringify(rows)), files, protectedFiles,
        evidenceCount: rows.research_evidence.length,
        snapshotCount: rows.research_workflow_cycles.length + rows.research_collection_cycles.length,
        databasePayloadBytes, fileBytes: files.reduce((n, f) => n + f.bytes, 0) });
    } catch { skip('missing_or_unsafe_artifacts'); }
  }
  return { version: 1, dataDir: root, database: identity, createdAt, retainDays: 30, candidates, skipped };
}

/** Read-only: no application Store initialization, schema migration, or audit writes. */
export function previewResearchCleanup(dataDir, { now = new Date() } = {}) {
  const { db, root, identity } = openDatabase(dataDir, true);
  try {
    db.exec('BEGIN');
    const plan = buildPlan(db, root, identity, now);
    db.exec('COMMIT');
    return plan;
  } finally { db.close(); }
}

function tombstone(value, cleanupId) {
  return JSON.stringify({ retained: false, cleanupId, sha256: hash(value), bytes: Buffer.byteLength(value) });
}

function validatePendingFiles(root, plan, allowMissing) {
  for (const candidate of plan.candidates) {
    if (!/^R[0-9a-f]{32}$/.test(candidate.taskId)) fail('清理任务编号无效。');
    for (const file of candidate.protectedFiles) fileInfo(root, file.path, file.sha256);
    for (const file of candidate.files) {
      const prefix = `research/${candidate.taskId}/sections/`;
      if (!file.path.startsWith(prefix) || !/^s[1-8]\/[1-9][0-9]*\.md$/.test(file.path.slice(prefix.length))) fail('清理文件路径越界。');
      if (!inspect(join(root, file.path), allowMissing)) continue;
      fileInfo(root, file.path, file.sha256);
    }
  }
}

/** Local maintenance only. Run against a reviewed preview; never called by the bot. */
export function applyResearchCleanup(dataDir, plan, { now = new Date(), afterCommit } = {}) {
  const { db, root, identity } = openDatabase(dataDir, false);
  try {
    if (!plan || typeof plan !== 'object') fail('清理计划无效。');
    const planJson = JSON.stringify(plan), cleanupId = hash(planJson);
    if (plan?.version !== 1 || plan.retainDays !== 30 || plan.dataDir !== root || JSON.stringify(plan.database) !== JSON.stringify(identity)) fail('清理计划与数据目录不匹配。');
    const generated = timestamp(plan.createdAt);
    if (generated > now.getTime()) fail('不能执行未来的清理计划。');
    db.exec('BEGIN IMMEDIATE');
    try {
      const hasJournal = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
      let run = hasJournal ? db.prepare(`SELECT * FROM ${TABLE} WHERE id=?`).get(cleanupId) : undefined;
      if (!run) {
        if (now.getTime() - generated > DAY) fail('清理预览已超过24小时，请重新预览。');
        const actual = buildPlan(db, root, identity, new Date(generated));
        if (JSON.stringify(actual) !== planJson) fail('清理预览已过期或被修改，未清理任何数据。');
        if (!actual.candidates.length) { db.exec('ROLLBACK'); return { cleanupId, status: 'empty', tasks: 0 }; }
        validatePendingFiles(root, actual, false);
        // This table belongs to the maintenance tool, not the application schema.
        // Its creation and payload replacement are in the same main-db transaction.
        db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
          id TEXT PRIMARY KEY, policy_version INTEGER NOT NULL CHECK(policy_version=1),
          plan_json TEXT NOT NULL, post_hashes_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','done')), created_at TEXT NOT NULL, completed_at TEXT);`);
        for (const candidate of actual.candidates) {
          const id = candidate.taskId;
          for (const row of db.prepare('SELECT * FROM research_evidence WHERE task_id=?').all(id)) {
            db.prepare('UPDATE research_evidence SET evidence_json=? WHERE task_id=? AND attempt=? AND ordinal=?')
              .run(tombstone(row.evidence_json, cleanupId), id, row.attempt, row.ordinal);
          }
          for (const table of ['research_workflow_cycles','research_collection_cycles']) {
            for (const row of db.prepare(`SELECT * FROM ${table} WHERE task_id=?`).all(id)) {
              db.prepare(`UPDATE ${table} SET input_json=? WHERE task_id=? AND cycle=?`).run(tombstone(row.input_json, cleanupId), id, row.cycle);
              if (table === 'research_collection_cycles' && row.result_json !== null) {
                db.prepare(`UPDATE ${table} SET result_json=? WHERE task_id=? AND cycle=?`).run(tombstone(row.result_json, cleanupId), id, row.cycle);
              }
            }
          }
        }
        const postHashes = Object.fromEntries(actual.candidates.map(c => [c.taskId, recoveryHash(db, c.taskId)]));
        db.prepare(`INSERT INTO ${TABLE} VALUES(?,1,?,?,'pending',?,NULL)`).run(cleanupId, planJson, JSON.stringify(postHashes), now.toISOString());
        run = { plan_json: planJson, post_hashes_json: JSON.stringify(postHashes), status: 'pending' };
      } else {
        if (run.policy_version !== 1 || run.plan_json !== planJson) fail('清理审计协议不一致。');
        if (run.status === 'done') { db.exec('COMMIT'); return { cleanupId, status: 'done', tasks: plan.candidates.length, repeated: true }; }
        const postHashes = JSON.parse(run.post_hashes_json);
        for (const candidate of plan.candidates) {
          if (postHashes[candidate.taskId] !== recoveryHash(db, candidate.taskId)) fail('待清理任务状态已变化，保留文件待检查。');
        }
        validatePendingFiles(root, plan, true);
      }
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    // After commit, a crash can only leave extra files. Replaying this exact
    // persisted plan is idempotent; a new preview never guesses orphan files.
    afterCommit?.();
    db.exec('BEGIN IMMEDIATE');
    try {
      const run = db.prepare(`SELECT * FROM ${TABLE} WHERE id=?`).get(cleanupId);
      for (const candidate of plan.candidates) {
        if (JSON.parse(run.post_hashes_json)[candidate.taskId] !== recoveryHash(db, candidate.taskId)) fail('清理提交后任务已变化。');
      }
      validatePendingFiles(root, plan, true);
      for (const candidate of plan.candidates) for (const file of candidate.files) {
        const path = join(root, file.path);
        if (!inspect(path, true)) continue;
        fileInfo(root, file.path, file.sha256);
        unlinkSync(path);
        if (process.platform !== 'win32') { const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
      }
      db.prepare(`UPDATE ${TABLE} SET status='done',completed_at=? WHERE id=?`).run(now.toISOString(), cleanupId);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    return { cleanupId, status: 'done', tasks: plan.candidates.length };
  } finally { db.close(); }
}

/** Optional scheduled entry. Merely installing the default preview unit never calls it. */
export function runResearchCleanup(dataDir, { now = new Date() } = {}) {
  const { db } = openDatabase(dataDir, true);
  let pending;
  try {
    pending = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)
      ? db.prepare(`SELECT plan_json FROM ${TABLE} WHERE status='pending' ORDER BY created_at,id`).all().map(row => JSON.parse(row.plan_json)) : [];
  } finally { db.close(); }
  const resumed = pending.map(plan => applyResearchCleanup(dataDir, plan, { now }));
  const plan = previewResearchCleanup(dataDir, { now });
  return { resumed, result: applyResearchCleanup(dataDir, plan, { now }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, dataDir, planFile, ...extra] = process.argv.slice(2);
    if (!dataDir || extra.length || !['preview','apply','run'].includes(command) || (command === 'preview' && planFile)
      || (command === 'apply' && !planFile) || (command === 'run' && planFile !== '--apply')) {
      fail('用法：preview <数据目录>；apply <数据目录> <已审核的预览JSON>；run <数据目录> --apply。只有明确apply才删除，不会连接模型。');
    }
    const result = command === 'preview' ? previewResearchCleanup(dataDir)
      : command === 'run' ? runResearchCleanup(dataDir)
      : applyResearchCleanup(dataDir, JSON.parse(readFileSync(planFile, 'utf8').replace(/^\uFEFF/, '')));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) { process.stderr.write(`研究清理未完成：${error.message}\n`); process.exitCode = 1; }
}
