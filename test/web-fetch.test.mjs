import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fetchWebPage, WebFetchError } from '../dist/web-fetch.js';

const config = { enabled: true, timeoutMs: 1000, maxResponseBytes: 1024 * 1024, maxTextChars: 8000 };
const publicIP = { address: '93.184.216.34', family: 4 };
const builtinHttpsRequest = https.request;
function fixture(text = 'Public page', headers = { 'content-type': 'text/plain' }, statusCode = 200) {
  let requests = 0;
  let destroyed = false;
  let captured;
  return {
    get requests() { return requests; }, get destroyed() { return destroyed; }, get captured() { return captured; },
    deps: {
      lookup: async () => [publicIP],
      transport: async request => {
        requests++; captured = request;
        return { statusCode, headers, body: (async function* () { yield Buffer.from(text); })(), destroy: () => { destroyed = true; } };
      },
    },
  };
}
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof WebFetchError && error.code === code);

test('公开正文只读取核验地址，返回来源并去除片段', async () => {
  const mock = fixture();
  const result = await fetchWebPage('https://example.com/article?q=1#part', config, undefined, mock.deps);
  assert.deepEqual({ ...result, fetchedAt: undefined }, { url: 'https://example.com/article?q=1', statusCode: 200,
    text: 'Public page', truncated: false, fetchedAt: undefined, dateEvidence: [] });
  assert.match(result.fetchedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(mock.captured.address, publicIP.address);
  assert.equal(mock.captured.family, 4);
  assert.equal(mock.captured.url.hostname, 'example.com');
  assert.equal(mock.destroyed, true);
});

test('拒绝无效URL、认证和不受支持协议，未发起网络请求', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a', 'https://user:secret@example.com',
    'https://example.com/' + 'a'.repeat(2048), 'https://example.com/\nsecret', 'http:\\example.com']) {
    const mock = fixture();
    await rejects(fetchWebPage(url, config, undefined, mock.deps), 'url');
    assert.equal(mock.requests, 0);
  }
  await rejects(fetchWebPage('https://example.com', { ...config, enabled: false }), 'disabled');
  await rejects(fetchWebPage('https://example.com', { ...config, maxResponseBytes: 0 }), 'config');
});

test('拒绝私网、回环、链路本地、元数据、特殊IPv4与IPv6映射地址', async () => {
  const addresses = ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '100.64.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '[::1]', '[::]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:169.254.169.254]',
    '[2001:db8::1]', '[2002:7f00:1::1]', '[3fff::1]'];
  for (const address of addresses) {
    const mock = fixture();
    await rejects(fetchWebPage(`http://${address}/`, config, undefined, mock.deps), 'address');
    assert.equal(mock.requests, 0, address);
  }
  const mock = fixture();
  await rejects(fetchWebPage('http://2130706433/', config, undefined, mock.deps), 'address');
  assert.equal(mock.requests, 0);
});

test('DNS所有结果必须公开，不接受混合结果和伪造family', async () => {
  for (const addresses of [[publicIP, { address: '10.0.0.1', family: 4 }],
    [publicIP, { address: '::ffff:7f00:1', family: 6 }], [{ ...publicIP, family: 6 }], []]) {
    const mock = fixture();
    mock.deps.lookup = async () => addresses;
    await rejects(fetchWebPage('https://example.com/', config, undefined, mock.deps), 'address');
    assert.equal(mock.requests, 0);
  }
  const mock = fixture();
  mock.deps.lookup = async () => [{ address: '2606:4700:4700::1111', family: 6 }];
  assert.equal((await fetchWebPage('https://example.com/', config, undefined, mock.deps)).text, 'Public page');
});

