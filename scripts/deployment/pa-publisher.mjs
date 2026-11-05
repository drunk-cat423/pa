import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync,
  openSync, readSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT = '/opt/pa/maintenance/publisher/publish.sh';
const statuses = new Set(['prepared', 'queued', 'running', 'succeeded', 'rolled_back', 'failed']);
const terminal = new Set(['succeeded', 'rolled_back', 'failed']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
class ObsoleteRelease extends Error {}

function atomicJson(path, value) {
  writeFileSync(path + '.next', JSON.stringify(value), { mode: 0o600, flush: true });
  renameSync(path + '.next', path);
}
function regular(path, maximum) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('发布输入文件类型或大小无效。');
    const buffer = Buffer.alloc(stat.size);
    let n=0;
    while(n<buffer.length) {
      const count=readSync(fd,buffer,n,buffer.length-n,null);
      if(!count) throw new Error('发布输入文件在读取中改变。');
      n+=count;
    }
    if(fstatSync(fd).size!==n) throw new Error('发布输入文件在读取中改变。');
    return buffer;
  } finally { closeSync(fd); }
}
function frozenEvidence(root, revisionDirectory) {
  const directory = join(root, 'results', revisionDirectory);
  if (process.platform !== 'linux') { realDirectory(directory); return regular(join(directory, 'diff.txt'),750_000); }
  // Anchor every lookup to a pinned directory fd: the worker owns this tree.
  let fd=openSync('/',constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for(const part of directory.split('/').filter(Boolean)){
      const next=openSync('/proc/self/fd/'+fd+'/'+part,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd=next;
    }
    return regular('/proc/self/fd/'+fd+'/diff.txt',750_000);
  } finally { closeSync(fd); }
}
function realDirectory(path) {
  if (realpathSync(path) !== resolve(path) || !lstatSync(path).isDirectory()) throw new Error('发布目录被重定向。');
}
function safePatch(text) {
  if (typeof text !== 'string' || !text.startsWith('diff --git ') || Buffer.byteLength(text) > 750_000
    || /\u0000|^Binary files |^GIT binary patch|^(?:new file mode|old mode|new mode) (?:120000|160000)/m.test(text)) {
    throw new Error('只允许发布可核对的文本代码差异。');
  }
  const paths = [...text.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)];
  if (!paths.length || paths.length !== text.split(/^diff --git /m).length - 1) throw new Error('补丁文件名无效。');
  for (const pair of paths) for (const path of pair.slice(1)) {
    if (!/^[A-Za-z0-9_.\/-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')
      || path.split('/').includes('.git') || path.startsWith('/') || path.startsWith('.env')) throw new Error('补丁路径无效。');
  }
  return Buffer.from(text, 'utf8');
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('发布请求参数无效。');
  }
}
function input(value, owner) {
  exactKeys(value, ['owner', 'requestId', 'taskId', 'revision', 'patchSha256']);
  if (value.owner !== owner) throw new Error('无权发布。');
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(value.requestId)
    || typeof value.taskId !== 'string' || !uuid.test(value.taskId)
    || !/^[a-f0-9]{64}$/.test(value.patchSha256) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('发布任务编号、版本或补丁指纹无效。');
  return { owner, requestId: value.requestId, taskId: value.taskId, revision: value.revision, patchSha256: value.patchSha256 };
}
async function body(request) {
  let text = '';
  request.setEncoding('utf8');
  for await (const part of request) {
    text += part;
    if (Buffer.byteLength(text) > 10_000) throw new Error('发布请求过长。');
  }
  return JSON.parse(text);
}
function worker(config, path) {
  return new Promise((accept, reject) => {
    const request = httpRequest({ socketPath: config.workerSocket, path }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 2_000_000) request.destroy(new Error('执行结果过长。')); else chunks.push(chunk); });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('执行器未确认该任务版本。');
          accept(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('执行器查询超时。')));
    request.on('error', reject); request.end();
  });
}

export function publisherConfig(env = process.env) {
  const required = name => { const value = env[name]?.trim(); if (!value) throw new Error('缺少发布配置 ' + name); return value; };
  const config = { directory: required('PA_PUBLISH_DIR'), socket: required('PA_PUBLISH_SOCKET'), owner: required('PA_PUBLISH_OWNER'),
    workerSocket: required('PA_PUBLISH_WORKER_SOCKET'), workerDirectory: required('PA_PUBLISH_WORKER_DIR'), current: '/opt/pa/current' };
  if (![config.directory, config.socket, config.workerSocket, config.workerDirectory].every(isAbsolute)
    || !/^[a-f0-9]{64}$/.test(config.owner)) throw new Error('发布配置无效。');
  return config;
}

