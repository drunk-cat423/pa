import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryError } from './memory-types.js';
import { assembleResearchReport } from './research-workflow.js';
import type { ResearchCycleInput, ResearchPlan, ResearchReviewInput, ResearchSection, ResearchSectionInput, ResearchWorkflow } from './research-workflow-types.js';

export function migrateResearchWorkflow(db: DatabaseSync): void {
  db.exec(`CREATE TABLE research_workflow_plans (
    task_id TEXT PRIMARY KEY REFERENCES research_tasks(id), attempt INTEGER NOT NULL, cycle INTEGER NOT NULL,
    plan_json TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(task_id,attempt) REFERENCES research_attempts(task_id,attempt));
  CREATE TABLE research_workflow_cycles (
    task_id TEXT NOT NULL REFERENCES research_tasks(id), cycle INTEGER NOT NULL CHECK(cycle>0), attempt INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('plan','write','review')), section_id TEXT, expected_version INTEGER,
    input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','unknown','interrupted')),
    reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_id,cycle),
    FOREIGN KEY(task_id,attempt) REFERENCES research_attempts(task_id,attempt));
  CREATE UNIQUE INDEX research_workflow_one_cycle ON research_workflow_cycles(task_id) WHERE status='running';
  CREATE TABLE research_workflow_sections (
    task_id TEXT NOT NULL REFERENCES research_tasks(id), section_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
    status TEXT NOT NULL CHECK(status IN ('pending','draft','written','approved','needs_revision','blocked')),
    review_reason TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(task_id,section_id));
  CREATE TABLE research_workflow_versions (
    task_id TEXT NOT NULL, section_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
    attempt INTEGER NOT NULL, cycle INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('append','replace')),
    status TEXT NOT NULL CHECK(status IN ('draft','written','blocked')), summary TEXT NOT NULL,
    sources_json TEXT NOT NULL, gaps_json TEXT NOT NULL, content_hash TEXT NOT NULL, content_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(task_id,section_id,version), UNIQUE(task_id,cycle),
    FOREIGN KEY(task_id,section_id) REFERENCES research_workflow_sections(task_id,section_id),
    FOREIGN KEY(task_id,cycle) REFERENCES research_workflow_cycles(task_id,cycle));
  CREATE TABLE research_workflow_reviews (
    task_id TEXT NOT NULL, cycle INTEGER NOT NULL, section_id TEXT NOT NULL, version INTEGER NOT NULL,
    attempt INTEGER NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('pass','revise','blocked')),
    reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,cycle),
    FOREIGN KEY(task_id,section_id,version) REFERENCES research_workflow_versions(task_id,section_id,version),
    FOREIGN KEY(task_id,cycle) REFERENCES research_workflow_cycles(task_id,cycle));`);
}

const now = () => new Date().toISOString();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function bounded(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || [...value].length > max) throw new MemoryError(`${name}无效或过长。`);
  return value.trim();
}
function taskId(value: string): void {
  if (typeof value !== 'string' || !/^R[0-9a-f]{32}$/.test(value)) throw new MemoryError('研究编号无效。');
}
function sectionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^s[1-8]$/.test(value)) throw new MemoryError('研究章节编号无效。');
}
function version(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) throw new MemoryError('研究章节版本无效。');
}
function serialized(value: unknown, name: string, max: number): string {
  let result: string | undefined;
  try { result = JSON.stringify(value); } catch { throw new MemoryError(`${name}无法序列化。`); }
  if (result === undefined || Buffer.byteLength(result) > max) throw new MemoryError(`${name}无效或过长。`);
  return result;
}

