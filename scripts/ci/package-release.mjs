import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourcePaths = [
  '.agents', '.env.example', '.gitattributes', '.gitignore', '.github/pull_request_template.md',
  '.github/workflows/ci.yml', 'AGENTS.md', 'README.md', 'docs',
  'package.json', 'package-lock.json', 'scripts', 'src', 'test', 'tsconfig.json',
];

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function checkSource(sha) {
  if (git(['status', '--porcelain=v1', '--untracked-files=no']).trim()) {
    throw new Error('Commit or restore tracked changes before packaging.');
  }
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha) {
    throw new Error('HEAD does not match GITHUB_SHA.');
  }
  const entries = git(['ls-tree', '-rz', sha, '--', ...sourcePaths]).split('\0').filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const file = entry.slice(tab + 1);
    const reservedPath = /(^|\/)(?:\.git|\.local|node_modules|\.env(?:\.[^/]*)?)(?:\/|$)/i;
    if (!/^100(?:644|755) blob /.test(entry) || (file !== '.env.example' && reservedPath.test(file))) {
      throw new Error(`Unexpected release source entry: ${file}`);
    }
  }
}

function publishFiles(scratch, output, files) {
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  const copied = [];
  try {
    for (const file of files) {
      copyFileSync(join(scratch, file), join(output, file), constants.COPYFILE_EXCL);
      copied.push(file);
    }
  } catch (error) {
    for (const file of copied) unlinkSync(join(output, file));
    rmdirSync(output);
    throw error;
  }
}

function packageRelease(output) {
  if (lstatSync(output, { throwIfNoEntry: false })) {
    throw new Error(`Output path already exists: ${output}`);
  }
  const sha = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  checkSource(sha);

  const filename = `pa-${sha}.tar.gz`;
  const scratch = mkdtempSync(join(tmpdir(), 'pa-release-'));
  try {
    const snapshot = join(scratch, 'source');
    mkdirSync(snapshot);
    git(['archive', '--format=tar', '--output', join(scratch, 'source.tar'), sha, '--', ...sourcePaths]);
    run('tar', ['-xf', 'source.tar', '-C', 'source'], scratch);

    // Build the archived commit using the dependencies already installed for repo-check.
    const dependencies = join(snapshot, 'node_modules');
    symlinkSync(join(root, 'node_modules'), dependencies, 'junction');
    run(process.execPath, [join(dependencies, 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], snapshot);
    unlinkSync(dependencies);

    writeFileSync(join(snapshot, 'RELEASE_SHA'), `${sha}\n`);
    run('tar', ['-czf', filename, '-C', 'source', ...sourcePaths, 'dist', 'RELEASE_SHA'], scratch);
    const checksum = createHash('sha256').update(readFileSync(join(scratch, filename))).digest('hex');
    writeFileSync(join(scratch, 'SHA256SUMS'), `${checksum}  ${filename}\n`);
    publishFiles(scratch, output, [filename, 'SHA256SUMS']);
    console.log(`Packaged ${sha} in ${output}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  if (process.argv.length !== 3 || !process.argv[2]) {
    throw new Error('Usage: node scripts/ci/package-release.mjs <fresh-output-directory>');
  }
  packageRelease(resolve(process.argv[2]));
} catch (error) {
  console.error(`package-release: ${error.message}`);
  process.exitCode = 1;
}
