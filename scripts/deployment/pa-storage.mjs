#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_PATHS = Object.freeze({
  snapshots: '/var/backups/pa/snapshots', releases: '/opt/pa/releases', current: '/opt/pa/current',
  data: '/var/lib/pa', env: '/etc/pa/pa.env', unit: '/etc/systemd/system/pa.service',
  service: 'pa.service', proc: '/proc',
});
const SNAP_FILES = ['data.tar.gz', 'source.tar.gz', 'pa.env', 'pa.service'];
const SHA = /^[0-9a-f]{40}$/;
const BAK = /^pa\.sqlite\.v\d+\.[0-9a-f-]+\.bak$/;

const fail = (message) => { throw new Error(message); };
const exec = (bin, args) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) fail(`${bin} failed`);
  return result.stdout.trim();
};
const execQuiet = (bin, args) => {
  const result = spawnSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error || result.status !== 0) fail(`${bin} failed`);
};
const jsonOut = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const hashFile = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest('hex')));
});
const isRealDir = async (p) => {
  const st = await fs.lstat(p).catch(() => null);
  return !!st && st.isDirectory() && !st.isSymbolicLink();
};
const requireRealRoot = async (p) => {
  const st = await fs.lstat(p).catch(() => null);
  if (!st?.isDirectory() || st.isSymbolicLink()) fail(`root must be a real directory: ${p}`);
  return fs.realpath(p);
};
const basenameSafe = (name) => name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
const directChild = (root, child) => path.dirname(path.resolve(child)) === path.resolve(root);
const isWithin = (root, child) => { const rel = path.relative(path.resolve(root), path.resolve(child)); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
async function assertNoSymlinkAncestors(release, target, linkPath) {
  const relativeParent = path.relative(release, path.dirname(target));
  let current = release;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = await fs.lstat(current).catch(() => fail(`broken node_modules link ancestor: ${linkPath}`));
    if (st.isSymbolicLink() || !st.isDirectory()) fail(`node_modules link has an unsupported ancestor: ${current}`);
  }
}

function validManifest(m) {
  return Number.isFinite(Date.parse(m.completedAt)) && new Date(m.completedAt).toISOString() === m.completedAt &&
    SHA.test(m.release) && Number.isInteger(m.schemaVersion) && m.schemaVersion >= 0 &&
    (m.checkpoint === null || typeof m.checkpoint === 'string') && m.files && Object.keys(m.files).length === SNAP_FILES.length &&
    SNAP_FILES.every((f) => /^[0-9a-f]{64}$/.test(m.files[f] ?? ''));
}

async function inspectSnapshot(dir, m) {
  if (!(await isRealDir(dir)) || !basenameSafe(path.basename(dir))) fail(`invalid completed snapshot directory: ${dir}`);
  let hashesValid = true;
  for (const file of SNAP_FILES) {
    const filePath = path.join(dir, file);
    const st = await fs.lstat(filePath).catch(() => fail(`unreadable snapshot artifact: ${filePath}`));
    if (!st.isFile() || st.isSymbolicLink()) fail(`invalid snapshot artifact: ${filePath}`);
    if (await hashFile(filePath) !== m.files[file]) hashesValid = false;
  }
  return { path: dir, name: path.basename(dir), completedAt: m.completedAt, checkpoint: m.checkpoint, manifest: m, hashesValid };
}

async function listSnapshots(paths) {
  const entries = await fs.readdir(paths.snapshots, { withFileTypes: true }).catch(() => []);
  const complete = [], ignored = [];
  for (const entry of entries) {
    const target = path.join(paths.snapshots, entry.name);
    if (entry.name.startsWith('.partial-') || !entry.isDirectory() || entry.isSymbolicLink()) { ignored.push(target); continue; }
    const manifestPath = path.join(target, 'manifest.json');
    const manifestStat = await fs.lstat(manifestPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      fail(`invalid snapshot manifest: ${target}`);
    });
    if (!manifestStat) { ignored.push(target); continue; }
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail(`invalid snapshot manifest: ${target}`);
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') { ignored.push(target); continue; }
      fail(`invalid snapshot manifest: ${target}`);
    }
    if (manifest?.formatVersion !== 1) { ignored.push(target); continue; }
    if (!validManifest(manifest)) fail(`invalid snapshot manifest: ${target}`);
    complete.push(await inspectSnapshot(target, manifest));
  }
  complete.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.name.localeCompare(b.name));
  return { complete, ignored };
}

