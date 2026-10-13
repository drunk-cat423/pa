// Service startup recovery only: an active or unverifiable owner blocks startup.
import { lstat, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function main() {
  if (process.argv.length !== 2) throw new Error('不接受参数。');
  const root = await realpath(resolve(process.env.PA_DATA_DIR || '.local/pa'));
  const entries = await readdir(root, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (!/^(?:qq-service|[a-f0-9]{64})$/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('锁目录不是普通目录。');
    const directory = join(root, entry.name);
    if (await realpath(directory) !== directory) throw new Error('锁目录存在重定向。');
    const path = join(directory, entry.name === 'qq-service' ? 'service.lock' : 'conversation.lock');
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) throw new Error('锁文件无效。');
    const bytes = await readFile(path);
    const { pid } = JSON.parse(bytes.toString('utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('锁进程标识无效。');
    try { process.kill(pid, 0); throw new Error('锁所属进程仍在运行。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    paths.push({ path, bytes });
  }
  // Validate every lock first; recheck content and owner before removing each file.
  for (const { path, bytes } of paths) {
    if (!(await readFile(path)).equals(bytes)) throw new Error('锁在核查期间发生变化。');
    const { pid } = JSON.parse(bytes.toString('utf8'));
    try { process.kill(pid, 0); throw new Error('锁进程已重新出现。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await unlink(path);
  }
  console.log(`启动锁检查通过，清理 ${paths.length} 个已退出进程的锁。`);
}

main().catch(() => {
  console.error('启动锁检查失败；存在活动进程或无法核实的锁，未启动服务。');
  process.exitCode = 1;
});
