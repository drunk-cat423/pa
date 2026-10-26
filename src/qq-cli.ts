import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig, readDataDir } from './config.js';
import { readQQSettings } from './qq-config.js';
import { ChannelHarness } from './channel-harness.js';
import { QQChannel } from './qq-channel.js';
import { loadHarnessPolicy } from './harness-policy.js';

async function main(): Promise<void> {
  if (process.argv.slice(2).some(value => value !== '--check') || process.argv.length > 3) {
    throw new Error('用法：node --env-file-if-exists=.env dist/qq-cli.js [--check]');
  }
  const qq = readQQSettings();
  const keyPresent = Boolean(process.env.PA_API_KEY?.trim());
  // Check all other settings without opening a connection or calling a model.
  const config = readConfig({ ...process.env, PA_API_KEY: keyPresent ? process.env.PA_API_KEY : 'check-only' });
  const policy = await loadHarnessPolicy(config.dataDir);
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
  const lock = await open(lockPath, 'wx');
  let channel: QQChannel | undefined;
  let harness: ChannelHarness | undefined;
  let stopping: Promise<void> | undefined;
  let budgetDrain: Promise<void> | undefined;
  let statusQueue: Promise<unknown> = Promise.resolve();
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
    })();
    return stopping;
  }
  const signal = () => { void stop(); };
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
        status(state);
        if (state === 'connection_failed') { process.exitCode = 1; void stop(); }
      },
      onMessage: message => {
        void harness!.handle(message,{waitForResult:false}).then(result => {
          if(result==='accepted') status('accepted');
          else taskResult(result);
        }).catch(() => { status('persistence_failed'); process.exitCode = 1; void stop(); });
      },
    });
    harness = new ChannelHarness(config, qq.routes, channel, qq.maxCalls, policy, undefined, () => {
      status('persistence_failed'); process.exitCode = 1; void stop();
    },taskResult);
    await channel.start();
    // Recovered tasks may finish immediately; their transport must be READY first.
    if (!stopping) await harness.start();
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
