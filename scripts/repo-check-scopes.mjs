import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const scopeFiles = {
  delegation: ['codex-service.test.mjs', 'codex-worker.test.mjs', 'delegation-diagnostics.test.mjs', 'publish-inbox.test.mjs', 'publisher-controller.test.mjs'],
  efficiency: ['search-concurrency.test.mjs', 'research-scheduling.test.mjs', 'storage-efficiency.test.mjs', 'context-efficiency.test.mjs'],
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
    'context-efficiency.test.mjs',
    'storage-efficiency.test.mjs',
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
    'research-scheduling.test.mjs',
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
    'search-concurrency.test.mjs',
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
    'storage-efficiency.test.mjs',
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

// Reuse the same scopes as local checks. An unknown source module fails closed
// to all existing regressions; changed/new test files are always included.
const sourceScopes = [
  [/^(runtime|conversation|turn-plan|answer-grounding|context-|config|model)/, ['chat', 'context', 'cache', 'research']],
  [/^(image-|web-|plain-text|markdown-chunks)/, ['web', 'delivery', 'cache']],
  [/^(auto-memory|memory|material-|person-|profile-|self-profile)/, ['memory', 'context', 'storage']],
  [/^research/, ['research']],
  [/^(reminder|work-ledger)/, ['chat', 'delivery', 'storage']],
  [/^trending/, ['trending']],
  [/^codex/, ['delegation', 'cache']],
  [/^(channel-|qq-|harness-policy)/, ['chat', 'delivery', 'storage', 'delegation', 'trending']],
  [/^(store|session-integrity|transcript|diagnostics|logs)/, ['storage', 'chat', 'memory', 'research']],
];

export function selectChangedTests(root, paths) {
  const selectedScopes = new Set(), changedTests = new Set();
  for (const name of paths) {
    if (name.startsWith('src/')) {
      const match = sourceScopes.find(([pattern]) => pattern.test(name.slice(4)));
      for (const scope of match?.[1] ?? ['all']) selectedScopes.add(scope);
    }
    if (name.startsWith('test/')) {
      if (/^test\/[A-Za-z0-9_.-]+\.test\.mjs$/.test(name) && existsSync(join(root, name))) changedTests.add(name.slice(5));
      else selectedScopes.add('all'); // Shared fixtures and removed tests can affect any regression.
    }
  }
  const all = () => readdirSync(join(root, 'test')).filter(name => name.endsWith('.test.mjs'));
  const files = [...new Set([...selectedScopes].flatMap(scope => scope === 'all' ? all() : scopeFiles[scope])
    .concat([...changedTests]))].filter(name => existsSync(join(root, 'test', name))).sort();
  return { scopes: [...selectedScopes].sort(), files };
}
