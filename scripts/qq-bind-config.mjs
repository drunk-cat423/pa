import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const QQ_KEYS = new Set(['PA_QQ_APP_ID', 'PA_QQ_APP_SECRET']);

export function mergeCredentials(contents, credentials) {
  if (!credentials || !/^\d{1,32}$/.test(credentials.appId)
    || typeof credentials.appSecret !== 'string' || !credentials.appSecret
    || /[\r\n\0"\\]/.test(credentials.appSecret)) {
    throw new Error('官方回传的凭证格式无效，未保存。');
  }
  const original = parseEnv(contents);
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const values = { PA_QQ_APP_ID: credentials.appId, PA_QQ_APP_SECRET: credentials.appSecret };
  const seen = new Set();
  const lines = contents.split(/\r?\n/).map(line => {
    const key = line.match(/^\s*(?:export\s+)?(PA_QQ_APP_ID|PA_QQ_APP_SECRET)\s*=/)?.[1];
    if (!key) return line;
    if (seen.has(key)) throw new Error('本地 QQ 配置包含重复字段，未保存。');
    seen.add(key);
    return `${key}="${values[key]}"`;
  });
  for (const key of QQ_KEYS) if (!seen.has(key)) lines.push(`${key}="${values[key]}"`);
  const result = `${lines.join(newline).replace(/(?:\r?\n)*$/, '')}${newline}`;
  const parsed = parseEnv(result);
  const remainingKeys = Object.keys(parsed).filter(key => !QQ_KEYS.has(key));
  const originalKeys = Object.keys(original).filter(key => !QQ_KEYS.has(key));
  if (originalKeys.length !== remainingKeys.length
    || originalKeys.some(key => parsed[key] !== original[key])
    || Object.keys(values).some(key => parsed[key] !== values[key])) {
    throw new Error('配置保存会影响其他字段，已停止且未修改原文件。');
  }
  return result;
}

export function saveCredentials(envPath, credentials) {
  let contents = '';
  try { contents = readFileSync(envPath, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取本地配置，未保存。');
  }
  const result = mergeCredentials(contents, credentials);
  const temporary = join(dirname(envPath), `.env.qq-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, result, { flag: 'wx', mode: 0o600 });
    let current = '';
    try { current = readFileSync(envPath, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== contents) throw new Error('配置在保存期间被修改，已停止。');
    renameSync(temporary, envPath);
  } catch {
    throw new Error('本地配置保存失败；原配置未主动覆盖，请重新绑定。');
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw new Error('临时配置清理失败。'); }
  }
}