async function processCwds(paths, probe) {
  const pids = await probe.pids();
  const result = [];
  for (const pid of pids) {
    const cwd = await probe.cwd(pid).catch(() => null);
    if (cwd) result.push({ pid, cwd: path.resolve(cwd) });
  }
  return result;
}

async function releasePlan(paths, probe) {
  const releasesRoot = await requireRealRoot(paths.releases);
  const names = await fs.readdir(paths.releases, { withFileTypes: true });
  const releases = [];
  for (const e of names) {
    if (!SHA.test(e.name) || !e.isDirectory() || e.isSymbolicLink()) continue;
    const p = path.join(paths.releases, e.name);
    if (await isRealDir(p)) releases.push({ path: p, name: e.name, mtime: (await fs.stat(p)).mtimeMs });
  }
  const currentReal = await fs.realpath(paths.current).catch(() => null);
  const currentEntry = releases.find((r) => path.resolve(r.path) === path.resolve(currentReal ?? ''));
  if (!currentEntry) fail('current is not a real release directory');
  const byRecent = [...releases].sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  const keep = new Set([currentEntry.path, ...byRecent.filter((r) => r.path !== currentEntry.path).slice(0, 2).map((r) => r.path)]);
  for (const cwd of await processCwds(paths, probe)) {
    const activeRelease = releases.find((r) => isWithin(r.path, cwd.cwd));
    if (activeRelease) keep.add(activeRelease.path);
  }
  const dependencies = new Map(releases.map((r) => [r.path, []]));
  for (const release of releases) {
    let mods = path.join(release.path, 'node_modules');
    const seenLinks = new Set();
    let followingLink = false;
    while (true) {
      const st = await fs.lstat(mods).catch((error) => {
        if (followingLink) fail(`broken node_modules link: ${mods}`);
        if (error.code === 'ENOENT') return null;
        fail(`cannot inspect node_modules path: ${mods}`);
      });
      if (!st?.isSymbolicLink()) break;
      if (seenLinks.has(mods)) fail(`node_modules link cycle: ${mods}`);
      seenLinks.add(mods);
      const rawTarget = await fs.readlink(mods);
      if (rawTarget.split(/[\\/]+/).includes('..')) fail(`node_modules link target contains unsupported '..': ${mods}`);
      const target = path.resolve(path.dirname(mods), rawTarget);
      if (!isWithin(releasesRoot, target)) fail(`node_modules link escapes release root: ${mods}`);
      const dependency = releases.find((r) => isWithin(r.path, target));
      if (!dependency) fail(`node_modules link does not target a release: ${mods}`);
      await assertNoSymlinkAncestors(dependency.path, target, mods);
      dependencies.get(release.path).push(dependency.path);
      const resolved = await fs.realpath(target).catch(() => fail(`broken node_modules link: ${mods}`));
      if (!isWithin(releasesRoot, resolved)) fail(`node_modules link escapes release root: ${mods}`);
      const finalDependency = releases.find((r) => isWithin(r.path, resolved));
      if (!finalDependency) fail(`node_modules link does not resolve to a release: ${mods}`);
      dependencies.get(release.path).push(finalDependency.path);
      const targetStat = await fs.lstat(target).catch(() => fail(`broken node_modules link: ${mods}`));
      if (!targetStat.isSymbolicLink()) {
        if (!targetStat.isDirectory()) fail(`node_modules link target is not a directory: ${mods}`);
        break;
      }
      mods = target;
      followingLink = true;
    }
  }
  const visit = (p) => { for (const dep of dependencies.get(p) ?? []) if (!keep.has(dep)) { keep.add(dep); visit(dep); } };
  for (const p of [...keep]) visit(p);
  return { remove: releases.filter((r) => !keep.has(r.path)).map((r) => r.path), keep: [...keep], releases };
}

