import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CodexTask {
  id: string;
  requestId: string;
  owner: string;
  revision: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  mode: 'read' | 'fix';
  prompt: string;
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  baseCommit?: string;
  source?: string;
  model: string;
  reasoning: string;
  summary?: string;
  evidence?: string;
  diff?: string;
  memoryPeakBytes?: number;
  archivedAt?: string;
  reclaimedAt?: string;
}
export interface CodexSubmission { requestId: string; owner: string; mode: 'read' | 'fix'; prompt: string; taskId?: string }
interface Ledger { version: 1; tasks: CodexTask[]; requests: Record<string, { id: string; revision: number; status: string; input: string }> }

/** One process owns this ledger. The model's command sandbox cannot access it. */
export class CodexWorkerStore {
  private ledger: Ledger;
  private readonly file: string;
  private failed = false;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Codex state directory cannot be a symlink.');
    this.file = join(directory, 'tasks.json');
    this.ledger = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as Ledger
      : { version: 1, tasks: [], requests: {} };
    if (this.ledger.version !== 1 || !Array.isArray(this.ledger.tasks)) throw new Error('Invalid Codex ledger.');
    let changed = false;
    for (const task of this.ledger.tasks) {
      if (task.status === 'running') {
        task.status = 'interrupted';
        task.summary = '执行器中断。工作目录和已有改动已保留，需要明确续办后才会再次启动 Codex。';
        task.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.save();
  }
  private save(): void {
    if (this.failed) throw new Error('Codex任务存储故障，等待执行器重启核验。');
    const temporary = this.file + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(this.ledger, (key, value: unknown) => {
        if (key === 'evidence' || key === 'diff') return undefined;
        if (key === 'summary' && typeof value === 'string') return value.slice(0, 2000);
        return value;
      }), { mode: 0o600, flush: true });
      renameSync(temporary, this.file);
    } catch (error) { this.failed = true; throw error; }
  }
  list(owner: string, requestId?: string): CodexTask[] {
    if (requestId) return this.ledger.tasks.filter(task => task.owner === owner && task.requestId === requestId);
    const latest = new Map<string, CodexTask>();
    for (const task of this.ledger.tasks) if (task.owner === owner) latest.set(task.id, task);
    return [...latest.values()].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id: string, owner: string, revision?: number): CodexTask | undefined {
    return this.ledger.tasks.findLast(task => task.id === id && task.owner === owner && (revision === undefined || task.revision === revision));
  }
  submit(input: CodexSubmission): { id: string; revision: number; status: string } {
    if (this.failed) throw new Error('Codex任务存储故障，等待执行器重启核验。');
    const previous = this.ledger.requests[input.requestId];
    if (previous) {
      const task = this.get(previous.id, input.owner);
      if (!task || previous.input !== createHash('sha256').update(JSON.stringify(input)).digest('hex')) throw new Error('重复请求的任务内容或归属发生变化。');
      return { id: previous.id, revision: previous.revision, status: previous.status };
    }
    const now = new Date().toISOString();
    let task: CodexTask;
    if (input.taskId) {
      const found = this.get(input.taskId, input.owner);
      if (!found) throw new Error('没有属于你的该 Codex 任务。');
      if (found.archivedAt) throw new Error('该任务的工作目录和会话已按保留规则归档，请新建任务；历史结论仍可查询。');
      if (found.status === 'queued' || found.status === 'running') throw new Error('该任务正在执行，请等本次结果后续办。');
      task = { ...found, requestId: input.requestId, revision: found.revision + 1,
        prompt: input.prompt, mode: input.mode, status: 'queued', updatedAt: now };
      delete task.summary;
      delete task.evidence;
      delete task.diff;
      this.ledger.tasks.push(task);
    } else {
      if (this.ledger.tasks.filter(item => item.status === 'queued' || item.status === 'running').length >= 8) {
        throw new Error('Codex 队列已满，请稍后再派任务。');
      }
      task = { id: randomUUID(), requestId: input.requestId, owner: input.owner, revision: 1, status: 'queued', mode: input.mode,
        prompt: input.prompt, createdAt: now, updatedAt: now, model: 'gpt-6.1-sol', reasoning: 'high' };
      this.ledger.tasks.push(task);
    }
    const receipt = { id: task.id, revision: task.revision, status: task.status };
    this.ledger.requests[input.requestId] = { ...receipt, input: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
    this.save();
    return receipt;
  }
  claim(): CodexTask | undefined {
    if (this.failed) throw new Error('Codex任务存储故障，等待执行器重启核验。');
    const task = this.ledger.tasks.find(item => item.status === 'queued');
    if (!task) return;
    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    this.save();
    return task;
  }
  update(task: CodexTask): void {
    task.updatedAt = new Date().toISOString();
    this.save();
    if (!['queued', 'running'].includes(task.status)) {
      delete task.diff;
      delete task.evidence;
      if (task.summary) task.summary = task.summary.slice(0, 2000);
    }
  }
  markArchived(id: string, at: string): void {
    for (const task of this.ledger.tasks) if (task.id === id) task.archivedAt = at;
    this.save();
  }
  markReclaimed(id: string, at: string): void {
    for (const task of this.ledger.tasks) if (task.id === id) task.reclaimedAt = at;
    this.save();
  }
}
