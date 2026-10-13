import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { saveCredentials } from './qq-bind-config.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const toolsDir = join(root, '.local', 'qq-bind-tools');
const envPath = join(root, '.env');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check') || args.length > 1) {
  console.error('用法：node scripts/qq-bind.mjs [--check]');
  process.exit(1);
}

let startQrConnect, QRCode;
try {
  const metadata = JSON.parse(readFileSync(join(toolsDir, 'node_modules', '@tencent-connect', 'qqbot-connector', 'package.json'), 'utf8'));
  if (metadata.version !== '1.2.0') throw new Error('version');
  ({ startQrConnect } = await import(pathToFileURL(join(toolsDir, 'node_modules', '@tencent-connect', 'qqbot-connector', 'dist', 'esm', 'index.js')).href));
  const require = createRequire(join(toolsDir, 'package.json'));
  QRCode = require('qrcode');
} catch {
  console.error('缺少锁定的临时工具。先执行：npm install --prefix .local/qq-bind-tools --ignore-scripts --no-audit --no-fund @tencent-connect/qqbot-connector@1.2.0 qrcode@1.5.4');
  process.exit(1);
}

if (args.includes('--check')) {
  console.log('扫码工具离线检查通过；未创建授权任务、未读取凭证、未调用模型。');
  process.exit(0);
}

const runId = randomUUID();
const directory = join(root, '.local', 'qq-bind', runId);
mkdirSync(directory, { recursive: true });
const statusPath = join(directory, 'status.json');
const qrPath = join(directory, 'qr.png');
const controller = new AbortController();
let terminal = false;
let qrWork = Promise.resolve();
let timer;

function status(state, additional = {}) {
  writeFileSync(statusPath, JSON.stringify({ runId, state, pid: process.pid, updatedAt: new Date().toISOString(), ...additional }, null, 2), { mode: 0o600 });
}

function finish(state, message, code) {
  if (terminal) return;
  terminal = true;
  clearTimeout(timer);
  controller.abort();
  try { status(state); } catch { /* No credentials are stored in the status file. */ }
  console.log(message);
  process.exitCode = code;
}

status('starting');
console.log(`绑定状态文件：${statusPath}`);
process.once('SIGINT', () => finish('cancelled', '扫码绑定已取消。', 130));
process.once('SIGTERM', () => finish('cancelled', '扫码绑定已取消。', 130));
timer = setTimeout(() => finish('timed_out', '等待扫码超时；需要时重新启动绑定工具。', 1), 15 * 60 * 1000);

startQrConnect({
  onQrDisplayed(url) {
    qrWork = qrWork.then(async () => {
      if (terminal) return;
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'q.qq.com'
        || parsed.pathname !== '/qqbot/openclaw/connect.html') throw new Error('unexpected authorization URL');
      await QRCode.toFile(qrPath, url, { width: 420, margin: 4, errorCorrectionLevel: 'M' });
      if (terminal) return;
      status('waiting_for_scan', { authorizationUrl: url, qrPath });
      console.log(`二维码：${qrPath}`);
      console.log('请用手机 QQ 扫码并完成官方授权，凭证会保存到本地 .env。');
    }).catch(() => finish('failed', '二维码生成失败，绑定已停止；未保存凭证。', 1));
  },
  onSuccess(credentials) {
    if (terminal) return;
    if (!Array.isArray(credentials) || credentials.length !== 1) {
      finish('failed', '官方回传结果无效，未保存凭证。', 1);
      return;
    }
    try {
      saveCredentials(envPath, credentials[0]);
      finish('bound', 'QQ 机器人授权成功，凭证已保存到本地 .env；未打印密钥、未发送群消息、未调用模型。', 0);
    } catch {
      finish('save_failed', 'QQ 授权已返回，但凭证保存失败。请检查本地配置权限或重复字段后重新绑定。', 1);
    }
  },
  onFailure() { finish('failed', '官方扫码绑定失败；未打印接口响应，请检查网络后重新启动。', 1); },
  onQrExpired() { finish('expired', '二维码已过期，绑定已停止；需要时重新启动。', 1); },
}, { displayQrCodeToConsole: false, signal: controller.signal });