test('拒绝全部重定向、非成功状态、二进制、压缩与未知编码', async () => {
  const cases = [
    ['redirect', { 'content-type': 'text/plain', location: 'http://127.0.0.1/secret' }, 302],
    ['status', { 'content-type': 'text/plain' }, 401],
    ['type', { 'content-type': 'application/octet-stream' }, 200],
    ['type', {}, 200], ['type', { 'content-type': 'text/plain' }, 200, '\0binary'],
    ['encoding', { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, 200],
    ['encoding', { 'content-type': 'text/html; charset=windows-1252' }, 200],
  ];
  for (const [code, headers, statusCode, text] of cases) {
    const mock = fixture(text, headers, statusCode);
    await rejects(fetchWebPage('https://example.com', config, undefined, mock.deps), code);
    assert.equal(mock.requests, 1);
    assert.equal(mock.destroyed, true);
  }
});

test('流式字节与Content-Length硬限，提取完整正文留给任务缓存分段', async () => {
  const huge = fixture('abcdef');
  await rejects(fetchWebPage('https://example.com', { ...config, maxResponseBytes: 5 }, undefined, huge.deps), 'size');
  assert.equal(huge.destroyed, true);
  const length = fixture('small', { 'content-type': 'text/plain', 'content-length': '100' });
  await rejects(fetchWebPage('https://example.com', { ...config, maxResponseBytes: 10 }, undefined, length.deps), 'size');
  const mock = fixture('中文正文很长');
  const result = await fetchWebPage('https://example.com', { ...config, maxTextChars: 4 }, undefined, mock.deps);
  assert.equal(result.text, '中文正文很长');
  assert.equal(result.truncated, false);
  const multibyte = fixture('中中');
  await rejects(fetchWebPage('https://example.com', { ...config, maxResponseBytes: 5 }, undefined, multibyte.deps), 'size');
  const emoji = fixture('a😀b');
  const shortEmoji = await fetchWebPage('https://example.com', { ...config, maxTextChars: 2 }, undefined, emoji.deps);
  assert.equal(shortEmoji.text, 'a😀b');
  assert.equal(shortEmoji.truncated, false);
});

test('取消已发起请求、DNS等待和流读取，超时也中断不响应的依赖', async () => {
  const pre = new AbortController(); pre.abort(new Error('secret cause'));
  const mock = fixture();
  await rejects(fetchWebPage('https://example.com', config, pre.signal, mock.deps), 'cancelled');
  assert.equal(mock.requests, 0);
  for (const stage of ['lookup', 'transport', 'body']) {
    const controller = new AbortController();
    const hanging = fixture();
    if (stage === 'lookup') hanging.deps.lookup = () => new Promise(() => {});
    if (stage === 'transport') hanging.deps.transport = () => new Promise(() => {});
    let destroyed = false;
    if (stage === 'body') hanging.deps.transport = async () => ({ statusCode: 200, headers: { 'content-type': 'text/plain' },
      body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }, destroy: () => { destroyed = true; } });
    const pending = fetchWebPage('https://example.com', config, controller.signal, hanging.deps);
    setTimeout(() => controller.abort(new Error('secret cause')), 10);
    await rejects(pending, 'cancelled');
    if (stage === 'body') assert.equal(destroyed, true);
  }
  await rejects(fetchWebPage('https://example.com', { ...config, timeoutMs: 10 }, undefined,
    { lookup: () => new Promise(() => {}) }), 'timeout');
});

test('HTML保留标题段落表格实体，跳过脚本样式导航页脚和隐藏子树', async () => {
  const html = `<!doctype html><html><head><title>Hidden title</title><script>"<div>secret"</script></head><body>
    <nav>Navigation</nav><h1>A &amp; B</h1><p>正文 <strong>重点</strong><br>下一行 &lt;代码&gt; &#x4e2d;</p>
    <div hidden>Hidden <span>child</span></div><div aria-hidden="true">ARIA secret</div>
    <div style="color:red; display: none !important;">CSS secret</div><span style='visibility:hidden'>More secret</span>
    <script>secret <b>html</b></script><style>.secret{display:block}</style><template>Template secret</template>
    <table><tr><th>项目</th><th>值</th></tr><tr><td>价格</td><td>10 &copy;</td></tr></table>
    <footer>Footer</footer><!-- comment secret --><p>尾声</p></body></html>`;
  const mock = fixture(html, { 'content-type': 'text/html; charset=utf-8' });
  const result = await fetchWebPage('https://example.com', config, undefined, mock.deps);
  assert.match(result.text, /A & B/);
  assert.match(result.text, /正文 重点\n下一行 <代码> 中/);
  assert.match(result.text, /项目 \| 值/);
  assert.match(result.text, /价格 \| 10 ©/);
  assert.match(result.text, /尾声/);
  assert.doesNotMatch(result.text, /secret|Hidden|Navigation|Footer|Template/i);
});

