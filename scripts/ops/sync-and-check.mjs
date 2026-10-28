import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (directory, args) => execFileSync('git', args, {
  cwd: directory, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

/** Only fetch/fast-forward. Never stash, reset, checkout, merge conflicts or push. */
export function syncRepository(directory) {
  const result = { status: 'unknown', fetched: false };
  try {
    result.before = git(directory, ['rev-parse', 'HEAD']);
    result.branch = git(directory, ['branch', '--show-current']);
    result.localChanges = Boolean(git(directory, ['status', '--porcelain']));
    if (!result.branch) return { ...result, status: 'detached_head' };
    let upstream;
    try { upstream = git(directory, ['rev-parse', '--symbolic-full-name', '@{upstream}']); }
    catch { return { ...result, status: 'no_upstream' }; }
    if (!upstream.startsWith('refs/remotes/')) return { ...result, status: 'unsupported_upstream' };
    result.upstream = upstream;
    const remote = git(directory, ['config', '--get', `branch.${result.branch}.remote`]);
    git(directory, ['fetch', '--prune', '--', remote]);
    result.fetched = true;
    result.expectedRelease = git(directory, ['rev-parse', '--verify', upstream]);
    const [ahead, behind] = git(directory, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).split(/\s+/).map(Number);
    Object.assign(result, { ahead, behind });
    if (ahead && behind) result.status = 'diverged';
    else if (!behind) result.status = ahead ? 'local_ahead' : 'up_to_date';
    else if (result.localChanges) result.status = 'blocked_local_changes';
    else {
      git(directory, ['merge', '--ff-only', upstream]);
      result.status = 'updated';
    }
    result.after = git(directory, ['rev-parse', 'HEAD']);
    return result;
  } catch {
    // Git output can contain credential-bearing remotes. Keep it out of reports.
    return { ...result, status: result.fetched ? 'fast_forward_failed' : 'fetch_failed' };
  }
}

export function synchronizationComplete(result) {
  return result.fetched === true
    && ['up_to_date', 'updated', 'local_ahead', 'blocked_local_changes', 'diverged'].includes(result.status)
    && /^[0-9a-f]{40}$/i.test(result.expectedRelease ?? '');
}

function options(args) {
  const parsed = { hours: 24 };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--help') return { help: true };
    if (!['--host', '--hours', '--report'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('unknown or missing option');
    }
    parsed[key.slice(2)] = args[++index];
  }
  parsed.hours = Number(parsed.hours);
  if (!Number.isInteger(parsed.hours) || parsed.hours < 1 || parsed.hours > 168) throw new Error('invalid hours');
  if (!parsed.host) {
    try { parsed.host = JSON.parse(readFileSync(resolve(root, '.local/server-health.json'), 'utf8')).sshHost; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid private host configuration'); }
  }
  // Pass only a literal SSH destination, never options or shell expressions.
  if (typeof parsed.host !== 'string' || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(parsed.host)) {
    throw new Error('provide --host user@server or .local/server-health.json sshHost');
  }
  parsed.report = resolve(root, parsed.report ?? '.local/ops/latest.json');
  return parsed;
}

async function main() {
  let parsed;
  try { parsed = options(process.argv.slice(2)); }
  catch (error) {
    console.error(`sync-and-check: ${error.message}; use --help`);
    process.exitCode = 2; return;
  }
  if (parsed.help) {
    console.log('Usage: node scripts/ops/sync-and-check.mjs [--host user@server] [--hours 1..168] [--report path]\n'
      + 'Fetch and fast-forward the current upstream, then inspect PA over SSH without deployment or model calls.\n'
      + 'Default host: ignored .local/server-health.json {"sshHost":"user@server"}.\n'
      + 'Default report: ignored .local/ops/latest.json. Exit 0=healthy, 1=attention, 2=incomplete/error.');
    return;
  }
  // Use the collector loaded when this reviewed entry point started. A fetch
  // must not replace the code midway through this remote read-only operation.
  const source = readFileSync(new URL('./server-status.mjs', import.meta.url), 'utf8');
  const synchronization = syncRepository(root);
  const report = { generatedAt: new Date().toISOString(), synchronization };
  const remoteArgs = ['--hours', String(parsed.hours)];
  if (/^[0-9a-f]{40}$/i.test(synchronization.expectedRelease ?? '')) {
    remoteArgs.push('--expected-release', synchronization.expectedRelease);
  }
  let raw, remoteExit = 0;
  try {
    raw = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', parsed.host,
      `/opt/node-v24.15.0/bin/node --input-type=module - ${remoteArgs.join(' ')}`], {
      input: source, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    remoteExit = typeof error.status === 'number' ? error.status : 2;
    raw = typeof error.stdout === 'string' ? error.stdout : '';
  }
  try { report.server = JSON.parse(raw); }
  catch { report.server = { ok: false, complete: false, findings: [{ code: 'SSH_OR_PROBE_FAILED', severity: 'error' }] }; }
  report.complete = synchronizationComplete(synchronization)
    && report.server.complete === true && [0, 1].includes(remoteExit);
  report.ok = ['up_to_date', 'updated', 'local_ahead'].includes(synchronization.status)
    && report.server.ok === true && report.server.complete === true && remoteExit === 0;
  mkdirSync(dirname(parsed.report), { recursive: true, mode: 0o700 });
  writeFileSync(parsed.report, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : report.complete ? 1 : 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('sync-and-check: unable to collect or save the report'); process.exitCode = 2; });
}
