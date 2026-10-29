import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');
const scopeFiles = {
  trending: ['trending-content.test.mjs', 'trending-service.test.mjs'],
  ops: ['ops-status.test.mjs'],
  cache: ['runtime-cache-prefix.test.mjs', 'ops-status.test.mjs'],
  chat: [
    'answer-grounding.test.mjs',
    'context-people.test.mjs',
    'cli-interaction.test.mjs',
    'tool-recovery-e2e.test.mjs',
    'channel-async.test.mjs',
    'channel-admission-atomic.test.mjs',
    'channel-web-tools.test.mjs',
    'research-e2e.test.mjs',
    'reminder-runtime.test.mjs',
    'runtime-cache-prefix.test.mjs',
    'session-integrity.test.mjs',
  ],
  memory: [
    'auto-memory.test.mjs',
    'auto-memory-retrieval.test.mjs',
    'auto-memory-store.test.mjs',
    'context-people.test.mjs',
    'material-components-e2e.test.mjs',
    'material-profile-delta.test.mjs',
    'material-proposal-recovery.test.mjs',
    'memory-context.test.mjs',
    'memory-diagnostics.test.mjs',
    'memory-recovery-e2e.test.mjs',
    'memory-robustness-e2e.test.mjs',
    'memory-store.test.mjs',
    'person-profile-policy.test.mjs',
    'profile-history-storage.test.mjs',
    'rolling-memory-store.test.mjs',
    'self-profile-store.test.mjs',
  ],
  context: [
    'answer-grounding.test.mjs',
    'auto-memory.test.mjs',
    'calibrated-compression.test.mjs',
    'context-people.test.mjs',
    'image-context.test.mjs',
    'memory-context.test.mjs',
    'memory-recovery-e2e.test.mjs',
    'rolling-memory-store.test.mjs',
    'runtime-search-boundaries.test.mjs',
    'runtime-token-calibration.test.mjs',
    'runtime-cache-prefix.test.mjs',
  ],
  delivery: [
    'answer-documents.test.mjs',
    'channel-admission-atomic.test.mjs',
    'channel-async.test.mjs',
    'channel-task-store.test.mjs',
    'delivery-parts.test.mjs',
    'research-e2e.test.mjs',
    'reminder-service.test.mjs',
  ],
  research: [
    'research-archive.test.mjs',
    'research-context.test.mjs',
    'research-e2e.test.mjs',
    'research-materials.test.mjs',
    'research-retention-schema.test.mjs',
    'research-target.test.mjs',
    'research-thinking-runtime.test.mjs',
    'tool-recovery-e2e.test.mjs',
  ],
  web: [
    'channel-web-tools.test.mjs',
    'image-context.test.mjs',
    'research-context.test.mjs',
    'research-e2e.test.mjs',
    'research-materials.test.mjs',
    'research-thinking-runtime.test.mjs',
    'runtime-search.test.mjs',
    'runtime-search-boundaries.test.mjs',
  ],
  storage: [
    'answer-documents.test.mjs',
    'auto-memory-store.test.mjs',
    'channel-admission-atomic.test.mjs',
    'channel-task-store.test.mjs',
    'delivery-parts.test.mjs',
    'legacy-count-retirement.test.mjs',
    'memory-store.test.mjs',
    'profile-history-storage.test.mjs',
    'research-archive.test.mjs',
    'research-retention-schema.test.mjs',
    'rolling-memory-store.test.mjs',
    'self-profile-store.test.mjs',
    'session-integrity.test.mjs',
    'store.test.mjs',
    'work-ledger-migration.test.mjs',
    'work-ledger-store.test.mjs',
  ],
};
const scopes = ['all', ...Object.keys(scopeFiles)];

function help() {
  console.log(`Usage: node scripts/repo-check.mjs [scope ...] [--list]

Run the local TypeScript build and selected repository regression tests.

Scopes: ${scopes.join(', ')}
  all       every test/*.test.mjs file
  --list    show available scopes, selected files and commands without running
  --help    show this help without running`);
}

function fail(message) {
  console.error(`repo-check: ${message}`);
  process.exitCode = 1;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  help();
  process.exit(0);
}

const listOnly = args.includes('--list');
const selectedScopes = args.filter(arg => arg !== '--list');
const unknownArgs = selectedScopes.filter(arg => !scopes.includes(arg));
if (unknownArgs.length) {
  fail(`unknown scope: ${unknownArgs.join(', ')}. Available scopes: ${scopes.join(', ')}`);
  process.exit(1);
}

if (listOnly && selectedScopes.length === 0) {
  console.log(`Available scopes: ${scopes.join(', ')}`);
  for (const scope of scopes) {
    const files = scope === 'all' ? allTests() : scopeFiles[scope];
    console.log(`\n${scope} (${files.length} files)`);
    for (const file of files) console.log(`  test/${file}`);
    console.log(`  node --test --test-concurrency=2 ${files.map(file => `test/${file}`).join(' ')}`);
  }
  process.exit(0);
}

if (selectedScopes.length === 0) {
  fail('choose at least one scope, or use --list to show all scopes');
  process.exit(1);
}

const selectedFiles = [...new Set(selectedScopes.flatMap(scope =>
  scope === 'all' ? allTests() : scopeFiles[scope],
))].sort();

if (listOnly) {
  console.log(`Selected scopes: ${selectedScopes.join(', ')}`);
  console.log('Commands:');
  console.log('  node node_modules/typescript/bin/tsc -p tsconfig.json');
  console.log(`  node --test --test-concurrency=2 ${selectedFiles.map(file => `test/${file}`).join(' ')}`);
  console.log('Files:');
  for (const file of selectedFiles) console.log(`  test/${file}`);
  process.exit(0);
}

const version = process.versions.node.split('.').map(Number);
if (version[0] < 24 || (version[0] === 24 && version[1] < 15)) {
  fail(`Node.js >=24.15.0 is required; found ${process.versions.node}`);
  process.exit(1);
}

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  fail(`local TypeScript compiler not found at ${tsc}`);
  process.exit(1);
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    fail(`could not start ${args[0]}: ${result.error.message}`);
    return result.status ?? 1;
  }
  if (result.signal) {
    fail(`${args[0]} was terminated by signal ${result.signal}`);
    return result.status ?? 1;
  }
  if (result.status !== 0) {
    fail(`${args[0]} exited with status ${result.status ?? 'unknown'}`);
  }
  return result.status ?? 1;
}

console.log(`Scopes: ${selectedScopes.join(', ')}`);
console.log(`Selected regression tests: ${selectedFiles.length} unique files`);
console.log('Stage 1/2: compile TypeScript with the local compiler');
const buildStatus = run([tsc, '-p', join(root, 'tsconfig.json')]);
if (buildStatus !== 0) process.exit(buildStatus);

console.log(`Stage 2/2: run ${selectedFiles.length} selected test files (concurrency 2)`);
const testStatus = run([
  '--test',
  '--test-concurrency=2',
  ...selectedFiles.map(file => join(testDir, file)),
]);
process.exit(testStatus);

function allTests() {
  return readdirSync(testDir)
    .filter(file => file.endsWith('.test.mjs'))
    .sort();
}
