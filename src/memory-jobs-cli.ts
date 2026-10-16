import { join } from 'node:path';
import { readDataDir } from './config.js';
import { ConversationStore } from './store.js';

function main(): void {
  const [action, id, reason, ...extra] = process.argv.slice(2);
  if (extra.length || !['status', 'retry', 'defer'].includes(action ?? '')
    || (action === 'status' ? id !== undefined || reason !== undefined
      : !id || (action === 'defer' ? !reason?.trim() : reason !== undefined))) {
    throw new Error('用法：node --env-file-if-exists=.env dist/memory-jobs-cli.js status | retry <jobId> | defer <jobId> <reason>');
  }
  const store = new ConversationStore(join(readDataDir(), 'pa.sqlite'));
  try {
    if (action === 'retry') store.autoMemory.retry(id!);
    if (action === 'defer') store.autoMemory.defer(id!, reason!);
    console.log(JSON.stringify({ jobs: store.autoMemory.listJobs(),
      ...(action === 'retry' ? { queued: id, note: '已重新排队；启用后台记忆的服务巡检或下次启动时执行。' } : {}),
      ...(action === 'defer' ? { deferred: id, note: '已搁置，未标为完成；原文、输入与进度保留。启用后台整理时，后续队列可产生模型费用。' } : {}) }, null, 2));
  } finally { store.close(); }
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : '记忆任务管理失败。');
  process.exitCode = 1;
}
