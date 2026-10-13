import { join } from 'node:path';
import { readDataDir } from './config.js';
import { ConversationStore } from './store.js';

function main(): void {
  const [action, id, ...extra] = process.argv.slice(2);
  if (extra.length || !['status', 'retry'].includes(action ?? '') || (action === 'retry' ? !id : id !== undefined)) {
    throw new Error('用法：node --env-file-if-exists=.env dist/memory-jobs-cli.js status | retry <jobId>');
  }
  const store = new ConversationStore(join(readDataDir(), 'pa.sqlite'));
  try {
    if (action === 'retry') store.autoMemory.retry(id!);
    console.log(JSON.stringify({ jobs: store.autoMemory.listJobs(),
      ...(action === 'retry' ? { queued: id, note: '已重新排队；启用后台记忆的服务巡检或下次启动时执行。' } : {}) }, null, 2));
  } finally { store.close(); }
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : '记忆任务管理失败。');
  process.exitCode = 1;
}
