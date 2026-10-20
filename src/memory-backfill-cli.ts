import { join } from 'node:path';
import { BackgroundMemory } from './auto-memory.js';
import { readConfig, readDataDir } from './config.js';
import { ConversationStore } from './store.js';

const usage = '用法：memory-backfill-cli.js plan <conversationId> | reserve <conversationId> <reason> | status [runId] | run <runId> [--max-calls <1..1000>]';

async function main(): Promise<void> {
  const [action, id, ...args] = process.argv.slice(2);
  let maxCalls = 128;
  if (action === 'run' && args.length === 2 && args[0] === '--max-calls' && /^\d+$/.test(args[1]!)) maxCalls = Number(args[1]);
  else if (action === 'run' && args.length) throw new Error(usage);
  if (!['plan', 'reserve', 'status', 'run'].includes(action ?? '')
    || (action === 'status' ? args.length : !id)
    || (action === 'plan' && args.length) || (action === 'reserve' && (args.length !== 1 || !args[0]?.trim()))
    || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000) throw new Error(usage);
  const store = new ConversationStore(join(readDataDir(), 'pa.sqlite'));
  try {
    if (action === 'plan') {
      console.log(JSON.stringify(store.autoMemory.planMaterialBackfill(id!), null, 2));
      return;
    }
    if (action === 'reserve') {
      const runId = store.autoMemory.reserveMaterialBackfill(id!, { reason: args[0]! });
      console.log(JSON.stringify({ runId: runId ?? null,
        ...(runId ? { run: store.autoMemory.materialBackfillRun(runId) } : { note: '没有尚未预约的可回填内容。' }) }, null, 2));
      return;
    }
    if (action === 'status') {
      const result = id ? store.autoMemory.materialBackfillRun(id) : store.autoMemory.listMaterialBackfillRuns();
      if (result === undefined) throw new Error('回填任务不存在。');
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const run = store.autoMemory.materialBackfillRun(id!);
    if (!run) throw new Error('回填任务不存在。');
    if (run.status.failed || run.status.deferred || run.status.retired || run.status.isolated) {
      throw new Error('回填包含失败或搁置任务；请先检查日志及进度，再显式处理，不会自动重试。');
    }
    if (run.status.completed === run.jobIds.length) {
      console.log(JSON.stringify({ run, calls: 0, note: '本次回填已经完成，没有发起模型调用。' }, null, 2));
      return;
    }
    // This explicit command permits model calls, without starting QQ or automatic timers.
    const base = readConfig();
    const config = { ...base, memory: { ...base.memory!, enabled: true, maxCalls } };
    const worker = new BackgroundMemory(config, store.autoMemory, run.conversationId, undefined,
      { pipeline: 'materials', jobIds: run.jobIds, separateMaterialSteps: true });
    let interrupted = false;
    const stop = () => { interrupted = true; void worker.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let reportedCompleted = -1;
    const progress = setInterval(() => {
      try {
        const state = store.autoMemory.materialBackfillRun(run.runId)!;
        if (reportedCompleted === state.status.completed) return;
        reportedCompleted = state.status.completed;
        console.log(JSON.stringify({ event: 'progress', runId: run.runId, ...state.status,
          remainingMessages: state.remainingMessages, remainingPending: state.remainingPending, calls: worker.info().calls }));
      } catch { stop(); }
    }, 1000);
    try {
      worker.start();
      await worker.wait(undefined, (maxCalls + run.jobIds.length) * (config.memory.timeoutMs + 10000) + 60000);
      const completed = store.autoMemory.materialBackfillRun(run.runId)!;
      if (interrupted || completed.status.completed !== completed.jobIds.length) throw new Error('回填没有全部完成，保留任务、原文及已有进度。');
      console.log(JSON.stringify({ event: 'completed', run: completed, calls: worker.info().calls }));
    } catch (error) {
      console.log(JSON.stringify({ event: 'stopped', run: store.autoMemory.materialBackfillRun(run.runId),
        calls: worker.info().calls, error: error instanceof Error ? error.message : '回填未完成。' }));
      process.exitCode = interrupted ? 130 : 1;
    } finally {
      clearInterval(progress);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await worker.close();
    }
  } finally { store.close(); }
}

try { await main(); } catch (error) {
  console.error(error instanceof Error ? error.message : '回填管理失败。');
  process.exitCode = 1;
}
