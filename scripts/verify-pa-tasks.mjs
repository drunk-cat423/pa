#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const compiler = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
const planFile = 'docs/design/task-coordinator-verification.json';
const usage = '用法 node scripts/verify-pa-tasks.mjs doctor | list | run <feature> | list-stage | plan [stage]';
const features = {
  P2: {
    test: 'test/task-coordinator-p2.test.mjs',
    name: 'V03 selects a new compatible worker and fences start and authenticated reports',
    additional: ['a silent adapter times out with unknown effects and no second start'],
    fixtures: [],
  },
  P1: {
    test: 'test/task-coordinator-p1.test.mjs',
    name: 'P1: authenticated acceptance and atomic revision closure survive restart',
    fixtures: [],
  },
};

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const systemEnv = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

function git(...args) {
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd: repo, env: { ...systemEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  return result.stdout.trim();
}

function workspace() {
  if (realpathSync(git('rev-parse', '--show-toplevel')) !== repo) throw new Error('脚本不在 PA 仓库根目录下。');
  return {
    path: repo,
    head: git('rev-parse', '--verify', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: Boolean(git('status', '--porcelain=v1', '--untracked-files=normal')),
  };
}

function readiness(selected) {
  const pkg = readJson(join(repo, 'package.json'));
  const required = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines?.node);
  if (!required) throw new Error('无法识别 package.json 的 Node.js 版本约束。');
  const comparison = new Intl.Collator('en', { numeric: true }).compare(process.versions.node, required.slice(1).join('.'));
  if (comparison < 0) throw new Error(`需要 Node.js ${pkg.engines.node}，当前 ${process.version}。`);

  const dependencies = [
    'node_modules/typescript/bin/tsc',
    'node_modules/@types/node/package.json',
    'node_modules/@earendil-works/pi-coding-agent/package.json',
    'node_modules/@earendil-works/pi-ai/package.json',
  ];
  for (const path of dependencies) {
    if (!existsSync(join(repo, path))) throw new Error(`${path} 不存在。请在 PA 仓库按锁文件运行 npm ci。`);
  }
  for (const { test, fixtures } of selected) {
    for (const path of [test, ...fixtures]) readFileSync(join(repo, path));
  }
  return {
    node: process.version,
    typescript: readJson(join(repo, 'node_modules/typescript/package.json')).version,
    pi: readJson(join(repo, 'node_modules/@earendil-works/pi-coding-agent/package.json')).version,
  };
}

function snapshot(scratch, feature) {
  const paths = [
    'package.json', 'package-lock.json', 'tsconfig.json',
    ...globSync('src/**/*.ts', { cwd: repo }).map(path => path.replaceAll('\\', '/')).sort(),
    feature.test, ...feature.fixtures,
  ];
  return Object.fromEntries(paths.map(path => {
    const content = readFileSync(join(repo, path));
    const target = join(scratch, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return [path, sha256(content)];
  }));
}

function command(evidence, scratch, env, stage, args, timeout) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, {
    cwd: scratch, env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024,
  });
  const stdout = `${stage}.stdout.txt`;
  const stderr = `${stage}.stderr.txt`;
  writeFileSync(join(evidence, stdout), result.stdout ?? '');
  writeFileSync(join(evidence, stderr), result.stderr ?? '');
  return {
    stage, startedAt, finishedAt: new Date().toISOString(), cwd: scratch,
    argv: [process.execPath, ...args], exitCode: result.status, signal: result.signal,
    error: result.error?.message, stdout, stderr,
  };
}