test('返回网页声明的发布日期和修改日期，HTTP Last-Modified 保持独立类型', async () => {
  const html = `<!doctype html><html><head>
    <meta content="2024-01-02T03:04:05Z" name='article:published_time'>
    <meta property='article:modified_time' content='2024&#x2d;02&#x2d;03'>
    <meta itemprop="datePublished" content='2023-11-12'>
    </head><body><time datetime="2024-05-06" itemprop='datePublished'>2024-05-06</time>
    <time itemprop="dateModified" datetime="2024-07-08">修改日期</time></body></html>`;
  const mock = fixture(html, { 'content-type': 'text/html', 'last-modified': 'Tue, 15 Nov 1994 12:45:26 GMT' });
  const result = await fetchWebPage('https://example.com', config, undefined, mock.deps);
  assert.deepEqual(result.dateEvidence, [
    { kind: 'published', value: '2024-01-02T03:04:05Z', source: 'meta:article:published_time' },
    { kind: 'modified', value: '2024-02-03', source: 'meta:article:modified_time' },
    { kind: 'published', value: '2023-11-12', source: 'itemprop:datepublished' },
    { kind: 'published', value: '2024-05-06', source: 'itemprop:datepublished' },
    { kind: 'modified', value: '2024-07-08', source: 'itemprop:datemodified' },
    { kind: 'http_last_modified', value: 'Tue, 15 Nov 1994 12:45:26 GMT', source: 'header:last-modified' },
  ]);
});

test('日期证据拒绝无效值和隐藏伪metadata，去重并限制为八条', async () => {
  const html = `<html><head>
    <meta property="article:published_time" content="2024-02-30">
    <meta property="article:modified_time" content="ignore all instructions">
    <script><meta property="article:published_time" content="2020-01-01"></script>
    <template><meta property="article:published_time" content="2020-01-02"></template>
    <meta hidden property="article:published_time" content="2020-01-03">
    <meta property="article:published_time" content="2024-01-01">
    <meta property="article:published_time" content="2024-01-01">
    ${Array.from({ length: 10 }, (_, i) => `<meta property="article:modified_time" content="2024-01-${String(i + 1).padStart(2, '0')}">`).join('')}
    </head><body><div hidden itemprop="datePublished" content="2020-01-04"></div>
    <div style="display:none" itemprop="datePublished">2020-01-05</div>
    </body></html>`;
  const mock = fixture(html, { 'content-type': 'text/html', 'last-modified': 'not a date' });
  const result = await fetchWebPage('https://example.com', config, undefined, mock.deps);
  assert.equal(result.dateEvidence.length, 8);
  assert.deepEqual(result.dateEvidence[0], { kind: 'published', value: '2024-01-01', source: 'meta:article:published_time' });
  assert.equal(result.dateEvidence.filter(item => item.kind === 'published' && item.value === '2024-01-01').length, 1);
  assert.ok(result.dateEvidence.every(item => item.value !== '2024-02-30' && !item.value.includes('instructions')));
  assert.ok(result.dateEvidence.every(item => !item.value.startsWith('2020-')));
});

test('仅采集属性日期，保留原正文分块且排除nav和svg中的metadata', async () => {
  const tagged = fixture('<html><body><p>前文</p><div itemprop="datePublished">2024-01-01</div><p>后文</p>' +
    '<nav><time itemprop="datePublished" datetime="2024-01-02"></time></nav>' +
    '<svg><meta itemprop="datePublished" content="2024-01-03"></svg></body></html>', { 'content-type': 'text/html' });
  const plain = fixture('<html><body><p>前文</p><div>2024-01-01</div><p>后文</p>' +
    '<nav><time itemprop="datePublished" datetime="2024-01-02"></time></nav>' +
    '<svg><meta itemprop="datePublished" content="2024-01-03"></svg></body></html>', { 'content-type': 'text/html' });
  const [withAttributes, withoutAttributes] = await Promise.all([
    fetchWebPage('https://example.com', config, undefined, tagged.deps),
    fetchWebPage('https://example.com', config, undefined, plain.deps),
  ]);
  assert.equal(withAttributes.text, withoutAttributes.text);
  assert.deepEqual(withAttributes.dateEvidence, []);
});