export async function planStorage({ paths = PRODUCTION_PATHS, probe = systemProbe } = {}) {
  await requireRealRoot(paths.snapshots);
  await requireRealRoot(paths.data);
  const { complete, ignored } = await listSnapshots(paths);
  const keepSnapshots = new Set([...complete.slice(0, 3), ...complete.filter((s) => s.checkpoint !== null).slice(0, 2)].map((s) => s.path));
  if (complete.some((s) => !s.hashesValid)) fail('snapshot hash verification failed');
  const removeSnapshots = complete.filter((s) => !keepSnapshots.has(s.path)).map((s) => s.path);
  const rp = await releasePlan(paths, probe);
  const liveEntries = await fs.readdir(paths.data, { withFileTypes: true });
  const bakFiles = [];
  for (const e of liveEntries) if (BAK.test(e.name)) {
    const p = path.join(paths.data, e.name), st = await fs.lstat(p);
    if (st.isFile() && !st.isSymbolicLink()) bakFiles.push({ path: p, mtime: st.mtimeMs });
  }
  bakFiles.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  return { action: 'plan', snapshots: { keep: [...keepSnapshots], remove: removeSnapshots, ignored }, releases: { keep: rp.keep, remove: rp.remove }, migrationBackups: { keep: bakFiles.slice(0, 1).map((f) => f.path), remove: bakFiles.slice(1).map((f) => f.path) } };
}

async function verifyRootedTarget(root, target, original) {
  if (!directChild(root, target)) fail(`target outside root: ${target}`);
  const st = await fs.lstat(target);
  if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== original.dev || st.ino !== original.ino) fail(`target changed: ${target}`);
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (path.dirname(realTarget) !== realRoot) fail(`target outside real root: ${target}`);
}

export async function pruneStorage({ paths = PRODUCTION_PATHS, probe = systemProbe, apply = false } = {}) {
  const plan = await planStorage({ paths, probe });
  if (!apply) return plan;
  if (plan.snapshots.keep.length === 0) fail('no verified completed snapshot is available');
  const currentBefore = await fs.realpath(paths.current);
  const saved = new Map();
  const targets = [
    ...plan.snapshots.remove.map((p) => [paths.snapshots, p, 'dir']),
    ...plan.releases.remove.map((p) => [paths.releases, p, 'dir']),
    ...plan.migrationBackups.remove.map((p) => [paths.data, p, 'file']),
  ];
  for (const [root, target, kind] of targets) {
    if (!directChild(root, target)) fail(`target outside root: ${target}`);
    const st = await fs.lstat(target);
    if (st.isSymbolicLink() || (kind === 'dir' ? !st.isDirectory() : !st.isFile())) fail(`target type changed: ${target}`);
    const real = await fs.realpath(target);
    if (path.dirname(real) !== await fs.realpath(root)) fail(`target outside real root: ${target}`);
    saved.set(target, { dev: st.dev, ino: st.ino, kind });
  }
  if (await fs.realpath(paths.current) !== currentBefore) fail('current changed before prune');
  const health = await probe.health();
  if (health.activeState !== 'active' || health.subState !== 'running' || !Number.isInteger(health.mainPid) || health.mainPid < 1 || !await probe.pidRunning(health.mainPid)) fail('PA service is not active/running with a valid MainPID');
  if (path.resolve(await probe.cwd(health.mainPid)) !== path.resolve(currentBefore)) fail('PA MainPID cwd is not current');
  const refreshed = await planStorage({ paths, probe });
  if (JSON.stringify(refreshed) !== JSON.stringify(plan)) fail('storage state changed after planning');
  for (const [root, target] of targets) {
    const original = saved.get(target);
    if (original.kind === 'dir') await verifyRootedTarget(root, target, original);
    else {
      const now = await fs.lstat(target);
      if (!now.isFile() || now.isSymbolicLink() || now.dev !== original.dev || now.ino !== original.ino || path.dirname(await fs.realpath(target)) !== await fs.realpath(root)) fail(`target changed: ${target}`);
    }
  }
  for (const [root, target] of targets) {
    if (saved.get(target).kind === 'dir') await fs.rm(target, { recursive: true, force: false });
    else await fs.unlink(target);
  }
  return { action: 'prune', deleted: targets.map(([, p]) => p), counts: { snapshots: plan.snapshots.remove.length, releases: plan.releases.remove.length, migrationBackups: plan.migrationBackups.remove.length } };
}