function run(featureId, feature) {
  const temporaryRoot = realpathSync(tmpdir());
  const evidence = mkdtempSync(join(temporaryRoot, 'pa-task-verify-'));
  const scratch = join(evidence, 'scratch');
  const manifest = {
    version: 1, kind: 'offline-coordinator-stage', feature: featureId, test: feature.test, testName: feature.name,
    startedAt: new Date().toISOString(), outcome: 'failed', exitCode: 1, commands: [],
    artifacts: ['run.json'],
  };
  console.log(`证据目录 ${evidence}`);
  try {
    manifest.workspace = workspace();
    manifest.tools = readiness([feature]);
    manifest.runnerDigest = sha256(readFileSync(fileURLToPath(import.meta.url)));
    manifest.sourceFiles = snapshot(scratch, feature);
    manifest.sourceDigest = sha256(JSON.stringify(manifest.sourceFiles));
    symlinkSync(join(repo, 'node_modules'), join(scratch, 'node_modules'), 'junction');
    const fixtureTemp = join(scratch, 'tmp');
    const home = join(scratch, 'home');
    mkdirSync(fixtureTemp);
    mkdirSync(home);
    const env = { ...systemEnv, TEMP: fixtureTemp, TMP: fixtureTemp, TMPDIR: fixtureTemp, HOME: home, USERPROFILE: home };

    const execute = (stage, args, timeout) => {
      const executed = command(evidence, scratch, env, stage, args, timeout);
      manifest.commands.push(executed);
      manifest.artifacts.push(executed.stdout, executed.stderr);
      if (executed.error || executed.exitCode !== 0) {
        throw new Error(`${stage} 失败（退出码 ${executed.exitCode}，${executed.error ?? executed.signal ?? '见日志'}）。`);
      }
      return executed;
    };
    execute('build', [compiler, '-p', 'tsconfig.json'], 120_000);
    const names = [feature.name, ...(feature.additional ?? [])];
    const pattern = `^(?:${names.map(name => RegExp.escape(name)).join('|')})$`;
    const executed = execute('test', [
      '--test', '--test-isolation=none', '--test-reporter=tap', '--test-timeout=90000',
      `--test-name-pattern=${pattern}`, feature.test,
    ], 100_000);
    const tap = readFileSync(join(evidence, executed.stdout), 'utf8');
    const allNamed = names.every(name => new RegExp(`^ok \\d+ - ${RegExp.escape(name)}$`, 'm').test(tap));
    if (!allNamed || !new RegExp(`^# pass ${names.length}\\r?$`, 'm').test(tap) || !/^# fail 0\r?$/m.test(tap)) {
      throw new Error('所选测试没有实际通过。请检查测试名和 TAP 日志。');
    }
    manifest.outcome = 'passed';
    manifest.exitCode = 0;
  } catch (error) {
    manifest.error = error.message;
  } finally {
    try {
      if (existsSync(scratch) && realpathSync(scratch) !== scratch) {
        throw new Error('临时目录已被重定向，无法安全清理。');
      }
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
      manifest.scratchRemoved = !existsSync(scratch);
    } catch (error) {
      manifest.outcome = 'failed';
      manifest.exitCode = 1;
      manifest.scratchRemoved = false;
      manifest.cleanupError = error.message;
    }
    manifest.finishedAt = new Date().toISOString();
    writeJson(join(evidence, 'run.json'), manifest);
  }
  if (manifest.exitCode !== 0) {
    console.error(manifest.error ?? manifest.cleanupError);
  } else {
    console.log(`通过 ${featureId}（协调器离线验收）。`);
  }
  process.exitCode = manifest.exitCode;
}

function readPlan() {
  const plan = readJson(join(repo, planFile));
  const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
  if (plan?.version !== 1 || !Array.isArray(plan.stages) || !Array.isArray(plan.cases)
    || plan.stages.length === 0 || plan.cases.length === 0) {
    throw new Error(`${planFile} 缺少有效的阶段或验收项。`);
  }
  for (const stage of plan.stages) {
    if (!nonEmpty(stage?.id) || !nonEmpty(stage.title) || !Array.isArray(stage.dependsOn)) {
      throw new Error(`${planFile} 的阶段格式无效。`);
    }
  }
  const stageIds = new Set(plan.stages.map(stage => stage.id));
  if (stageIds.size !== plan.stages.length
    || plan.stages.some(stage => stage.dependsOn.some(id => !stageIds.has(id))
      || new Set(stage.dependsOn).size !== stage.dependsOn.length)) {
    throw new Error(`${planFile} 的阶段编号重复或依赖无效。`);
  }
  const ordered = new Set();
  while (ordered.size < stageIds.size) {
    const next = plan.stages.find(stage => !ordered.has(stage.id) && stage.dependsOn.every(id => ordered.has(id)));
    if (!next) throw new Error(`${planFile} 的阶段依赖成环。`);
    ordered.add(next.id);
  }
  const caseFields = ['id', 'stage', 'module', 'action', 'expect', 'evidence'];
  for (const item of plan.cases) {
    if (caseFields.some(key => !nonEmpty(item?.[key])) || !stageIds.has(item.stage)) {
      throw new Error(`${planFile} 的验收项格式无效。`);
    }
  }
  if (new Set(plan.cases.map(item => item.id)).size !== plan.cases.length) {
    throw new Error(`${planFile} 的验收项编号重复。`);
  }
  const stagesWithCases = new Set(plan.cases.map(item => item.stage));
  const emptyStage = plan.stages.find(stage => !stagesWithCases.has(stage.id));
  if (emptyStage) throw new Error(`${planFile} 的阶段 ${emptyStage.id} 没有验收项。`);
  return plan;
}

function main([subcommand, arg, ...extra]) {
  if (extra.length === 0) {
    if ((subcommand === 'help' || subcommand === '--help') && arg === undefined) {
      console.log(usage);
      return;
    }
    if (subcommand === 'doctor' && arg === undefined) {
      console.log(JSON.stringify({
        ready: true, kind: 'offline-coordinator-stage', workspace: workspace(),
        tools: readiness(Object.values(features)),
      }, null, 2));
      return;
    }
    if (subcommand === 'list' && arg === undefined) {
      for (const [id, feature] of Object.entries(features)) {
        console.log(`${id}  ${feature.test}  ${feature.name}`);
      }
      return;
    }
    if (subcommand === 'run' && Object.hasOwn(features, arg)) {
      run(arg, features[arg]);
      return;
    }
    if (subcommand === 'plan' || (subcommand === 'list-stage' && arg === undefined)) {
      const { stages, cases } = readPlan();
      const selected = stages.filter(stage => arg === undefined || stage.id === arg);
      const items = cases.filter(item => arg === undefined || item.stage === arg);
      if (selected.length === 0) throw new Error(`未知验收阶段 ${arg}。`);
      console.log(JSON.stringify({
        kind: 'planned-production-coordinator-verification',
        source: planFile,
        stages: selected,
        ...(subcommand === 'plan' && { cases: items }),
      }, null, 2));
      return;
    }
  }
  throw new Error(usage);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
