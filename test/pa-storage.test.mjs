import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBackup, planStorage, pruneStorage } from '../scripts/deployment/pa-storage.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const files = ['data.tar.gz', 'source.tar.gz', 'pa.env', 'pa.service'];
const ids = Array.from({ length: 9 }, (_, i) => (i + 1).toString(16).padStart(40, '0'));

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'pa-storage-'));
  const paths = { snapshots: path.join(base, 'snapshots'), releases: path.join(base, 'releases'), current: path.join(base, 'current'), data: path.join(base, 'data') };
  for (const dir of Object.values(paths).filter((p) => p !== paths.current)) await mkdir(dir, { recursive: true });
  for (let i = 0; i < ids.length; i++) await mkdir(path.join(paths.releases, ids[i]));
  await symlink(path.join(paths.releases, ids[0]), paths.current, 'junction');
  for (let i = 0; i < ids.length; i++) {
    const when = new Date(1_700_000_000_000 + i * 60_000);
    await utimes(path.join(paths.releases, ids[i]), when, when);
  }
  const probe = {
    async health() { return { activeState: 'active', subState: 'running', mainPid: 4321 }; },
    async pidRunning(pid) { return pid === 4321; },
    async cwd(pid) { assert.equal(pid, 4321); return await import('node:fs/promises').then((f) => f.realpath(paths.current)); },
    async pids() { return []; },
  };
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, paths, probe };
}

async function snapshot(paths, i, checkpoint = null, corrupt = false) {
  const name = `${i}-${ids[i % ids.length]}`;
  const dir = path.join(paths.snapshots, name);
  await mkdir(dir);
  const hashes = {};
  for (const [n, f] of files.entries()) {
    const content = `${name}:${f}`;
    await writeFile(path.join(dir, f), corrupt && n === 0 ? 'damaged' : content);
    hashes[f] = sha(content);
  }
  const completedAt = new Date(1_700_000_000_000 + i * 60_000).toISOString();
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ formatVersion: 1, completedAt, release: ids[0], schemaVersion: 24, checkpoint, files: hashes }));
  return dir;
}

test('retains latest three snapshots plus two checkpoints with overlap deduplicated', async (t) => {
  const { paths, probe } = await fixture(t);
  const dirs = [];
  for (let i = 0; i < 8; i++) dirs.push(await snapshot(paths, i, i === 4 || i === 6 ? `cp-${i}` : null));
  const plan = await planStorage({ paths, probe });
  const keep = new Set(plan.snapshots.keep);
  assert.equal(keep.size, 4);
  assert.ok(keep.has(dirs[7]) && keep.has(dirs[6]) && keep.has(dirs[5]) && keep.has(dirs[4]));
  assert.deepEqual(new Set(plan.snapshots.remove), new Set([dirs[0], dirs[1], dirs[2], dirs[3]]));
});

test('bad retained snapshot aborts prune before any deletion', async (t) => {
  const { paths, probe } = await fixture(t);
  const keep = [];
  for (let i = 0; i < 4; i++) keep.push(await snapshot(paths, i, null, i === 3));
  await assert.rejects(pruneStorage({ paths, probe, apply: true }), /hash verification/);
  const existing = await readdir(paths.snapshots);
  assert.ok(keep.every((p) => existing.includes(path.basename(p))));
});

test('refuses execution when no completed backup can be retained', async (t) => {
  const { paths, probe } = await fixture(t);
  const before = await readdir(paths.releases);
  await assert.rejects(pruneStorage({ paths, probe, apply: true }), /no verified completed snapshot/);
  assert.deepEqual(await readdir(paths.releases), before);
});

test('does not prune unless systemd reports active/running and a valid MainPID', async (t) => {
  const { paths, probe } = await fixture(t);
  const snapshots = [];
  for (let i = 0; i < 4; i++) snapshots.push(await snapshot(paths, i));
  const inactiveProbe = { ...probe, async health() { return { activeState: 'active', subState: 'activating', mainPid: 4321 }; } };
  await assert.rejects(pruneStorage({ paths, probe: inactiveProbe, apply: true }), /active\/running/);
  assert.ok((await readdir(paths.snapshots)).includes(path.basename(snapshots[0])));
  const invalidPidProbe = { ...probe, async health() { return { activeState: 'active', subState: 'running', mainPid: 0 }; } };
  await assert.rejects(pruneStorage({ paths, probe: invalidPidProbe, apply: true }), /active\/running/);
  assert.ok((await readdir(paths.snapshots)).includes(path.basename(snapshots[0])));
});

