import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readConfig, readDataDir } from './config.js';
import { readQQSettings } from './qq-config.js';
import { ChannelHarness } from './channel-harness.js';
import { QQChannel } from './qq-channel.js';
import { loadHarnessPolicy } from './harness-policy.js';
import { PublishInbox, readPublicationGate } from './publish-inbox.js';

async function main(): Promise<void> {
  if (process.argv.slice(2).some(value => value !== '--check') || process.argv.length > 3) {
    throw new Error('用法：node --env-file-if-exists=.env dist/qq-cli.js [--check]');
  }
  const qq = readQQSettings();
  const keyPresent = Boolean(process.env.PA_API_KEY?.trim());
  // Check all other settings without opening a connection or calling a model.
  const config = readConfig({ ...process.env, PA_API_KEY: keyPresent ? process.env.PA_API_KEY : 'check-only' });
  const policy = await loadHarnessPolicy(config.dataDir);
  const inboxPath = process.env.PA_PUBLISH_INBOX?.trim();
  const gatePath = process.env.PA_PUBLISH_GATE_FILE?.trim();
  if (Boolean(inboxPath) !== Boolean(gatePath) || (inboxPath && (!isAbsolute(inboxPath) || !isAbsolute(gatePath!)
    || relative(resolve(config.dataDir), resolve(inboxPath)).split(/[\\/]/)[0] !== '..'))) {
    throw new Error('发布门禁需要绝对路径，收件箱必须位于 PA 数据快照目录之外。');
  }
  const gate = () => readPublicationGate(gatePath);
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ provider: config.provider, model: config.model, baseUrl: config.baseUrl,
      maxOutputTokens: config.maxOutputTokens, timeoutMs: config.timeoutMs, maxCalls: qq.maxCalls,
      allowedGroups: qq.routes.filter(route => route.roomType === 'group').length,
      allowedPrivateUsers: qq.routes.filter(route => route.roomType === 'private').length, ownerBindings: policy.ownerBindings.length,
      primaryPersonBindings: policy.primaryPerson?.bindings.length ?? 0,
      memoryEnabled: config.memory?.enabled ?? false, memoryMaxCalls: config.memory?.maxCalls ?? 0,
      searchEnabled: config.search?.enabled ?? false, searchMaxRequests: config.search?.maxRequests ?? 0,
      searchBudgetId: config.search?.budgetId,
      fetchEnabled: config.fetch?.enabled ?? false,
      qqCredentialsPresent: true, modelKeyPresent: keyPresent, ready: keyPresent }));
    process.exitCode = keyPresent ? 0 : 2;
    return;
  }
  if (!keyPresent) throw new Error('请先在本地 .env 填写 PA_API_KEY；其他接入配置已准备好。');
  const directory = join(readDataDir(), 'qq-service');
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, 'service.lock');
  const inbox = inboxPath ? new PublishInbox(inboxPath, qq.routes) : undefined;
  const lock = await open(lockPath, 'wx');
  let channel: QQChannel | undefined;
  let harness: ChannelHarness | undefined;
  let stopping: Promise<void> | undefined;
  let budgetDrain: Promise<void> | undefined;
  let statusQueue: Promise<unknown> = Promise.resolve();
  let accepting = false;
  let replay: Promise<void> | undefined;
  let activationReady = false;
  let openReady = false;
  let preparedReady = false;
  let gatewayReady = false;
  function status(state: string): void {
    console.log(`QQ harness: ${state}`);
    const snapshot = { pid: process.pid, updatedAt: new Date().toISOString(), state,
      provider: config.provider, model: config.model,
      ...(['stopped','persistence_failed'].includes(state) ? {} : (harness?.info() ?? { calls: 0, maxCalls: qq.maxCalls })) };
    statusQueue = statusQueue.then(() => writeFile(join(directory, 'status.json'), JSON.stringify(snapshot, null, 2), { mode: 0o600 }))
      .catch(() => { process.exitCode = 1; void stop(); });
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      channel?.close();
      await harness?.close();
      await replay;
    })();
    return stopping;
  }
  const signal = () => { void stop(); };
  function fail(): void { status('persistence_failed'); process.exitCode = 1; void stop(); }
  function drain(): void {
    if (!inbox || replay || !accepting || stopping || gate()) return;
    replay = (async () => {
      for (;;) {
        if (!accepting || stopping || gate()) return;
        const next = inbox.next();
        if (!next) return;
        const result = await harness!.handle(next.message, { waitForResult: false });
        if (!['accepted', 'observed', 'duplicate', 'sent'].includes(result)) throw new Error('发布收件箱消息未被持久接纳。');
        inbox.acknowledge(next.sequence);
        if (result === 'accepted') status('accepted'); else taskResult(result);
      }
    })().catch(() => { fail(); }).finally(() => { replay = undefined; });
  }
  const taskResult = (result: import('./channel-harness.js').HarnessResult): void => {
    if (result !== 'ignored' && result !== 'observed' && result !== 'duplicate') status(result);
    if (qq.maxCalls > 0 && harness!.info().calls >= qq.maxCalls && !budgetDrain) {
      budgetDrain = harness!.waitForTasks().then(async () => {
        status('test_budget_complete'); await stop();
      }).catch(() => {status('persistence_failed');process.exitCode=1;void stop();});
    }
  };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    channel = new QQChannel({ appId: qq.appId, clientSecret: qq.clientSecret }, {
      onStatus: state => {
        if (['QQ Gateway READY', 'QQ Gateway 已恢复'].includes(state)) gatewayReady = true;
        else if (['connection_failed', 'QQ 正在重连'].includes(state)) gatewayReady = false;
        const held = gate();
        status(held && preparedReady && gatewayReady ? (openReady ? 'publish_open_ready' : activationReady ? 'publish_activation_ready' : 'publish_standby_ready')
          : held ? 'publish_standby_connecting' : state);
        if (state === 'connection_failed') { process.exitCode = 1; void stop(); }
      },
      onMessage: message => {
        if (inbox) {
          try { if (inbox.capture(message)) drain(); }
          catch { fail(); }
          return;
        }
        void harness!.handle(message,{waitForResult:false}).then(result => {
          if(result==='accepted') status('accepted');
          else taskResult(result);
        }).catch(() => { status('persistence_failed'); process.exitCode = 1; void stop(); });
      },
    });
    const transport = { send: async (message: import('./channel-types.js').OutboundMessage) => {
      while (!stopping && gate()) await new Promise(resolve => setTimeout(resolve, 100));
      return stopping ? { status: 'rejected' as const } : channel!.send(message);
    } };
    harness = new ChannelHarness(config, qq.routes, transport, qq.maxCalls, policy, undefined, () => {
      status('persistence_failed'); process.exitCode = 1; void stop();
    },taskResult,{ standby: Boolean(inbox), mayRun: () => !gate() });
    await channel.start();
    if (inbox && !stopping) {
      await harness.prepare();
      const check = () => {
        const info = harness!.info();
        if (info.isolatedRooms.length || info.integrity.length !== qq.routes.length
          || info.integrity.some(room => room.status !== 'healthy')) throw new Error('发布候选未通过房间完整性检查。');
      };
      if (gate()) check();
      preparedReady = true;
      let last: string | undefined;
      while (!stopping && gate()) {
        const phase = gate();
        if (phase !== last) {
          await harness.prepare(); check();
          if (phase === 'opening') { await harness.start(); check(); }
          activationReady = phase === 'activate' || phase === 'opening';
          openReady = phase === 'opening';
          status(!gatewayReady ? 'publish_standby_connecting' : openReady ? 'publish_open_ready' : activationReady ? 'publish_activation_ready' : 'publish_standby_ready');
          await statusQueue;
          last = phase;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    // Recovered tasks may finish immediately; their transport must be READY first.
    if (!stopping) { await harness.start(); accepting = true; drain(); }
    if (stopping) await stopping;
    else status('ready_waiting_for_mention');
    // WebSocket and heartbeat keep the process alive. Cleanup is triggered by signals/budget/failure.
    await new Promise<void>(resolve => {
      const timer = setInterval(() => { if (stopping) { clearInterval(timer); resolve(); } }, 100);
    });
    await stopping;
    status('stopped');
  } finally {
    await stop();
    await statusQueue;
    inbox?.close();
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', signal);
    await lock.close();
    await unlink(lockPath);
  }
}

void main().catch(() => {
  // Do not echo SDK/transport exceptions: they can contain provider secrets or event data.
  console.error('QQ 接入未启动或已失败，请检查配置、进程锁和本地运行状态；密钥仅填写在 .env。');
  process.exitCode = 1;
});
