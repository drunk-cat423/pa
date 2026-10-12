import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export async function acquireConversationLock(dataDir: string, conversationKey: string): Promise<{
  directory: string;
  release(): Promise<void>;
}> {
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const directory = join(canonicalRoot, createHash('sha256').update(conversationKey).digest('hex'));
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  const part = relative(canonicalRoot, await realpath(directory));
  if (!stat.isDirectory() || stat.isSymbolicLink() || part === '..'
    || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error('会话目录越界或使用了符号链接。');
  }
  const lockPath = join(directory, 'conversation.lock');
  let lock: FileHandle;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`此会话已被锁定：${lockPath}。请先关闭使用它的进程；若上次进程崩溃，确认没有活跃进程后手动移除此锁文件。`);
    }
    throw error;
  }
  let releasePromise: Promise<void> | undefined;
  function release(): Promise<void> {
    return releasePromise ??= (async () => {
      try { await lock.close(); } finally { await unlink(lockPath); }
    })();
  }
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    return { directory, release };
  } catch (error) {
    await release();
    throw error;
  }
}