const systemProbe = {
  async health() {
    const activeState = exec('systemctl', ['show', '-p', 'ActiveState', '--value', PRODUCTION_PATHS.service]);
    const subState = exec('systemctl', ['show', '-p', 'SubState', '--value', PRODUCTION_PATHS.service]);
    const mainPid = Number(exec('systemctl', ['show', '-p', 'MainPID', '--value', PRODUCTION_PATHS.service]));
    return { activeState, subState, mainPid };
  },
  async pidRunning(pid) {
    const stat = await fs.readFile(`${PRODUCTION_PATHS.proc}/${pid}/stat`, 'utf8').catch(() => null);
    if (!stat) return false;
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return Boolean(state) && state !== 'Z' && state !== 'X';
  },
  async cwd(pid) { return fs.realpath(`${PRODUCTION_PATHS.proc}/${pid}/cwd`); },
  async pids() { return (await fs.readdir(PRODUCTION_PATHS.proc)).filter((n) => /^\d+$/.test(n)).map(Number); },
};

export async function createBackup({ paths = PRODUCTION_PATHS, probe = systemProbe, checkpoint = null, now = new Date() } = {}) {
  if (checkpoint !== null && typeof checkpoint !== 'string') fail('checkpoint must be a string');
  const assertStopped = (health) => {
    if (!['inactive', 'failed'].includes(health.activeState) || health.mainPid !== 0) fail('PA service must be inactive or failed with MainPID=0 for backup');
  };
  assertStopped(await probe.health());
  const [current, releasesRoot, snapshotsRoot, dataRoot] = await Promise.all([
    fs.realpath(paths.current), requireRealRoot(paths.releases), requireRealRoot(paths.snapshots), requireRealRoot(paths.data),
  ]);
  const release = path.basename(current);
  if (!SHA.test(release) || !directChild(releasesRoot, current) || !(await isRealDir(current))) fail('current is not a real release directory');
  const root = snapshotsRoot;
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const partial = path.join(root, `.partial-${stamp}-${process.pid}`);
  await fs.mkdir(partial, { mode: 0o700 });
  try {
    await fs.chmod(partial, 0o700);
    exec('tar', ['-C', path.dirname(dataRoot), '-czf', path.join(partial, 'data.tar.gz'), path.basename(dataRoot)]);
    exec('tar', ['-C', current, '--exclude=node_modules', '--exclude=.git', '-czf', path.join(partial, 'source.tar.gz'), '.']);
    await fs.copyFile(paths.env, path.join(partial, 'pa.env'));
    await fs.copyFile(paths.unit, path.join(partial, 'pa.service'));
    for (const f of SNAP_FILES) await fs.chmod(path.join(partial, f), 0o600);
    const db = await import('node:sqlite');
    const { DatabaseSync } = db;
    const probeDb = path.join(dataRoot, 'pa.sqlite');
    const database = new DatabaseSync(probeDb, { readOnly: true });
    let schemaVersion;
    try { schemaVersion = Number(database.prepare('PRAGMA user_version').get().user_version); } finally { database.close(); }
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) fail('invalid schema version');
    execQuiet('tar', ['-tzf', path.join(partial, 'data.tar.gz')]);
    execQuiet('tar', ['-tzf', path.join(partial, 'source.tar.gz')]);
    const files = Object.fromEntries(await Promise.all(SNAP_FILES.map(async (f) => [f, await hashFile(path.join(partial, f))])));
    const manifest = { formatVersion: 1, completedAt: now.toISOString(), release, schemaVersion, checkpoint, files };
    await fs.writeFile(path.join(partial, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    await fs.chmod(path.join(partial, 'manifest.json'), 0o600);
    assertStopped(await probe.health());
    if (await fs.realpath(paths.current) !== current) fail('PA state/current changed during backup');
    const final = path.join(root, `${stamp}-${release.slice(0, 12)}`);
    await fs.rename(partial, final);
    return { action: 'backup', path: final, completedAt: manifest.completedAt, release, schemaVersion, checkpoint };
  } catch (error) {
    await fs.rm(partial, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function main(argv) {
  if (process.getuid?.() !== 0) fail('root is required');
  const [command = 'plan', ...args] = argv;
  if (args.some((a) => a === '--root' || a.startsWith('--root='))) fail('--root is not supported');
  let result;
  if (command === 'plan' && args.length === 0) result = await planStorage();
  else if (command === 'prune' && (args.length === 0 || (args.length === 1 && args[0] === '--apply'))) result = await pruneStorage({ apply: args[0] === '--apply' });
  else if (command === 'backup' && (args.length === 0 || (args.length === 2 && args[0] === '--checkpoint'))) result = await createBackup({ checkpoint: args[0] === '--checkpoint' ? args[1] : null });
  else fail('usage: pa-storage.mjs [plan|prune [--apply]|backup [--checkpoint reason]]');
  jsonOut(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
