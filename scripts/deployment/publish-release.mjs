import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Optional layout is supplied by the operator's systemd environment for a separate acceptance instance.
const layout = { app: '/opt/pa', state: '/var/lib/pa-publisher', data: '/var/lib/pa', snapshots: '/var/backups/pa/snapshots',
  pa: 'pa.service', worker: 'pa-codex-worker.service', dataUser: 'pa', buildUser: 'pa-publish-build',
  storage: '/opt/pa/maintenance/storage/pa-storage.mjs', workerState: '/var/lib/pa-codex-probe/delegation/tasks.json',
  github: 'ssh://git@ssh.github.com:443/drunk-cat423/pa.git', branch: 'main', gate:'/var/lib/pa-publish-gate/hold',
  ...(process.env.PA_PUBLISH_LAYOUT ? JSON.parse(fs.readFileSync(process.env.PA_PUBLISH_LAYOUT, 'utf8')) : {}) };
const dir = fs.realpathSync(process.argv[2]);
const id = path.basename(dir);
if (path.dirname(dir) !== path.join(layout.state, 'jobs') || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Error('发布目录无效。');
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const manifest = readJSON(path.join(dir, 'manifest.json'));
const sha = /^[a-f0-9]{40}$/;
if (manifest.id !== id || !sha.test(manifest.sourceSha)) throw Error('发布清单无效。');
const source = manifest.sourceSha, releases = path.join(layout.app, 'releases'), current = path.join(layout.app, 'current');
const previous = path.join(releases, source), mirror = path.join(layout.state, 'repository.git');
const checkpoint = path.join(dir, 'deploy.json'), resultPath = path.join(dir, 'result.json');
const state = fs.existsSync(checkpoint) ? readJSON(checkpoint) : { phase: 'prepare' };
function atomic(p, value) {
  const temp = p + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value) + '\n', {mode:0o600, flush:true}); fs.renameSync(temp,p);
  const fd = fs.openSync(path.dirname(p), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function phase(next, extra = {}) { Object.assign(state, extra, {phase:next}); atomic(checkpoint,state); }
function finish(status, summary) { atomic(resultPath, {status,summary, ...(state.commit ? {commit:state.commit} : {})}); }
function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {encoding:'utf8', timeout:120000, maxBuffer:8*1024*1024,
    stdio:['ignore','pipe','pipe'], ...options});
}
const gitEnv = { PATH:'/opt/node-v24.15.0/bin:/usr/bin:/bin', HOME:layout.state, LANG:'C.UTF-8', GIT_TERMINAL_PROMPT:'0',
  GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_SSH_COMMAND:'ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o UserKnownHostsFile=/etc/pa-publisher/known_hosts -i /etc/pa-publisher/github-deploy' };
