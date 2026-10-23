import { join } from 'node:path';
import { readDataDir } from './config.js';
import { ConversationStore } from './store.js';

function main(): void {
  const [action, id, reason, ...extra] = process.argv.slice(2);
  if (extra.length || !['status', 'retry', 'recover', 'defer', 'retire-count'].includes(action ?? '')
    || (action === 'status' ? id !== undefined || reason !== undefined
      : !id || (action === 'defer' || action === 'retire-count' || action==='recover' ? !reason?.trim() || reason.length > 4000 : reason !== undefined))) {
    throw new Error('用法：node --env-file-if-exists=.env dist/memory-jobs-cli.js status | retry <jobId> | recover <jobId> <reason> | defer <jobId> <reason> | retire-count <conversationId> <reason>');
  }
  const store = new ConversationStore(join(readDataDir(), 'pa.sqlite'));
  try {
    if (action === 'retry') store.autoMemory.retry(id!);
    if (action === 'defer') store.autoMemory.defer(id!, reason!);
    const recoveryJob=action==='recover'?store.autoMemory.recover(id!,reason!):undefined;
    const retired = action === 'retire-count' ? store.autoMemory.retireLegacyCountJobs(id!, reason!) : undefined;
    console.log(JSON.stringify({ jobs: store.autoMemory.listJobs(),
      ...(recoveryJob?{queued:recoveryJob,note:'已授权一次独立恢复；原失败现场保留，自动恢复预算不重置。'}:{}),
      ...(action === 'retry' ? { queued: id, note: '已重新排队；启用后台记忆的服务巡检或下次启动时执行。' } : {}),
      ...(action === 'defer' ? { deferred: id, note: '已搁置，未标为完成；原文、输入与进度保留。启用后台整理时，后续队列可产生模型费用。' } : {}),
      ...(retired === undefined ? {} : { retired, conversationId: id, note: '旧 count 执行任务已退役，未标为压缩完成；原文与任务证据保留，交由后续 85% rolling 整理接管。本操作不调用模型、不创建整理批次、不推进检查点。' }) }, null, 2));
  } finally { store.close(); }
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : '记忆任务管理失败。');
  process.exitCode = 1;
}
