import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDataDir } from './config.js';
import { DiagnosticLog, type DiagnosticFilter } from './diagnostics.js';
import { queryDiagnostics, replayDiagnosticCall } from './logs.js';

const help = '用法：pa logs recent | task <完整ID> | job <完整ID> | trace <完整ID> | call <调用ID> [--content] | export <traceID> [--content] | replay <调用ID> --offline';

export function runLogsCli(args: readonly string[], dataDir = readDataDir()): number {
  const [command, id, flag, ...extra] = args;
  if (extra.length || !['recent','task','job','trace','call','export','replay'].includes(command ?? '')) throw new Error(help);
  if (command === 'recent' ? id !== undefined : !id) throw new Error(help);
  if (command === 'replay' ? flag !== '--offline'
    : flag !== undefined && (!['call','export'].includes(command!) || flag !== '--content')) throw new Error(help);
  const log = new DiagnosticLog(dataDir);
  if (command === 'replay') {
    const report = replayDiagnosticCall(log, id!);
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  const filter: DiagnosticFilter = { limit: command === 'recent' ? 30 : 1000 };
  if (command === 'task') filter.taskId = id!;
  if (command === 'job') filter.jobId = id!;
  if (command === 'call') filter.callId = id!;
  if (command === 'trace' || command === 'export') filter.traceId = id!;
  console.log(JSON.stringify(queryDiagnostics(log, filter, flag === '--content'), null, 2));
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = runLogsCli(process.argv.slice(2)); }
  catch { console.error('日志查询或重放失败；请检查参数、证据完整性和本地目录权限。' + help); process.exitCode = 1; }
}
