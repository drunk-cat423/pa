import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fetchWebPage, WebFetchError } from '../dist/web-fetch.js';

// Public test-only certificate/key, never a production credential.
const cert = readFileSync(new URL('./fixtures/web-fetch-proxy-cert.pem', import.meta.url));
const key = readFileSync(new URL('./fixtures/web-fetch-proxy-key.pem', import.meta.url));
const config = { enabled: true, timeoutMs: 2000, maxResponseBytes: 1048576, maxTextChars: 8000 };
const publicIP = '93.184.216.34';
const lookup = async () => [{ address: publicIP, family: 4 }];
const rejects = (promise, code) => assert.rejects(promise, error =>
  error instanceof WebFetchError && error.code === code && !/proxy-secret/.test(error.message));

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, sockets, port: server.address().port };
}

async function proxyFixture(t, route) {
  const requests = [];
  const server = http.createServer();
  const fixture = await listen(t, server);
  server.on('connect', (request, client, head) => {
    // CONNECT sockets are detached from HTTP's normal close handling.
    client.once('end', () => client.end());
    requests.push({ authority: request.url, host: request.headers.host });
    const port = route(request, client);
    if (!port) { client.resume(); return; }
    // This fixture deliberately maps the pinned public IP to a local test server.
    const upstream = net.connect(port, '127.0.0.1');
    upstream.on('error', () => client.destroy());
    upstream.once('close', () => client.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  return { ...fixture, requests, proxyUrl: `http://127.0.0.1:${fixture.port}` };
}

async function closed(...fixtures) {
  const deadline = Date.now() + 1000;
  while (fixtures.some(item => item.sockets.size) && Date.now() < deadline) await delay(10);
  for (const [index, item] of fixtures.entries()) assert.equal(item.sockets.size, 0,
    `fixture ${index}: all tunnel and target sockets closed; ${JSON.stringify([...item.sockets].map(socket => ({ destroyed: socket.destroyed, readyState: socket.readyState, readableEnded: socket.readableEnded, writableEnded: socket.writableEnded })))}`);
}

function trustFixture(t) {
  const original = tls.connect;
  const sockets = [];
  tls.connect = options => {
    assert.equal(options.rejectUnauthorized, true);
    const socket = original({ ...options, ca: cert });
    sockets.push(socket);
    return socket;
  };
  t.after(() => {
    tls.connect = original;
    assert.ok(sockets.every(socket => socket.destroyed), 'client TLS sockets destroyed');
  });
}

test('真实HTTPS隧道保留原Host/SNI及证书校验，拒绝未知CA和域名不匹配', async t => {
  const seen = [];
  const target = await listen(t, https.createServer({ cert, key }, (req, res) => {
    seen.push({ host: req.headers.host, servername: req.socket.servername });
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Proxy HTTPS page');
  }));
  const proxy = await proxyFixture(t, () => target.port);
  const options = { ...config, proxyUrl: proxy.proxyUrl };
  await rejects(fetchWebPage(`https://proxy-page.example:${target.port}/`, options, undefined, { lookup }), 'network');
  trustFixture(t);
  const result = await fetchWebPage(`https://proxy-page.example:${target.port}/`, options, undefined, { lookup });
  assert.equal(result.text, 'Proxy HTTPS page');
  await rejects(fetchWebPage(`https://wrong-name.example:${target.port}/`, options, undefined, { lookup }), 'network');
  assert.deepEqual(seen, [{ host: `proxy-page.example:${target.port}`, servername: 'proxy-page.example' }]);
  assert.deepEqual(proxy.requests.map(item => item.authority), Array(3).fill(`${publicIP}:${target.port}`));
  await closed(proxy, target);
});

test('publicDns的A/AAAA通过同一代理固定1.1.1.1:443，Host/SNI和页面IP继续钉住', async t => {
  trustFixture(t);
  const seenDns = [];
  let dnsAddress = publicIP;
  const dns = await listen(t, https.createServer({ cert, key }, (req, res) => {
    seenDns.push({ host: req.headers.host, servername: req.socket.servername, url: req.url });
    const type = new URL(req.url, 'https://cloudflare-dns.com').searchParams.get('type');
    res.writeHead(200, { 'content-type': 'application/dns-json' }).end(JSON.stringify({
      Status: 0, Answer: type === 'A' ? [{ type: 1, data: dnsAddress }] : [],
    }));
  }));
  const page = await listen(t, http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Resolved through proxy');
  }));
  const proxy = await proxyFixture(t, request => request.url === '1.1.1.1:443' ? dns.port : page.port);
  const result = await fetchWebPage(`http://proxy-page.example:${page.port}/private-path`,
    { ...config, publicDns: true, proxyUrl: proxy.proxyUrl });
  assert.equal(result.text, 'Resolved through proxy');
  assert.deepEqual(proxy.requests.map(item => item.authority), ['1.1.1.1:443', '1.1.1.1:443', `${publicIP}:${page.port}`]);
  assert.equal(seenDns.length, 2);
  for (const [index, request] of seenDns.entries()) {
    assert.equal(request.host, 'cloudflare-dns.com');
    assert.equal(request.servername, 'cloudflare-dns.com');
    const query = new URL(request.url, 'https://cloudflare-dns.com');
    assert.equal(query.pathname, '/dns-query');
    assert.equal(query.searchParams.get('name'), 'proxy-page.example');
    assert.equal(query.searchParams.get('type'), index === 0 ? 'A' : 'AAAA');
    assert.doesNotMatch(request.url, /private-path/);
  }
  dnsAddress = '192.168.1.1';
  await rejects(fetchWebPage(`http://proxy-page.example:${page.port}/`,
    { ...config, publicDns: true, proxyUrl: proxy.proxyUrl }), 'address');
  assert.deepEqual(proxy.requests.slice(3).map(item => item.authority), ['1.1.1.1:443', '1.1.1.1:443']);
  await closed(proxy, page, dns);
});

test('CONNECT拒绝、隧道断开、取消和超时均关闭socket且不重试或回退', async t => {
  for (const mode of ['connect-cancel', 'connect-timeout', 'tls-timeout']) {
    await t.test(mode, async t => {
      let connectStarted;
      const connected = new Promise(resolve => { connectStarted = resolve; });
      const proxy = await proxyFixture(t, (_request, socket) => {
        connectStarted();
        if (mode === 'tls-timeout') socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      });
      const controller = new AbortController();
      const isTls = mode === 'tls-timeout';
      const pending = fetchWebPage(`${isTls ? 'https' : 'http'}://proxy-page.example/`,
        { ...config, timeoutMs: 150, proxyUrl: proxy.proxyUrl }, controller.signal, { lookup });
      const rejected = rejects(pending, mode === 'connect-cancel' ? 'cancelled' : 'timeout');
      if (mode === 'connect-cancel') {
        await connected;
        controller.abort(new Error('proxy-secret'));
      }
      await rejected;
      assert.equal(proxy.requests.length, 1);
      await closed(proxy);
    });
  }
});
