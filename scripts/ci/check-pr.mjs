import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [base, head] = process.argv.slice(2);
if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha))) {
  console.error('Usage: node scripts/ci/check-pr.mjs <base-sha> <head-sha>');
  process.exit(1);
}

function checkArgs() {
  const diff = execFileSync('git', [
    'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
    `${base}...${head}`, '--',
  ], { cwd: root, encoding: 'utf8' });
  const records = diff.split('\0');
  records.pop();
  const paths = [];
  for (let i = 0; i < records.length; i += 2) {
    const status = records[i];
    const path = records[i + 1];
    if (/^(?:docs\/|(?:AGENTS|README)\.md$)/.test(path)) continue;
    // With rename detection disabled, both paths of a rename are visible as D/A.
    if (!['A', 'M'].includes(status) || !/^(?:src|test)\//.test(path)) {
      return ['all'];
    }
    paths.push(path);
  }
  return ['--changed', ...paths];
}

const result = spawnSync(process.execPath, ['scripts/repo-check.mjs', ...checkArgs()], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
