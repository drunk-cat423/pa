import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { collectModelErrors } from './delegation-error-metadata.mjs';

// This projection is readable by the executor. Never pass raw journal output,
// conversation records, route IDs, or free-form status strings through to it.
const directory = '/run/pa-delegation-diagnostics';
const events = [
  'QQ 正在重连', 'QQ Gateway 已恢复', 'QQ Gateway READY', 'ready_waiting_for_mention',
  'accepted', 'sent', 'failed', 'budget_exhausted', 'persistence_failed', 'stopped',
];
const timestamp = new Date().toISOString();
const journal = execFileSync('/usr/bin/journalctl', [
  '-u', 'pa.service', '--since', '24 hours ago', '-n', '300', '--no-pager', '-o', 'json',
  '--grep', '^QQ harness: (' + events.join('|') + ')$',
], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
const lines = [`snapshot ${timestamp}; last 24h; latest 300 matching PA events only`];
for (const line of journal.trim().split('\n').filter(Boolean)) {
  const row = JSON.parse(line);
  const event = events.find(value => row.MESSAGE === 'QQ harness: ' + value);
  if (event && /^\d{15,17}$/.test(row.__REALTIME_TIMESTAMP)) {
    lines.push(`${new Date(Number(row.__REALTIME_TIMESTAMP) / 1000).toISOString()} ${event}`);
  }
}
try {
  const status = JSON.parse(readFileSync('/var/lib/pa/qq-service/status.json', 'utf8'));
  const trending = status.trending ?? {};
  const knownErrors = ['collect_failed','collect_exhausted','generation_unknown','digest_invalid',
    'delivery_uncertain','delivery_rejected','route_unavailable','expired','persistence_failed','internal_error'];
  lines.push(JSON.stringify({ statusUpdatedAt: Number.isFinite(Date.parse(status.updatedAt))
    ? new Date(status.updatedAt).toISOString() : null, trendingFailed: trending.failed === true,
    trendingError: knownErrors.includes(trending.errorCode) ? trending.errorCode : null,
    researchFailed: status.research?.failed === true, remindersFailed: status.reminders?.failed === true }));
} catch { lines.push('PA runtime status unavailable'); }
lines.push(JSON.stringify(collectModelErrors()));
writeFileSync(directory + '/events.next', lines.join('\n') + '\n', { mode: 0o644 });
renameSync(directory + '/events.next', directory + '/events.log');
