import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export interface WebFetchConfig {
  enabled: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  maxTextChars: number;
  publicDns?: boolean;
}

export interface WebFetchResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy?: () => void;
}

export interface WebFetchDeps {
  lookup?: (hostname: string, signal: AbortSignal) => Promise<{ address: string; family: number }[]>;
  transport?: (request: { url: URL; address: string; family: number; signal: AbortSignal }) => Promise<WebFetchResponse>;
}

type Failure = 'disabled' | 'config' | 'url' | 'address' | 'redirect' | 'status' | 'type' | 'size' | 'html' | 'encoding' | 'cancelled' | 'timeout' | 'network';
const messages: Record<Failure, string> = {
  disabled: '网页读取未启用。', config: '网页读取配置无效。', url: '网页地址无效或不受支持。',
  address: '网页地址必须指向公开网络。', redirect: '网页读取不支持重定向。', status: '网页返回了不支持的状态。',
  type: '网页内容类型不受支持。', size: '网页响应超过大小限制。', html: '网页结构无法安全解析。',
  encoding: '网页文本编码不受支持。', cancelled: '网页读取已取消。', timeout: '网页读取超时。', network: '网页读取失败。',
};

export class WebFetchError extends Error {
  constructor(readonly code: Failure) { super(messages[code]); this.name = 'WebFetchError'; }
}

function fail(code: Failure): never { throw new WebFetchError(code); }

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%') || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const first = Number.parseInt(words[0] ?? '0', 16);
  const second = Number.parseInt(words[1] ?? '0', 16);
  // Only global unicast, excluding special-use, documentation and IPv4 transition ranges.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
    && !(first === 0x2001 && (second < 0x0200 || second === 0x0db8))
    && !(first === 0x3fff && second < 0x1000);
}

function parseUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) fail('url');
  let url: URL;
  try { url = new URL(value); } catch { return fail('url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) fail('url');
  url.hash = '';
  return url;
}

function nativeTransport(request: { url: URL; address: string; family: number; signal: AbortSignal }): Promise<WebFetchResponse> {
  return new Promise((resolve, reject) => {
    const client = request.url.protocol === 'https:' ? https : http;
    const req = client.request(request.url, {
      method: 'GET', agent: false, signal: request.signal, rejectUnauthorized: true,
      headers: { Accept: 'text/html, text/plain, application/xhtml+xml', 'Accept-Encoding': 'identity' },
      // Keep URL hostname for Host and TLS verification; never resolve again at connection time.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: request.address, family: request.family }]);
        else callback(null, request.address, request.family);
      },
    }, response => resolve({
      statusCode: response.statusCode ?? 0, headers: response.headers, body: response,
      destroy: () => { response.destroy(); req.destroy(); },
    }));
    req.on('error', reject);
    req.end();
  });
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function publicDnsLookup(hostname: string, signal: AbortSignal): Promise<{ address: string; family: number }[]> {
  const addresses: { address: string; family: number }[] = [];
  // Explicit deployment option, never a fallback after a system DNS rejection.
  for (const type of ['A', 'AAAA']) {
    if (signal.aborted) throw signal.reason;
    let request: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    try {
      response = await cancellable(new Promise<http.IncomingMessage>((resolve, reject) => {
        request = https.request({
          hostname: '1.1.1.1', port: 443, servername: 'cloudflare-dns.com',
          path: `/dns-query?${new URLSearchParams({ name: hostname, type })}`,
          method: 'GET', agent: false, rejectUnauthorized: true, signal,
          headers: { Host: 'cloudflare-dns.com', Accept: 'application/dns-json', 'Accept-Encoding': 'identity' },
        }, resolve);
        request.on('error', reject);
        request.end();
      }), signal);
      if (response.statusCode !== 200) fail('address');
      const mime = response.headers['content-type'];
      if (typeof mime !== 'string' || !['application/dns-json', 'application/json'].includes(mime.split(';')[0]!.trim().toLowerCase())) fail('address');
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') fail('address');
      const declaredSize = response.headers['content-length'];
      if (declaredSize !== undefined && (typeof declaredSize !== 'string' || !/^\d+$/.test(declaredSize) || Number(declaredSize) > 65_536)) fail('address');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const iterator = response[Symbol.asyncIterator]();
      while (true) {
        const chunk = await cancellable(iterator.next(), signal);
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) fail('address');
        size += chunk.value.byteLength;
        if (size > 65_536) fail('address');
        chunks.push(chunk.value);
      }
      let result: unknown;
      try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
      catch { return fail('address'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) fail('address');
      const record = result as { Status?: unknown; Answer?: unknown };
      if (record.Status !== 0 || (record.Answer !== undefined && !Array.isArray(record.Answer))) fail('address');
      for (const answer of record.Answer ?? []) {
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)) fail('address');
        const item = answer as { type?: unknown; data?: unknown };
        if (item.type !== 1 && item.type !== 28) continue;
        const family = item.type === 1 ? 4 : 6;
        if (typeof item.data !== 'string' || isIP(item.data) !== family) fail('address');
        addresses.push({ address: item.data, family });
      }
    } finally {
      response?.destroy();
      request?.destroy();
    }
  }
  return addresses;
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ensp: ' ', emsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-zA-Z]{2,12});/gi, (original, key: string) => {
    if (!key.startsWith('#')) return entities[key] ?? original;
    const point = key[1]?.toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '�';
  });
}