/** The only mutation boundary is a root-installed, fixed deployment script. */
export async function startPublisher(config, execute = runScript) {
  mkdirSync(config.directory, { recursive: true, mode: 0o700 }); realDirectory(config.directory);
  const ledgerFile = join(config.directory, 'releases.json');
  const ledger = existsSync(ledgerFile) ? JSON.parse(regular(ledgerFile, 16_000_000)) : { version: 1, releases: [] };
  if (ledger.version !== 1 || !Array.isArray(ledger.releases) || ledger.releases.some(job => !uuid.test(job.id) || !statuses.has(job.status))) {
    throw new Error('发布账本无效，等待本机维护。');
  }
  const preparing = new Map(), starting = new Map(); let active = false, closing = false, child;
  const save = () => atomicJson(ledgerFile, ledger);
  const current = () => {
    const source = realpathSync(config.current);
    const sourceSha = regular(join(source, 'RELEASE_SHA'), 100).toString().trim();
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('线上版本标识无效。');
    return { source, sourceSha };
  };
  async function verified(request) {
    const suffix = '?owner=' + config.owner;
    const latest = await worker(config, '/tasks/' + request.taskId + suffix);
    const task = await worker(config, '/tasks/' + request.taskId + suffix + '&revision=' + request.revision);
    if (latest.revision !== request.revision || task.id !== request.taskId || task.revision !== request.revision
      || task.owner !== config.owner || task.status !== 'completed' || task.mode !== 'fix') throw new ObsoleteRelease('只能发布最新且已成功完成的修复版本。');
    const source = current();
    if (task.source !== source.source) throw new ObsoleteRelease('线上版本已变化，需要基于当前版本重新核对修复。');
    const patch = safePatch(task.diff);
    const recorded = frozenEvidence(config.workerDirectory,`${request.taskId}-${request.revision}`);
    if (!recorded.equals(patch)) throw new ObsoleteRelease('保存的代码差异与执行器报告不一致。');
    return { ...source, patch, patchSha256: hash(patch) };
  }
  function view(job) { return { ...job }; }
  function jobDir(id) { return join(config.directory, id); }
  const tick = async () => {
    if (active || closing) return;
    const job = ledger.releases.find(job => job.status === 'running') ?? ledger.releases.find(job => job.status === 'queued');
    if (!job) return;
    if (job.retryAt && job.retryAt > Date.now()) return;
    active = true;
    job.status = 'running'; job.updatedAt = now(); save();
    try {
      const result = await execute(jobDir(job.id), process => { child = process; });
      if (!result || !terminal.has(result.status) || typeof result.summary !== 'string'
        || result.summary.length > 2000 || (result.commit !== undefined && !/^[a-f0-9]{40}$/.test(result.commit))) {
        throw new Error('发布程序没有返回可核对的结果。');
      }
      Object.assign(job, { status: result.status, summary: result.summary, ...(result.commit ? { commit: result.commit } : {}), updatedAt: now() });
      delete job.retryAt; delete job.recoveryAttempts;
      save();
    } catch (error) {
      job.status = 'running'; job.summary = '发布状态正在核对，确认线上版本或恢复旧版后会通知你。'; job.updatedAt = now();
      job.recoveryAttempts = (job.recoveryAttempts ?? 0) + 1;
      job.retryAt = Date.now() + Math.min(60_000, 5000 * 2 ** Math.min(job.recoveryAttempts - 1, 4));
      save(); console.error('Publisher execution result unavailable:', error instanceof Error ? error.message : 'unknown');
    } finally { active = false; child = undefined; if (!closing) setImmediate(() => { void tick(); }); }
  };
  async function prepare(request) {
    const existing = ledger.releases.find(job => job.requestId === request.requestId);
    if (existing) {
      if (existing.owner !== request.owner || existing.taskId !== request.taskId || existing.revision !== request.revision || existing.patchSha256 !== request.patchSha256) throw new Error('重复确认的任务版本发生变化。');
      return view(existing);
    }
    const fingerprint = JSON.stringify(request);
    const pending = preparing.get(request.requestId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new Error('并发确认的任务版本发生变化。');
      return pending.promise;
    }
    const promise = (async () => {
      const frozen = await verified(request);
      if (request.patchSha256 !== frozen.patchSha256) throw new Error('补丁与已确认送达的版本不同。');
      if (ledger.releases.some(job => job.taskId === request.taskId && job.revision === request.revision && job.owner === request.owner)) {
        throw new Error('该修复版本已有发布记录，请查询原发布状态。');
      }
      const id = randomUUID(), directory = jobDir(id), createdAt = now();
      mkdirSync(directory, { mode: 0o700 });
      const manifest = { id, ...request, sourceSha: frozen.sourceSha, source: frozen.source, patchSha256: frozen.patchSha256, createdAt };
      writeFileSync(join(directory, 'patch.diff'), frozen.patch, { mode: 0o600, flush: true });
      atomicJson(join(directory, 'manifest.json'), manifest);
      const job = { ...manifest, status: 'prepared', updatedAt: createdAt };
      ledger.releases.push(job); save(); return view(job);
    })();
    preparing.set(request.requestId, { fingerprint, promise });
    try { return await promise; } finally { preparing.delete(request.requestId); }
  }
  async function activate(job) {
    const pending = starting.get(job.id);
    if (pending) return pending;
    const promise = (async () => {
      if (job.status === 'prepared') {
        if (ledger.releases.some(other => ['queued', 'running'].includes(other.status))) throw new Error('已有发布正在执行，请等它结束。');
        try {
          const frozen = await verified(job);
          if (frozen.patchSha256 !== job.patchSha256 || frozen.sourceSha !== job.sourceSha) throw new ObsoleteRelease('待发布版本已变化，请重新核对。');
        } catch (error) {
          if (!(error instanceof ObsoleteRelease)) throw error;
          Object.assign(job,{status:'failed',summary:error.message,updatedAt:now()}); save(); return view(job);
        }
        if (ledger.releases.some(other => ['queued', 'running'].includes(other.status))) throw new Error('已有发布正在执行，请等它结束。');
        job.status = 'queued'; job.updatedAt = now(); save();
      }
      return view(job);
    })();
    starting.set(job.id, promise);
    try { return await promise; } finally { starting.delete(job.id); }
  }
  const server = createServer((request, response) => {
    const send = (code, value) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/releases') { send(202, await prepare(input(await body(request), config.owner))); return; }
      const match = /^\/releases\/([a-f0-9-]{36})(\/start)?$/.exec(url.pathname);
      if (request.method === 'POST' && match?.[2]) {
        const value = await body(request); exactKeys(value, ['owner', 'requestId']);
        const job = ledger.releases.find(job => job.id === match[1]);
        if (value.owner !== config.owner || !job || job.owner !== value.owner || job.requestId !== value.requestId) throw new Error('发布确认不匹配。');
        send(202, await activate(job)); setImmediate(() => { void tick(); }); return;
      }
      if (request.method !== 'GET' || url.searchParams.get('owner') !== config.owner) { send(403, { error: '无权查看发布状态。' }); return; }
      if (url.pathname === '/releases') {
        const requestId = url.searchParams.get('requestId');
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('分页参数无效。');
        const matching = ledger.releases.filter(job => job.owner === config.owner && (!requestId || job.requestId === requestId));
        const releases = requestId ? matching : matching.slice(offset, offset + 50);
        send(200, { releases: releases.map(view), ...(!requestId && matching.length > offset + 50 ? { nextOffset: offset + 50 } : {}) }); return;
      }
      const job = match && ledger.releases.find(job => job.id === match[1] && job.owner === config.owner);
      send(job ? 200 : 404, job ? view(job) : { error: '没有找到发布记录。' });
    })().catch(error => { if (!response.headersSent) send(400, { error: error instanceof Error ? error.message : '发布请求失败。' }); });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  if (process.platform !== 'win32') {
    mkdirSync(dirname(config.socket), { recursive: true, mode: 0o750 }); realDirectory(dirname(config.socket));
    if (existsSync(config.socket)) { if (!lstatSync(config.socket).isSocket()) throw new Error('发布通信路径无效。'); unlinkSync(config.socket); }
  }
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(config.socket, accept); });
  if (process.platform !== 'win32') chmodSync(config.socket, 0o660);
  const timer = setInterval(() => { void tick(); }, 2000); timer.unref(); void tick();
  return { async close() { closing = true; clearInterval(timer); server.closeAllConnections(); child?.kill('SIGTERM'); await new Promise(accept => server.close(accept)); } };
}

function runScript(directory, onChild) {
  return new Promise((accept, reject) => {
    const process = spawn(SCRIPT, [directory], { env: { PATH: '/opt/node-v24.15.0/bin:/usr/sbin:/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8' }, stdio: ['ignore', 'inherit', 'inherit'] });
    onChild(process); process.on('error', reject);
    process.on('close', () => {
      try { accept(JSON.parse(regular(join(directory, 'result.json'), 12000))); } catch (error) { reject(error); }
    });
  });
}
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  startPublisher(publisherConfig()).then(server => {
    process.once('SIGTERM', () => { void server.close().then(() => process.exit(0)); });
    process.once('SIGINT', () => { void server.close().then(() => process.exit(0)); });
    console.log('PA publisher ready.');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