test('plans protect current, active cwd, and recursive retained-release dependencies', async (t) => {
  const { paths, probe } = await fixture(t);
  const current = path.join(paths.releases, ids[0]);
  const intermediate = path.join(paths.releases, ids[5]);
  const dependency = path.join(paths.releases, ids[6]);
  const transitive = path.join(paths.releases, ids[7]);
  await symlink(transitive, path.join(dependency, 'node_modules'), 'junction');
  await symlink(path.join(dependency, 'node_modules'), path.join(intermediate, 'vendor_modules'), 'junction');
  await symlink(path.join(intermediate, 'vendor_modules'), path.join(current, 'node_modules'), 'junction');
  const liveProbe = { ...probe, async pids() { return [4321]; }, async cwd() { return path.join(paths.releases, ids[4]); } };
  const plan = await planStorage({ paths, probe: liveProbe });
  for (const p of [current, intermediate, dependency, transitive, path.join(paths.releases, ids[4])]) assert.ok(plan.releases.keep.includes(p));
  assert.ok(!plan.releases.remove.includes(current));
});

test('rejects a dependency symlink that escapes the release root', async (t) => {
  const { paths, probe, base } = await fixture(t);
  await symlink(base, path.join(paths.releases, ids[0], 'node_modules'), 'junction');
  await assert.rejects(planStorage({ paths, probe }), /escapes release root/);
});

test('rejects node_modules targets reached through a symlinked ancestor directory', async (t) => {
  const { paths, probe } = await fixture(t);
  const current = path.join(paths.releases, ids[0]);
  const intermediate = path.join(paths.releases, ids[5]);
  const middle = path.join(paths.releases, ids[6]);
  const destination = path.join(paths.releases, ids[7]);
  await mkdir(path.join(middle, 'shared'));
  await mkdir(path.join(destination, 'node_modules'));
  await symlink(path.join(destination, 'node_modules'), path.join(middle, 'shared', 'node_modules'), 'junction');
  await symlink(path.join(middle, 'shared'), path.join(intermediate, 'vendor'), 'junction');
  await symlink(path.join(intermediate, 'vendor', 'node_modules'), path.join(current, 'node_modules'), 'junction');
  await assert.rejects(planStorage({ paths, probe }), /unsupported ancestor/);
});