const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const skipTags = new Set('script style head nav footer template noscript svg math iframe object'.split(' '));
const rawTags = new Set(['script', 'style']);
const blockTags = new Set('address article aside blockquote div dl dt dd fieldset figcaption figure h1 h2 h3 h4 h5 h6 header hr li main ol p pre section table tbody thead tfoot tr ul'.split(' '));

function htmlText(html: string): string {
  const stack: { tag: string; hidden: boolean }[] = [];
  const output: string[] = [];
  let index = 0;
  let tokens = 0;
  const visible = () => !stack.at(-1)?.hidden;
  const boundary = (tag: string) => { if (visible() && blockTags.has(tag)) output.push('\n'); };
  while (index < html.length) {
    if (++tokens > 100_000) fail('html');
    const raw = stack.at(-1);
    if (raw && rawTags.has(raw.tag)) {
      const end = new RegExp(`</${raw.tag}\\s*>`, 'gi');
      end.lastIndex = index;
      const match = end.exec(html);
      if (!match) fail('html');
      index = end.lastIndex;
      stack.pop();
      continue;
    }
    if (html[index] !== '<') {
      const next = html.indexOf('<', index);
      const end = next === -1 ? html.length : next;
      if (visible()) output.push(decodeEntities(html.slice(index, end)));
      index = end;
      continue;
    }
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      if (end === -1) fail('html');
      index = end + 3; continue;
    }
    let end = index + 1;
    let quote = '';
    for (; end < html.length; end++) {
      const char = html[end]!;
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      if (end - index > 16_384) fail('html');
    }
    if (end === html.length || quote) fail('html');
    const source = html.slice(index + 1, end);
    index = end + 1;
    if (/^!doctype\s+html(?:\s[^<>]*)?$/i.test(source)) continue;
    const match = /^(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*)$/.exec(source);
    if (!match) fail('html');
    const closing = match[1] === '/';
    const tag = match[2]!.toLowerCase();
    let attributes = match[3]!;
    if (closing) {
      if (attributes.trim()) fail('html');
      if (voidTags.has(tag)) continue;
      const found = stack.findLastIndex(entry => entry.tag === tag);
      if (found === -1) fail('html');
      // Optional-end elements may close implicitly; other mismatches are uncertain.
      if (stack.slice(found + 1).some(entry => !['p', 'li', 'dt', 'dd', 'td', 'th', 'tr', 'tbody', 'thead', 'tfoot'].includes(entry.tag))) fail('html');
      boundary(tag);
      stack.length = found;
      continue;
    }
    if (tag === 'plaintext' || tag === 'xmp' || tag === 'textarea') fail('html');
    const top = stack.at(-1)?.tag;
    if (top && ((top === 'p' && blockTags.has(tag)) || (top === tag && ['li', 'dt', 'dd', 'tr', 'td', 'th'].includes(tag))
      || (['td', 'th'].includes(top) && ['td', 'th', 'tr'].includes(tag)))) {
      boundary(top); stack.pop();
    }
    const selfClosing = /\/\s*$/.test(attributes);
    // HTML ignores a self-closing slash on non-void elements. Do not expose text
    // that a browser would still consider inside a hidden/raw element.
    const insideSvg = tag === 'svg' || stack.some(entry => entry.tag === 'svg');
    if (selfClosing && !voidTags.has(tag) && (!insideSvg || rawTags.has(tag))) fail('html');
    if (selfClosing) attributes = attributes.replace(/\/\s*$/, '');
    const attrs = new Map<string, string>();
    const attribute = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/y;
    let offset = 0;
    while (offset < attributes.length) {
      if (!attributes.slice(offset).trim()) break;
      attribute.lastIndex = offset;
      const item = attribute.exec(attributes);
      if (!item) fail('html');
      const name = item[1]!.toLowerCase();
      if (attrs.has(name)) fail('html');
      attrs.set(name, decodeEntities(item[2] ?? item[3] ?? item[4] ?? ''));
      offset = attribute.lastIndex;
    }
    const hidden = !visible() || skipTags.has(tag) || attrs.has('hidden') || attrs.has('inert')
      || attrs.get('aria-hidden')?.trim().toLowerCase() === 'true'
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))(?:\s*!important)?\s*(?:;|$)/i.test(attrs.get('style') ?? '');
    if (!hidden) {
      boundary(tag);
      if (tag === 'br') output.push('\n');
      if (tag === 'td' || tag === 'th') output.push(' | ');
    }
    if (!voidTags.has(tag) && !selfClosing) {
      stack.push({ tag, hidden });
      if (stack.length > 64) fail('html');
    }
  }
  if (stack.some(entry => !['html', 'body', 'p', 'li', 'dt', 'dd', 'td', 'th', 'tr', 'tbody', 'thead', 'tfoot'].includes(entry.tag))) fail('html');
  return output.join('');
}