/** Fixed call inputs, immutable full chapter versions and review history survive attempts. */
export class ResearchWorkflowStore {
  private readonly root: string;
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T, dataDir: string) {
    this.root = join(resolve(dataDir), 'research');
  }

  load(id: string): ResearchWorkflow {
    taskId(id);
    const row = this.db.prepare('SELECT plan_json FROM research_workflow_plans WHERE task_id=?').get(id);
    const nextCycle = Number(this.db.prepare('SELECT coalesce(max(cycle),0)+1 AS cycle FROM research_workflow_cycles WHERE task_id=?').get(id)?.cycle);
    if (!row) return { sections: [], nextCycle };
    const plan = JSON.parse(String(row.plan_json)) as ResearchPlan;
    const sections: ResearchSection[] = plan.sections.map(section => {
      const current = this.db.prepare(`SELECT s.*,v.summary,v.sources_json,v.gaps_json,v.content_hash FROM research_workflow_sections s
        LEFT JOIN research_workflow_versions v ON v.task_id=s.task_id AND v.section_id=s.section_id AND v.version=s.version
        WHERE s.task_id=? AND s.section_id=?`).get(id,section.id);
      if (!current) throw new Error('研究计划章节记录缺失。');
      let markdown = '';
      if (Number(current.version) > 0) {
        const bytes = this.readFile(id,section.id,Number(current.version));
        if (hash(bytes) !== current.content_hash) throw new Error('研究章节校验失败，保留文件供检查。');
        markdown = bytes.toString('utf8');
      }
      return { ...section,version:Number(current.version),status:current.status as ResearchSection['status'],markdown,
        summary:String(current.summary ?? ''),sources:JSON.parse(String(current.sources_json ?? '[]')) as string[],
        gaps:JSON.parse(String(current.gaps_json ?? '[]')) as string[],
        ...(current.review_reason == null ? {} : {reviewReason:String(current.review_reason)}) };
    });
    return { plan,sections,nextCycle };
  }

  begin(id: string, attempt: number, input: ResearchCycleInput): number {
    const inputJson = serialized(input.input,'研究周期输入',2_000_000);
    return this.transaction(() => {
      this.running(id,attempt);
      if (!['plan','write','review'].includes(input.phase)) throw new MemoryError('研究周期阶段无效。');
      const workflow = this.load(id);
      if (this.db.prepare("SELECT 1 FROM research_workflow_cycles WHERE task_id=? AND status='running'").get(id)) throw new MemoryError('研究周期尚未结束，拒绝并发调用。');
      if (input.phase === 'plan') {
        if (workflow.plan || input.sectionId !== undefined || input.expectedVersion !== undefined) throw new MemoryError('研究计划已固定或周期参数无效。');
      } else {
        sectionId(input.sectionId); version(input.expectedVersion);
        const section = workflow.sections.find(item => item.id === input.sectionId);
        if (!section || section.version !== input.expectedVersion) throw new MemoryError('研究章节版本已改变。');
        if (input.phase === 'review' ? section.status !== 'written' : !['pending','draft','needs_revision','blocked'].includes(section.status))
          throw new MemoryError('研究章节状态不允许本阶段操作。');
      }
      const at = now(), cycle = workflow.nextCycle;
      this.db.prepare(`INSERT INTO research_workflow_cycles(task_id,cycle,attempt,phase,section_id,expected_version,input_json,input_hash,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'running',?,?)`).run(id,cycle,attempt,input.phase,input.sectionId ?? null,input.expectedVersion ?? null,inputJson,hash(inputJson),at,at);
      return cycle;
    });
  }

  savePlan(id: string, attempt: number, cycle: number, input: ResearchPlan): void {
    if (!input || input.version !== 1 || !Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > 8) throw new MemoryError('研究计划须包含1至8个章节。');
    const plan: ResearchPlan = { version:1,sections:input.sections.map((item,index) => {
      if (!item || item.id !== `s${index+1}`) throw new MemoryError('研究章节编号须从s1连续排列。');
      return { id:item.id,title:bounded(item.title,'章节标题',160),objective:bounded(item.objective,'章节目标',3000),acceptance:bounded(item.acceptance,'章节验收要求',3000) };
    }) };
    const json = serialized(plan,'研究计划',80_000);
    this.transaction(() => {
      this.cycle(id,attempt,cycle,'plan');
      if (this.db.prepare('SELECT 1 FROM research_workflow_plans WHERE task_id=?').get(id)) throw new MemoryError('研究计划已固定，拒绝覆盖。');
      const at = now();
      this.db.prepare('INSERT INTO research_workflow_plans VALUES(?,?,?,?,?)').run(id,attempt,cycle,json,at);
      for (const item of plan.sections) this.db.prepare("INSERT INTO research_workflow_sections VALUES(?,?,0,'pending',NULL,?)").run(id,item.id,at);
      this.succeeded(id,cycle);
    });
  }

  saveSection(id: string, attempt: number, cycle: number, input: ResearchSectionInput): void {
    sectionId(input.sectionId); version(input.expectedVersion);
    if (!['append','replace'].includes(input.mode) || !['draft','written','blocked'].includes(input.status)) throw new MemoryError('研究章节保存参数无效。');
    const fragment = bounded(input.markdown,'章节正文',100_000,input.status === 'blocked');
    const summary = bounded(input.summary,'章节摘要',4000,true);
    if (!Array.isArray(input.sources) || input.sources.length > 100 || !Array.isArray(input.gaps) || input.gaps.length > 30) throw new MemoryError('章节来源或缺口过多。');
    const sources = [...new Set(input.sources.map(value => {
      const source = bounded(value,'章节来源',2048); let url: URL;
      try { url = new URL(source); } catch { throw new MemoryError('章节来源链接无效。'); }
      if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new MemoryError('章节来源仅支持无凭据的HTTP/HTTPS。');
      return source;
    }))];
    const gaps = input.gaps.map(value => bounded(value,'章节缺口',1000));
    serialized({summary,sources,gaps},'章节元数据',40_000);
    this.transaction(() => {
      this.cycle(id,attempt,cycle,'write',input.sectionId,input.expectedVersion);
      const workflow = this.load(id), current = workflow.sections.find(item => item.id === input.sectionId);
      if (!current || current.version !== input.expectedVersion || !['pending','draft','needs_revision','blocked'].includes(current.status)) throw new MemoryError('研究章节版本或状态已改变。');
      if (input.mode === 'append' && !['pending','draft'].includes(current.status)) throw new MemoryError('仅待写或续写章节允许追加正文。');
      const markdown = input.mode === 'append' && current.markdown ? `${current.markdown}\n\n${fragment}`.trimEnd() : fragment;
      const bytes = Buffer.byteLength(markdown);
      // Reserve room for report headings, source lists and metadata within the
      // existing report/read limit of 200,000 Unicode code points.
      const totalPoints = workflow.sections.reduce((total,item) => total + [...(item.id === input.sectionId ? markdown : item.markdown)].length,0);
      if (bytes > 100_000 || totalPoints > 180_000 || workflow.sections.reduce((total,item) => total + (item.id === input.sectionId ? bytes : Buffer.byteLength(item.markdown)),0) > 400_000)
        throw new MemoryError('研究章节或任务正文已达容量上限。');
      const task = this.db.prepare("SELECT title FROM research_tasks WHERE id=? AND attempt=? AND status='running'").get(id,attempt);
      if (!task) throw new MemoryError('研究任务状态或执行批次已改变，拒绝迟到写入。');
      // Validate the exact report renderer before creating a version file. Its
      // longest status label and a full 2,000-character reason reserve space for
      // later reviews and partial publication without changing chapter content.
      assembleResearchReport({title:String(task.title)}, {...workflow,sections:workflow.sections.map(section => ({
        ...section,...(section.id === input.sectionId ? {markdown,summary,sources,gaps} : {}),status:'draft',
      }))},'partial','🙂'.repeat(2000));
      this.artifactPath(id,input.sectionId,1);
      const directory = dirname(this.artifactPath(id,input.sectionId,1));
      const orphanVersions = existsSync(directory) ? readdirSync(directory).flatMap(name => /^(\d+)\.md$/.test(name) ? [Number(name.slice(0,-3))] : []) : [];
      const next = Math.max(Number(this.db.prepare('SELECT coalesce(max(version),0) AS version FROM research_workflow_versions WHERE task_id=? AND section_id=?').get(id,input.sectionId)?.version),...orphanVersions)+1;
      version(next);
      this.saveFile(id,input.sectionId,next,Buffer.from(markdown));
      const at = now();
      this.db.prepare('INSERT INTO research_workflow_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,input.sectionId,next,attempt,cycle,input.mode,input.status,summary,JSON.stringify(sources),JSON.stringify(gaps),hash(markdown),bytes,at);
      const changed = this.db.prepare('UPDATE research_workflow_sections SET version=?,status=?,review_reason=NULL,updated_at=? WHERE task_id=? AND section_id=? AND version=?')
        .run(next,input.status,at,id,input.sectionId,input.expectedVersion);
      if (Number(changed.changes) !== 1) throw new MemoryError('研究章节版本已改变，拒绝覆盖。');
      this.succeeded(id,cycle);
    });
  }

  saveReview(id: string, attempt: number, cycle: number, input: ResearchReviewInput): void {
    sectionId(input.sectionId); version(input.expectedVersion);
    if (!['pass','revise','blocked'].includes(input.verdict)) throw new MemoryError('研究章节评审结论无效。');
    const reason = bounded(input.reason,'章节评审说明',4000);
    this.transaction(() => {
      this.cycle(id,attempt,cycle,'review',input.sectionId,input.expectedVersion);
      const status = {pass:'approved',revise:'needs_revision',blocked:'blocked'}[input.verdict], at = now();
      const changed = this.db.prepare("UPDATE research_workflow_sections SET status=?,review_reason=?,updated_at=? WHERE task_id=? AND section_id=? AND version=? AND status='written'")
        .run(status,reason,at,id,input.sectionId,input.expectedVersion);
      if (Number(changed.changes) !== 1) throw new MemoryError('评审对应章节版本或状态已改变。');
      this.db.prepare('INSERT INTO research_workflow_reviews VALUES(?,?,?,?,?,?,?,?)').run(id,cycle,input.sectionId,input.expectedVersion,attempt,input.verdict,reason,at);
      this.succeeded(id,cycle);
    });
  }

  failCycle(id: string, attempt: number, cycle: number, reason: string, unknown = false): void {
    const normalized = bounded(reason,'研究周期错误',4000);
    if (typeof unknown !== 'boolean') throw new MemoryError('研究周期未知状态无效。');
    this.transaction(() => {
      this.cycle(id,attempt,cycle);
      this.db.prepare('UPDATE research_workflow_cycles SET status=?,reason=?,updated_at=? WHERE task_id=? AND cycle=?')
        .run(unknown ? 'unknown' : 'failed',normalized,now(),id,cycle);
    });
  }

  interrupt(id: string, attempt: number, reason: string): void {
    this.db.prepare("UPDATE research_workflow_cycles SET status='interrupted',reason=?,updated_at=? WHERE task_id=? AND attempt=? AND status='running'").run(reason,now(),id,attempt);
  }

  assertComplete(id: string): void {
    const workflow = this.load(id);
    if (!workflow.plan || workflow.sections.some(section => section.status !== 'approved' || !section.markdown.trim())) throw new MemoryError('研究计划尚有未通过审查的章节，不能完成归档。');
  }

  private running(id: string, attempt: number): void {
    taskId(id);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || !this.db.prepare(`SELECT 1 FROM research_tasks t JOIN research_attempts a ON a.task_id=t.id AND a.attempt=t.attempt
      WHERE t.id=? AND t.attempt=? AND t.status='running' AND a.status='running'`).get(id,attempt)) throw new MemoryError('研究任务状态或执行批次已改变，拒绝迟到写入。');
  }

  private cycle(id: string, attempt: number, cycle: number, phase?: string, section?: string, expectedVersion?: number): void {
    this.running(id,attempt);
    if (!Number.isSafeInteger(cycle) || cycle < 1) throw new MemoryError('研究周期编号无效。');
    const row = this.db.prepare('SELECT * FROM research_workflow_cycles WHERE task_id=? AND cycle=? AND attempt=?').get(id,cycle,attempt);
    if (!row || row.status !== 'running' || (phase !== undefined && (row.phase !== phase || (row.section_id ?? undefined) !== section || (row.expected_version ?? undefined) !== expectedVersion)))
      throw new MemoryError('研究周期已结束或固定阶段、章节、版本不匹配。');
    if (hash(String(row.input_json)) !== row.input_hash) throw new Error('研究周期固定输入校验失败。');
  }

  private succeeded(id: string, cycle: number): void {
    this.db.prepare("UPDATE research_workflow_cycles SET status='succeeded',updated_at=? WHERE task_id=? AND cycle=? AND status='running'").run(now(),id,cycle);
  }

  private artifactPath(id: string, section: string, value: number): string {
    taskId(id); sectionId(section); version(value);
    if (value === 0) throw new MemoryError('研究章节文件版本无效。');
    const directories = [this.root,join(this.root,id),join(this.root,id,'sections'),join(this.root,id,'sections',section)];
    for (const directory of directories) {
      if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error('研究章节目录不能是符号链接或文件。');
    }
    return join(directories[3]!,`${value}.md`);
  }

  private saveFile(id: string, section: string, value: number, data: Buffer): void {
    const path = this.artifactPath(id,section,value);
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const handle = openSync(path,'wx',0o600);
    try { writeFileSync(handle,data); fsyncSync(handle); } finally { closeSync(handle); }
    if (hash(this.readFile(id,section,value)) !== hash(data)) throw new Error('研究章节写入后校验失败。');
    if (process.platform !== 'win32') {
      for (const directory of [dirname(path),dirname(dirname(path)),join(this.root,id),this.root,dirname(this.root)]) {
        const directoryHandle = openSync(directory,'r');
        try { fsyncSync(directoryHandle); } finally { closeSync(directoryHandle); }
      }
    }
  }

  private readFile(id: string, section: string, value: number): Buffer {
    const path = this.artifactPath(id,section,value), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) throw new Error('研究章节文件无效或过大。');
    return readFileSync(path);
  }
}
