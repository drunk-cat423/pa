import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { CodexWorkerConfig } from './codex-worker-runner.js';
import { CodexWorkerStore, type CodexTask } from './codex-worker-store.js';

const DAY = 24 * 60 * 60 * 1000;
export const CODEX_WORKSPACE_BUDGET = 256 * 1024 * 1024;

/** Symlinks such as node_modules are counted without traversing shared storage. */
export function codexStoredBytes(directory: string): number {
  if (!existsSync(directory)) return 0;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  return readdirSync(directory).reduce((total, name) => total + codexStoredBytes(join(directory, name)), stat.size);
}
function removeManaged(directory: string, root: string): void {
  if (!existsSync(directory)) return;
  const child = relative(resolve(root), resolve(directory));
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== resolve(directory)
    || !child || child.startsWith('..' + sep) || child === '..') throw new Error('Codex回收目录被重定向，已保留现场。');
  rmSync(directory, { recursive: true });
}
function deleteSession(config: CodexWorkerConfig, id: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(config.binary, ['delete', id], { cwd: config.home, env: { PATH: process.env.PATH,
      HOME: config.home, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (part: string) => { error = (error + part).slice(0, 2000); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 || error.includes('No active or archived session found')); });
  });
}
export function codexRetirementCandidates(tasks: readonly CodexTask[], now: number): CodexTask[] {
  return tasks.filter((task, index) => index > 0 && !task.reclaimedAt && !['queued', 'running'].includes(task.status)
    && (index >= 10 || now - Date.parse(task.updatedAt) >= 7 * DAY));
}
/** Only no-change/read tasks are retired. Unpublished modifications remain recoverable. */
export async function retainCodexTasks(config: CodexWorkerConfig, store: CodexWorkerStore, now = Date.now()): Promise<void> {
  const latest = store.list(config.owner);
  const resultRoot = join(config.directory, 'results');
  if (!existsSync(resultRoot)) return;
  for (const task of codexRetirementCandidates(latest, now)) {
    const current = store.get(task.id, config.owner);
    // Earlier candidates can await CLI cleanup while a later one is continued.
    if (!current || current.revision !== task.revision || ['queued', 'running'].includes(current.status)) continue;
    const revisions = readdirSync(resultRoot, { withFileTypes: true }).filter(entry =>
      entry.isDirectory() && entry.name.startsWith(task.id + '-'));
    // A read follow-up can still own modifications from a previous fix revision.
    // Keep every task with any nonempty or missing baseline diff, regardless of mode.
    if (task.baseCommit && (!revisions.length || revisions.some(revision => {
      const patch = join(resultRoot, revision.name, 'diff.txt');
      return !existsSync(patch) || lstatSync(patch).isSymbolicLink() || readFileSync(patch, 'utf8').length > 0;
    }))) continue;
    // Fence continuation synchronously, before waiting for Codex session deletion.
    if (!task.archivedAt) store.markArchived(task.id, new Date(now).toISOString());
    if (task.threadId && (!/^[a-f0-9-]{36}$/.test(task.threadId) || !await deleteSession(config, task.threadId))) continue;
    removeManaged(join(config.directory, 'workspaces', task.id), config.directory);
    for (const revision of revisions) {
      const result = join(resultRoot, revision.name);
      const events = join(result, 'events.jsonl');
      if (existsSync(events)) {
        if (lstatSync(events).isSymbolicLink()) throw new Error('Codex事件文件被重定向。');
        rmSync(events);
      }
      // Compact text evidence stays available even when original QQ delivery failed.
    }
    store.markReclaimed(task.id, new Date(now).toISOString());
  }
}