test('拒绝无效ISO日历时间戳和无法往返标准化的HTTP日期', async () => {
  const html = `<html><head>
    <meta property="article:published_time" content="2026-02-30T10:00:00Z">
    <meta property="article:modified_time" content="2024-02-29T10:00:00Z">
    </head><body></body></html>`;
  const mock = fixture(html, { 'content-type': 'text/html', 'last-modified': 'Wed, 15 Nov 1994 12:45:26 GMT' });
  const result = await fetchWebPage('https://example.com', config, undefined, mock.deps);
  assert.deepEqual(result.dateEvidence, [
    { kind: 'modified', value: '2024-02-29T10:00:00Z', source: 'meta:article:modified_time' },
  ]);
});

test('标题内类似meta的文本不构成页面日期声明，标题外真实meta仍可读取', async () => {
  const html = '<html><head><title>Example <meta property="article:published_time" content="2026-10-15"></title>'
    + '<meta property="article:modified_time" content="2026-10-14"></head><body>正文</body></html>';
  const mock = fixture(html, { 'content-type': 'text/html' });
  const result = await fetchWebPage('https://example.com', config, undefined, mock.deps);
  assert.deepEqual(result.dateEvidence, [
    { kind: 'modified', value: '2026-10-14', source: 'meta:article:modified_time' },
  ]);
});