function git(args, extra = {}) {
  return run('git',['--git-dir',mirror,'-c','core.hooksPath=/dev/null',...args],{env:{...gitEnv,...extra}});
}
function remoteHead() {
  const rev=git(['ls-remote','--exit-code',layout.github,'refs/heads/'+layout.branch]).split(/\s/)[0];
  if (!sha.test(rev)) throw Error('无法核实 GitHub 分支。');
  return rev;
}
function prepareCommit() {
  if(fs.realpathSync(current)!==previous) throw Error('线上版本已变化，请在最新代码上重新核实任务。');
  if(!fs.existsSync(mirror)) run('git',['init','--bare',mirror],{env:gitEnv});
  if(remoteHead()!==source) throw Error('GitHub 分支与任务基线不同，请在最新版本上重新核实。');
  git(['fetch','--no-tags',layout.github,'refs/heads/'+layout.branch]);
  if(git(['rev-parse','FETCH_HEAD']).trim()!==source) throw Error('GitHub 分支在准备期间变化。');
  const patch=path.join(dir,'patch.diff'), bytes=fs.readFileSync(patch);
  if(!bytes.length || createHash('sha256').update(bytes).digest('hex')!==manifest.patchSha256) throw Error('冻结补丁校验失败。');
  if(/^(?:Binary files |GIT binary patch)/m.test(bytes.toString())) throw Error('自动发布只支持文本补丁。');
  const env={GIT_INDEX_FILE:path.join(dir,'candidate.index')};
  git(['read-tree',source],env); git(['apply','--cached','--whitespace=nowarn',patch],env);
  const names=git(['diff','--cached','--no-renames','--name-only','-z',source,'--'],env).split('\0').filter(Boolean);
  if(!names.length || names.some(n=>!/^((src|test|docs)\/(?!\.)([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*|README\.md)$/.test(n))) {
    throw Error('自动发布只允许 src、test、docs 内的普通文件及 README.md。依赖、部署设置和敏感路径须单独维护。');
  }
  for(const entry of git(['diff','--cached','--no-renames','--raw',source,'--'],env).trim().split('\n')) {
    if(!/^:(?:100644|000000) (?:100644|000000) /.test(entry)) throw Error('补丁包含非普通文件或权限更改。');
  }
  const tree=git(['write-tree'],env).trim();
  const author='PA Release';
  const commit=git(['commit-tree',tree,'-p',source,'-m',`PA task ${manifest.taskId} revision ${manifest.revision}`],
    {GIT_AUTHOR_NAME:author,GIT_AUTHOR_EMAIL:'pa-release@users.noreply.github.com',GIT_COMMITTER_NAME:author,
      GIT_COMMITTER_EMAIL:'pa-release@users.noreply.github.com',GIT_AUTHOR_DATE:manifest.createdAt,GIT_COMMITTER_DATE:manifest.createdAt}).trim();
  if(!sha.test(commit)) throw Error('候选提交创建失败。');
  git(['update-ref','refs/pa-jobs/'+id,commit]); return {commit,names};
}
function build(commit, names) {
  const dest=path.join(releases,commit);
  if(fs.existsSync(dest) && fs.readFileSync(path.join(dest,'RELEASE_SHA'),'utf8').trim()===commit) return;
  const stage=fs.mkdtempSync(path.join(releases,'.publish-')); fs.chmodSync(stage,0o755);
  const archive=path.join(dir,'candidate.tar');
  try {
    git(['archive','--format=tar','-o',archive,commit]);
    run('tar',['-xf',archive,'-C',stage]); fs.unlinkSync(archive);
    const lockAt = root => fs.readFileSync(path.join(root,'package-lock.json'),'utf8').replace(/\r\n/g,'\n');
    if(lockAt(stage)!==lockAt(previous)) throw Error('依赖锁文件变化。');
    run('cp',['-a','--reflink=auto',fs.realpathSync(path.join(previous,'node_modules')),path.join(stage,'node_modules')]);
    const dist=path.join(stage,'dist'); fs.mkdirSync(dist); run('chown',[layout.buildUser,dist]);
    // No candidate code runs as root. Tests cannot write the build output, release checkout, Git mirror or credentials.
    const restricted=(args,writeDist=false)=>run('systemd-run',['--quiet','--pipe','--wait','--collect','-p','User='+layout.buildUser,
      '-p','WorkingDirectory='+stage,'-p','ProtectSystem=strict','-p','ProtectHome=true','-p','PrivateTmp=true','-p','PrivateNetwork=true',
      '-p','NoNewPrivileges=true','-p','KillMode=control-group','-p','MemoryMax=512M','-p','MemorySwapMax=0','-p','RuntimeMaxSec=150',
      ...(writeDist?['-p','ReadWritePaths='+dist]:[]),'--setenv=PATH=/opt/node-v24.15.0/bin:/usr/bin:/bin',...args],{timeout:170000});
    restricted(['/opt/node-v24.15.0/bin/node',path.join(stage,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],true);
    const tests=names.filter(n=>n.startsWith('test/')&&n.endsWith('.test.mjs')&&fs.existsSync(path.join(stage,n)));
    if(tests.length) restricted(['/opt/node-v24.15.0/bin/node','--test','--test-concurrency=1',...tests]);
    fs.writeFileSync(path.join(stage,'RELEASE_SHA'),commit+'\n'); fs.renameSync(stage,dest);
  } finally {
    if(fs.existsSync(stage)) fs.rmSync(stage,{recursive:true,force:true});
  }
}
function setCurrent(target) {
  const temp=path.join(layout.app,'.publish-'+randomUUID()); fs.symlinkSync(target,temp); fs.renameSync(temp,current);
}
function stop() { run('systemctl',['stop',layout.pa]); run('systemctl',['stop',layout.worker]); }
function start() {
  for(const unit of [layout.worker, layout.pa]) {
    if(run('systemctl',['show',unit,'-p','ActiveState','--value']).trim()==='failed') run('systemctl',['reset-failed',unit]);
    run('systemctl',['start',unit]);
  }
}
function gate(mode) {
  if(mode===null) { fs.rmSync(layout.gate,{force:true}); }
  else {
    fs.writeFileSync(layout.gate+'.next',mode+'\n',{mode:0o644,flush:true});
    fs.chmodSync(layout.gate+'.next',0o644); fs.renameSync(layout.gate+'.next',layout.gate);
  }
  const fd=fs.openSync(path.dirname(layout.gate),'r'); try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
async function verify(target, expectedState) {
  for(let i=0;i<45;i++){
    try {
      const pid=Number(run('systemctl',['show',layout.pa,'-p','MainPID','--value']).trim());
      const s=readJSON(path.join(layout.data,'qq-service/status.json'));
      if(fs.realpathSync(current)===target && pid>0 && s.pid===pid && s.codex?.enabled && !s.codex.failed &&
        (expectedState?s.state===expectedState:['ready_waiting_for_mention','QQ Gateway 已恢复','accepted','sent'].includes(s.state)) &&
        s.integrity?.length && s.integrity.every(r=>r.status==='healthy') && s.isolatedRooms?.length===0 &&
        run('systemctl',['is-active',layout.worker]).trim()==='active') return;
    } catch { /* During startup the status file can still belong to the previous PID. */ }
    await sleep(1000);
  }
  throw Error('新版未通过服务和 QQ 就绪检查。');
}
function ensureWorkerIdle() {
  if(!fs.existsSync(layout.workerState)) return;
  if(readJSON(layout.workerState).tasks.some(t=>['queued','running'].includes(t.status))) throw Error('Codex 仍有任务待执行，请在任务结束后重新确认。');
}
function backup() {
  const snap=JSON.parse(run('/opt/node-v24.15.0/bin/node',[layout.storage,'backup'],{timeout:600000}).trim());
  if(path.dirname(snap.path)!==layout.snapshots || snap.release!==source) throw Error('备份回执与基线不一致。');
  return snap.path;
}
function restoreData() {
  const snapshot=state.snapshot;
  if(path.dirname(snapshot)!==layout.snapshots) throw Error('回滚快照路径无效。');
  const m=readJSON(path.join(snapshot,'manifest.json')), archive=path.join(snapshot,'data.tar.gz');
  if(m.release!==source || run('sha256sum',[archive]).split(' ')[0]!==m.files['data.tar.gz']) throw Error('回滚快照校验失败。');
  const quarantine=path.join(dir,'candidate-data');
  if(fs.existsSync(quarantine)&&fs.existsSync(layout.data)) return;
  const staging=fs.mkdtempSync(path.join(path.dirname(layout.data),'.pa-restore-'));
  try {
    run('chown',[layout.dataUser,staging]);
    const fd=fs.openSync(archive,'r');
    try { run('runuser',['-u',layout.dataUser,'--','tar','--no-same-owner','--no-same-permissions','-xzf','-','-C',staging],
      {stdio:[fd,'pipe','pipe'],timeout:300000}); } finally { fs.closeSync(fd); }
    const recovered=path.join(staging,path.basename(layout.data));
    if(!fs.statSync(path.join(recovered,'pa.sqlite')).isFile()) throw Error('快照缺少 PA 数据。');
    if(fs.existsSync(layout.data)) fs.renameSync(layout.data,quarantine);
    fs.renameSync(recovered,layout.data);
  } finally {fs.rmSync(staging,{recursive:true,force:true});}
}
async function rollback(reason) {
  const currentReal=fs.realpathSync(current);
  if(currentReal!==previous && currentReal!==path.join(releases,state.commit) &&
    (!state.revertCommit || currentReal!==path.join(releases,state.revertCommit))) throw Error('人工发布改变了当前版本，需要运维核对。');
  if(state.phase!=='rollback') phase('rollback',{reason, restore: Boolean(state.snapshot && currentReal!==previous)});
  if(!state.localRestored) {
    stop();
    if(state.restore) restoreData();
    setCurrent(previous); gate(null); start(); await verify(previous);
    phase('rollback',{localRestored:true});
  }
  // If a push was already observed before interruption, undo only our change.
  // Never rewrite shared history; a concurrent branch update is left for the owner.
  let restored=previous, gitNote='';
  if(state.pushAttempted){
    const remote=remoteHead();
    if(remote===state.commit || (state.revertCommit && remote===state.revertCommit)){
      if(!state.revertCommit) {
        const revert=git(['-c','user.name=PA Release','-c','user.email=pa-release@users.noreply.github.com',
          'commit-tree',git(['rev-parse',source+'^{tree}']).trim(),'-p',state.commit,'-m','Revert PA release '+state.commit]).trim();
        phase('rollback',{revertCommit:revert});
      }
      if(remote===state.commit) git(['push',layout.github,state.revertCommit+':refs/heads/'+layout.branch]);
      restored=path.join(releases,state.revertCommit);
      if(!fs.existsSync(restored)){
        const temp=fs.mkdtempSync(path.join(releases,'.revert-')); fs.chmodSync(temp,0o755);
        run('cp',['-a','--reflink=auto',previous+'/.',temp]); fs.writeFileSync(path.join(temp,'RELEASE_SHA'),state.revertCommit+'\n');
        fs.renameSync(temp,restored);
      }
      gitNote='GitHub 已用一个回退提交恢复原代码。';
    } else if(remote!==source) gitNote='GitHub 已有其他更新，未改写该分支。';
  }
  if(fs.realpathSync(current)!==restored) {
    ensureWorkerIdle(); setCurrent(restored); run('systemctl',['restart',layout.worker]);
  }
  await verify(restored);
  finish('rolled_back',`发布未成功，已恢复原版本 ${source.slice(0,8)} 并确认 QQ 就绪。${gitNote}${state.reason}`);
}
async function main() {
  if(fs.existsSync(resultPath)) return;
  if(state.phase==='rollback') { await rollback(state.reason); return; }
  if(state.phase==='committed') {await finishCommitted(); return;}
  if(['stopping','switching'].includes(state.phase)) { await rollback('发布进程曾中断。'); return; }
  try {
    if(state.phase==='prepare') {
      ensureWorkerIdle();
      const {commit,names}=prepareCommit(); build(commit,names); phase('built',{commit});
    }
    if(state.phase==='built'){
      if(fs.realpathSync(current)!==previous || remoteHead()!==source) throw Error('线上或 GitHub 版本已变化，请重新核实。');
      ensureWorkerIdle(); phase('stopping'); gate('hold'); run('systemctl',['stop',layout.pa]); ensureWorkerIdle();
      run('systemctl',['stop',layout.worker]); const snapshot=backup();
      phase('switching',{snapshot}); setCurrent(path.join(releases,state.commit)); start(); await verify(path.join(releases,state.commit),'publish_standby_ready');
      gate('activate'); await verify(path.join(releases,state.commit),'publish_activation_ready');
      gate('opening'); await verify(path.join(releases,state.commit),'publish_open_ready');
      phase('promoting');
    }
  } catch(error) {
    const reason=error instanceof Error && !error.message.startsWith('Command failed:')?error.message:
      `发布阶段 ${state.phase} 的命令失败。请查看独立发布服务日志。`;
    if(['stopping','switching'].includes(state.phase)) {await rollback(reason);return;}
    finish('failed',reason);return;
  }
  if(state.phase!=='promoting') throw Error('发布阶段无效。');
  try {await verify(path.join(releases,state.commit),'publish_open_ready');}
  catch {await rollback('推送前重新核验运行状态失败。'); return;}
  // Reconcile before repeating a Git write. A lost response can mean GitHub already accepted the commit.
  let remote=remoteHead();
  if(remote===source){
    phase('promoting',{pushAttempted:true});
    try {git(['push',layout.github,state.commit+':refs/heads/'+layout.branch]);}
    catch { /* Inspect the remote ref rather than assuming a rejected push. */ }
    remote=remoteHead();
  }
  if(remote!==state.commit){
    git(['fetch','--no-tags',layout.github,'refs/heads/'+layout.branch]);
    let included=false;try{git(['merge-base','--is-ancestor',state.commit,'FETCH_HEAD']);included=true;}catch{}
    if(!included){await rollback('GitHub 未接受该候选提交，分支没有被强制覆盖。');return;}
  }
  try {await verify(path.join(releases,state.commit),'publish_open_ready');}
  catch {await rollback('GitHub 确认期间候选失去就绪状态。');return;}
  phase('committed'); await finishCommitted();
}
async function finishCommitted(){
  if(fs.realpathSync(current)!==path.join(releases,state.commit)) throw Error('当前版本已变化，需要核对。');
  if(fs.existsSync(layout.gate)){
    try {await verify(path.join(releases,state.commit),'publish_open_ready');}
    catch {await rollback('最终放行业务前候选未就绪。');return;}
    gate(null);
  }
  // Full startup and GitHub promotion are committed before admitting the first live user operation.
  // After handover, never overwrite newly accepted business data to recover a lost result.
  await verify(path.join(releases,state.commit));
  finish('succeeded',`已发布 ${state.commit.slice(0,8)}，GitHub 已收到对应提交，PA 和 QQ 已通过就绪检查。`);
  try {run('/opt/node-v24.15.0/bin/node',[layout.storage,'prune','--apply'],{timeout:300000});}
  catch {console.error('发布已完成，备份保留巡检需要复查。');}
}
await main();