test('rejects broken and non-directory node_modules link targets', async (t) => {
  const { paths, probe } = await fixture(t);
  const current = path.join(paths.releases, ids[0]);
  const absent = path.join(paths.releases, ids[8], 'missing-dependency');
  const link = path.join(current, 'node_modules');
  await mkdir(absent);
  await symlink(absent, link, 'junction');
  await rm(absent, { recursive: true });
  await assert.rejects(planStorage({ paths, probe }), /broken node_modules link/);
  await rm(link, { recursive: true });
  const fileTarget = path.join(paths.releases, ids[8], 'not-a-directory');
  await writeFile(fileTarget, 'not a directory');
  try { await symlink(fileTarget, link, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return;
    throw error;
  }
  await assert.rejects(planStorage({ paths, probe }), /target is not a directory/);
});

test('rejects node_modules link text containing a parent component before normalization', async (t) => {
  const { paths, probe } = await fixture(t);
  const current = path.join(paths.releases, ids[0]);
  const target = path.join(paths.releases, ids[5], 'node_modules');
  await mkdir(target);
  const raw = `${path.join(paths.releases, ids[5])}${path.sep}unused${path.sep}..${path.sep}node_modules`;
  const link = path.join(current, 'node_modules');
  await symlink(raw, link, 'junction');
  const stored = await (await import('node:fs/promises')).readlink(link);
  if (!stored.split(/[\\/]+/).includes('..')) return;
  await assert.rejects(planStorage({ paths, probe }), /unsupported '\.\.'/);
});

test('rejects a symlink used as a storage root', async (t) => {
  const { paths, probe, base } = await fixture(t);
  const real = path.join(base, 'actual-snapshots');
  await rename(paths.snapshots, real);
  await symlink(real, paths.snapshots, 'junction');
  await assert.rejects(planStorage({ paths, probe }), /root must be a real directory/);
});

test('dry run leaves disk unchanged and apply removes only planned targets', async (t) => {
  const { paths, probe } = await fixture(t);
  const old = await snapshot(paths, 0);
  const newDirs = [];
  for (let i = 1; i <= 4; i++) newDirs.push(await snapshot(paths, i));
  const unrelated = path.join(paths.data, 'conversation.jsonl');
  const baks = ['pa.sqlite.v2.aaaaaaaa-aaaa.bak', 'pa.sqlite.v3.bbbbbbbb-bbbb.bak'];
  await writeFile(unrelated, 'keep');
  await writeFile(path.join(paths.data, baks[0]), 'old');
  await writeFile(path.join(paths.data, baks[1]), 'new');
  const oldTime = new Date(1_600_000_000_000), newTime = new Date(1_700_000_000_000);
  await utimes(path.join(paths.data, baks[0]), oldTime, oldTime);
  await utimes(path.join(paths.data, baks[1]), newTime, newTime);
  await writeFile(path.join(paths.data, 'pa.sqlite.v3-unsupported.bak'), 'keep');
  const plan = await pruneStorage({ paths, probe });
  assert.ok(plan.snapshots.remove.includes(old));
  assert.ok((await readdir(paths.snapshots)).includes(path.basename(old)));
  const result = await pruneStorage({ paths, probe, apply: true });
  assert.ok(result.deleted.includes(old));
  assert.ok(!(await readdir(paths.snapshots)).includes(path.basename(old)));
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  assert.equal(await readFile(path.join(paths.data, baks[1]), 'utf8'), 'new');
  assert.equal(await readFile(path.join(paths.data, 'pa.sqlite.v3-unsupported.bak'), 'utf8'), 'keep');
  assert.ok(newDirs.slice(1).every((d) => result.deleted.includes(d) === false));
});

test('leaves partial, unknown snapshots, nonmatching backups, and release symlinks alone', async (t) => {
  const { paths, probe } = await fixture(t);
  await mkdir(path.join(paths.snapshots, '.partial-interrupted'));
  await mkdir(path.join(paths.snapshots, 'unknown-format'));
  await writeFile(path.join(paths.snapshots, 'unknown-format', 'manifest.json'), '{}');
  await writeFile(path.join(paths.data, 'pa.sqlite.v4-nope.bak'), 'keep');
  const link = path.join(paths.releases, 'f'.repeat(40));
  await symlink(paths.current, link, 'junction');
  const plan = await planStorage({ paths, probe });
  assert.equal(plan.snapshots.remove.length, 0);
  assert.equal(plan.snapshots.ignored.length, 2);
  assert.ok(!plan.releases.remove.includes(link));
  assert.deepEqual(plan.migrationBackups.remove, []);
  const invalid = path.join(paths.snapshots, 'invalid-v1');
  await mkdir(invalid);
  await writeFile(path.join(invalid, 'manifest.json'), JSON.stringify({ formatVersion: 1, completedAt: 'bad' }));
  await assert.rejects(planStorage({ paths, probe }), /invalid snapshot manifest/);
});

test('rejects completed snapshots with missing artifacts or a symlinked manifest', async (t) => {
  const { paths, probe } = await fixture(t);
  const missing = await snapshot(paths, 0);
  await rm(path.join(missing, 'source.tar.gz'));
  await assert.rejects(planStorage({ paths, probe }), /unreadable snapshot artifact/);
  await rm(missing, { recursive: true });
  const linked = await snapshot(paths, 1);
  const manifestPath = path.join(linked, 'manifest.json');
  const targetManifest = path.join(paths.snapshots, 'manifest-target.json');
  await rename(manifestPath, targetManifest);
  try { await symlink(targetManifest, manifestPath, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    await mkdir(manifestPath);
  }
  await assert.rejects(planStorage({ paths, probe }), /invalid snapshot manifest/);
});

test('backup writes an atomic, hashed snapshot only while PA is stopped', async (t) => {
  const { paths, base } = await fixture(t);
  paths.env = path.join(base, 'pa.env');
  paths.unit = path.join(base, 'pa.service');
  await writeFile(paths.env, 'PRIVATE=fixture-secret\n');
  await writeFile(paths.unit, '[Service]\n');
  const db = new DatabaseSync(path.join(paths.data, 'pa.sqlite'));
  db.exec('PRAGMA user_version = 27; CREATE TABLE fixture(value TEXT);');
  db.close();
  let health = { activeState: 'inactive', subState: 'dead', mainPid: 0 };
  const probe = { health: async () => health };
  const created = await createBackup({ paths, probe, checkpoint: 'pre-deploy', now: new Date('2026-10-21T00:30:00.000Z') });
  const manifest = JSON.parse(await readFile(path.join(created.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 27);
  assert.equal(manifest.checkpoint, 'pre-deploy');
  assert.deepEqual(Object.keys(manifest.files).sort(), [...files].sort());
  for (const name of files) assert.equal(manifest.files[name], sha(await readFile(path.join(created.path, name))));
  health = { activeState: 'inactive', subState: 'dead', mainPid: 123 };
  await assert.rejects(createBackup({ paths, probe }), /MainPID=0/);
  health = { activeState: 'active', subState: 'running', mainPid: 0 };
  await assert.rejects(createBackup({ paths, probe }), /inactive or failed/);
  let healthCalls = 0;
  const changingProbe = {
    async health() {
      healthCalls++;
      return healthCalls === 1 ? { activeState: 'inactive', subState: 'dead', mainPid: 0 } : { activeState: 'failed', subState: 'failed', mainPid: 1 };
    },
  };
  await assert.rejects(createBackup({ paths, probe: changingProbe, now: new Date('2026-10-21T00:31:00.000Z') }), /MainPID=0/);
  assert.equal((await readdir(paths.snapshots)).filter((n) => n.startsWith('.partial-')).length, 0);
  assert.equal((await readdir(paths.snapshots)).filter((n) => !n.startsWith('.partial-')).length, 1);
});