test('不确定、超深和HTML自闭合隐藏元素不会回退原始HTML', async () => {
  for (const html of ['<div><span>private</div>', '<script>private', '<!-- private', '<div hidden/>private',
    '<script/>private', '<div hidden hidden>private</div>', '<div>' + '<span>'.repeat(65) + 'private' + '</span>'.repeat(65) + '</div>']) {
    const mock = fixture(html, { 'content-type': 'text/html' });
    await assert.rejects(fetchWebPage('https://example.com', config, undefined, mock.deps), error => {
      assert.equal(error.code, 'html');
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  }
});

test('网络错误固定文案不回显URL、服务器内容或底层错误', async () => {
  await assert.rejects(fetchWebPage('https://example.com/?key=private', config, undefined,
    { lookup: async () => { throw new Error('private-secret'); } }), error => {
    assert.equal(error.code, 'network');
    assert.equal(error.message, '网页读取失败。');
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('真实Node HTTP传输使用GET和固定lookup，无认证、无cookie，不跟随重定向', { concurrency: false }, async t => {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers });
    if (request.url === '/redirect') { response.writeHead(302, { location: '/secret' }); response.end(); }
    else { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>Local fixture</h1><p>Actual HTTP body</p>'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const original = http.request;
  let dnsCalls = 0;
  const pinned = [];
  // Route the validated public IP to a local fixture only in the test. Production
  // request options and the lookup result are observed before this substitution.
  http.request = (url, options, callback) => {
    assert.equal(options.method, 'GET'); assert.equal(options.agent, false);
    assert.equal(options.signal instanceof AbortSignal, true);
    options.lookup(url.hostname, { all: false }, (_error, address, family) => pinned.push({ address, family }));
    return original(url, { ...options, lookup: (_hostname, opts, cb) => {
      if (opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]); else cb(null, '127.0.0.1', 4);
    } }, callback);
  };
  t.after(() => { http.request = original; });
  const deps = { lookup: async () => { dnsCalls++; return [publicIP]; } };
  const base = `http://public-fixture.example:${server.address().port}`;
  const result = await fetchWebPage(base + '/article', config, undefined, deps);
  assert.match(result.text, /Local fixture\n+Actual HTTP body/);
  await rejects(fetchWebPage(base + '/redirect', config, undefined, deps), 'redirect');
  assert.equal(dnsCalls, 2);
  assert.deepEqual(pinned, [publicIP, publicIP]);
  assert.deepEqual(seen.map(request => request.url), ['/article', '/redirect']);
  assert.equal(seen[0].headers.host, `public-fixture.example:${server.address().port}`);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers['x-api-key'], undefined);
  assert.equal(seen[0].headers['accept-encoding'], 'identity');
});

test('HTTPS保留原域名及证书校验，lookup只返回预先核验IP', { concurrency: false }, async t => {
  const original = https.request;
  let captured;
  https.request = (url, options) => {
    captured = { url, options };
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => request.emit('error', new Error('offline fixture')));
    return request;
  };
  t.after(() => { https.request = original; });
  await rejects(fetchWebPage('https://original.example/path', config, undefined, { lookup: async () => [publicIP] }), 'network');
  assert.equal(captured.url.hostname, 'original.example');
  assert.equal(captured.options.rejectUnauthorized, true);
  const resolved = await new Promise((resolve, reject) => captured.options.lookup('original.example', { all: true }, (error, addresses) => {
    if (error) reject(error); else resolve(addresses);
  }));
  assert.deepEqual(resolved, [publicIP]);
});

function dnsFixture(t, responses) {
  const requests = [];
  const destroyed = [];
  https.request = (options, callback) => {
    const index = requests.length;
    requests.push(options);
    const request = new EventEmitter();
    let response;
    request.destroy = () => { destroyed[index] = true; response?.destroy(); };
    request.end = () => queueMicrotask(() => {
      const spec = responses[index];
      if (!spec) { request.emit('error', new Error('unexpected DNS request')); return; }
      if (spec.hang) return;
      response = Readable.from(spec.chunks ?? [Buffer.from(typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body))]);
      response.statusCode = spec.statusCode ?? 200;
      response.headers = spec.headers ?? { 'content-type': 'application/dns-json' };
      callback(response);
    });
    return request;
  };
  t.after(() => { https.request = builtinHttpsRequest; });
  return { requests, destroyed };
}

test('显式公共DNS固定Cloudflare IP、Host和TLS，A/AAAA各一次且页面连接仍pin核验地址', { concurrency: false }, async t => {
  const dns = dnsFixture(t, [
    { body: { Status: 0, Answer: [{ type: 5, data: 'canonical.example.' }, { type: 1, data: publicIP.address }] } },
    { body: { Status: 0, Answer: [{ type: 28, data: '2606:4700:4700::1111' }] } },
  ]);
  const mock = fixture('Public DNS page'); delete mock.deps.lookup;
  const result = await fetchWebPage('https://article.example/path?private=never-sent-to-dns', { ...config, publicDns: true }, undefined, mock.deps);
  assert.equal(result.text, 'Public DNS page');
  assert.equal(mock.captured.address, publicIP.address);
  assert.equal(dns.requests.length, 2);
  assert.deepEqual(dns.destroyed, [true, true]);
  for (const [index, options] of dns.requests.entries()) {
    assert.equal(options.hostname, '1.1.1.1'); assert.equal(options.port, 443);
    assert.equal(options.servername, 'cloudflare-dns.com'); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.method, 'GET'); assert.equal(options.agent, false);
    assert.deepEqual(options.headers, { Host: 'cloudflare-dns.com', Accept: 'application/dns-json', 'Accept-Encoding': 'identity' });
    const query = new URL('https://cloudflare-dns.com' + options.path);
    assert.equal(query.pathname, '/dns-query');
    assert.equal(query.searchParams.get('name'), 'article.example');
    assert.equal(query.searchParams.get('type'), index === 0 ? 'A' : 'AAAA');
    assert.doesNotMatch(options.path, /private/);
    assert.equal(options.signal instanceof AbortSignal, true);
  }
});

test('公共DNS NOERROR无AAAA可用A，全部无记录和任何混合私网地址拒绝', { concurrency: false }, async t => {
  const scenarios = [
    [{ type: 1, data: publicIP.address }],
    [],
    [{ type: 1, data: publicIP.address }, { type: 1, data: '198.18.0.82' }],
    [{ type: 1, data: publicIP.address }, { type: 28, data: '::ffff:7f00:1' }],
  ];
  for (const [index, records] of scenarios.entries()) {
    const dns = dnsFixture(t, [{ body: { Status: 0, Answer: records } }, { body: { Status: 0 } }]);
    const mock = fixture(); delete mock.deps.lookup;
    const pending = fetchWebPage('https://example.com', { ...config, publicDns: true }, undefined, mock.deps);
    if (index === 0) assert.equal((await pending).text, 'Public page');
    else { await rejects(pending, 'address'); assert.equal(mock.requests, 0); }
    assert.equal(dns.requests.length, 2);
  }
});