function textContent(bytes: Uint8Array, contentType: string): string {
  const charset = /;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const encoding = (charset?.[1] ?? charset?.[2] ?? 'utf-8').toLowerCase();
  if (!['utf-8', 'utf8', 'us-ascii'].includes(encoding)) fail('encoding');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('encoding'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) fail('type');
  if (contentType.split(';')[0]?.trim().toLowerCase() !== 'text/plain') text = htmlText(text);
  return text.replace(/[\t \u00a0]+/g, ' ').replace(/ *\r?\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function fetchWebPage(url: string, config: WebFetchConfig, signal?: AbortSignal, deps: WebFetchDeps = {}): Promise<{ url: string; statusCode: number; text: string; truncated: boolean }> {
  if (!config || config.enabled !== true) fail('disabled');
  if (config.publicDns !== undefined && typeof config.publicDns !== 'boolean') fail('config');
  for (const [value, limit] of [[config.timeoutMs, 120_000], [config.maxResponseBytes, 10 * 1024 * 1024], [config.maxTextChars, 100_000]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > limit) fail('config');
  }
  const parsed = parseUrl(url);
  const deadline = Date.now() + config.timeoutMs;
  const controller = new AbortController();
  const abort = () => controller.abort(new WebFetchError('cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new WebFetchError('timeout')), config.timeoutMs);
  let response: WebFetchResponse | undefined;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const literalFamily = isIP(hostname);
    const resolver = deps.lookup ?? (config.publicDns === true ? publicDnsLookup : (host: string) => lookup(host, { all: true, verbatim: true }));
    const addresses = literalFamily ? [{ address: hostname, family: literalFamily }]
      : await cancellable(resolver(hostname, controller.signal), controller.signal);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address) || isIP(item.address) !== item.family)) fail('address');
    const address = addresses[0]!;
    response = await cancellable((deps.transport ?? nativeTransport)({ url: parsed, address: address.address, family: address.family, signal: controller.signal }), controller.signal);
    if (response.statusCode >= 300 && response.statusCode < 400) fail('redirect');
    if (response.statusCode < 200 || response.statusCode >= 300) fail('status');
    const type = response.headers['content-type'];
    if (typeof type !== 'string' || !['text/html', 'text/plain', 'application/xhtml+xml'].includes(type.split(';')[0]!.trim().toLowerCase())) fail('type');
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding !== 'identity') fail('encoding');
    const length = response.headers['content-length'];
    if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > config.maxResponseBytes)) fail('size');
    const chunks: Uint8Array[] = [];
    let size = 0;
    const iterator = response.body[Symbol.asyncIterator]();
    while (true) {
      const chunk = await cancellable(iterator.next(), controller.signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) fail('type');
      size += chunk.value.byteLength;
      if (size > config.maxResponseBytes) fail('size');
      chunks.push(chunk.value);
    }
    const text = textContent(Buffer.concat(chunks, size), type);
    if (Date.now() >= deadline) fail('timeout');
    const excerpt = text.slice(0, config.maxTextChars).replace(/[\ud800-\udbff]$/, '');
    return { url: parsed.href, statusCode: response.statusCode, text: excerpt, truncated: text.length > excerpt.length };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof WebFetchError) throw error;
    throw new WebFetchError('network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    response?.destroy?.();
  }
}