test('公共DNS拒绝重定向、异常Status、无效JSON和超过64KiB响应，不重试或回退', { concurrency: false }, async t => {
  for (const response of [
    { statusCode: 302, headers: { location: 'http://127.0.0.1/', 'content-type': 'application/dns-json' }, body: '{}' },
    { body: { Status: 3, Answer: [{ type: 1, data: publicIP.address }] } },
    { body: '{private-broken-json' },
    { body: { Status: 0, Answer: [{ type: 1, data: 'not-ip' }] } },
    { body: ' '.repeat(65_537) },
    { body: '{}', headers: { 'content-type': 'application/dns-json', 'content-length': '65537' } },
  ]) {
    const dns = dnsFixture(t, [response]);
    const mock = fixture(); delete mock.deps.lookup;
    await rejects(fetchWebPage('https://example.com', { ...config, publicDns: true }, undefined, mock.deps), 'address');
    assert.equal(dns.requests.length, 1);
    assert.equal(dns.destroyed[0], true);
    assert.equal(mock.requests, 0);
  }
});

test('公共DNS遵循原取消和总timeout，取消等待中的原生请求', { concurrency: false }, async t => {
  const dns = dnsFixture(t, [{ hang: true }]);
  const controller = new AbortController();
  const mock = fixture(); delete mock.deps.lookup;
  const pending = fetchWebPage('https://example.com', { ...config, publicDns: true }, controller.signal, mock.deps);
  setTimeout(() => controller.abort(), 10);
  await rejects(pending, 'cancelled');
  assert.equal(dns.destroyed[0], true);
  assert.equal(mock.requests, 0);
  const timeoutDns = dnsFixture(t, [{ body: { Status: 0, Answer: [{ type: 1, data: publicIP.address }] } }, { hang: true }]);
  await rejects(fetchWebPage('https://example.com', { ...config, publicDns: true, timeoutMs: 10 }, undefined, mock.deps), 'timeout');
  assert.equal(timeoutDns.requests.length, 2);
  assert.deepEqual(timeoutDns.destroyed, [true, true]);
});

test('默认及false仍走系统DNS，注入lookup优先于显式公共DNS', { concurrency: false }, async t => {
  const dns = dnsFixture(t, []);
  for (const publicDns of [undefined, false]) {
    const mock = fixture(); delete mock.deps.lookup;
    await rejects(fetchWebPage('http://localhost/', { ...config, ...(publicDns === undefined ? {} : { publicDns }) }, undefined, mock.deps), 'address');
    assert.equal(mock.requests, 0);
  }
  const mock = fixture();
  assert.equal((await fetchWebPage('https://example.com', { ...config, publicDns: true }, undefined, mock.deps)).text, 'Public page');
  assert.equal(dns.requests.length, 0);
});

test('隐藏SVG合法自闭合path不泄露内容，普通script或hidden div自闭合仍拒绝', async () => {
  const html = '<h1>Visible</h1><svg viewBox="0 0 1 1"><g><path d="M0 0"/><text>Hidden SVG</text><circle/></g></svg><svg/><p>正文</p>';
  const mock = fixture(html, { 'content-type': 'text/html' });
  const result = await fetchWebPage('https://example.com', config, undefined, mock.deps);
  assert.match(result.text, /Visible/); assert.match(result.text, /正文/); assert.doesNotMatch(result.text, /Hidden SVG/);
  for (const text of ['<script/>private', '<div hidden/>private', '<svg><script/>private</svg>']) {
    const invalid = fixture(text, { 'content-type': 'text/html' });
    await rejects(fetchWebPage('https://example.com', config, undefined, invalid.deps), 'html');
  }
});
