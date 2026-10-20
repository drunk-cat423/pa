import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Socket } from 'node:net';
import tls from 'node:tls';

export function parseWebFetchProxyUrl(value: string): URL {
  const invalid = () => new Error('网页读取代理必须是无认证、路径、查询参数或片段的 HTTP 地址。');
  if (typeof value !== 'string' || value.length > 2048 || !/^http:\/\/[^/?#]+\/?$/i.test(value)
    || /[\u0000-\u0020\u007f\\?#@]/.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'http:' || !url.hostname || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || url.port === '0') throw invalid();
  return url;
}

interface ProxyRequest {
  url: URL;
  /** Already validated by the caller; the proxy must never resolve the URL hostname. */
  address: string;
  signal: AbortSignal;
  headers: Record<string, string>;
}

export interface ProxyResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
  destroy: () => void;
}

/** A dedicated, single-use tunnel. No global agent, pooling, retries or direct fallback. */
export function requestThroughWebFetchProxy(input: ProxyRequest, proxy: URL): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    let connectRequest: http.ClientRequest | undefined;
    let request: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    let tunnel: Socket | undefined;
    let socket: Socket | undefined;
    let agent: http.Agent | undefined;
    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      input.signal.removeEventListener('abort', abort);
      response?.destroy();
      request?.destroy();
      socket?.destroy();
      tunnel?.destroy();
      connectRequest?.destroy();
      agent?.destroy();
    };
    const failure = (error: Error) => { destroy(); reject(error); };
    const abort = () => failure(input.signal.reason instanceof Error ? input.signal.reason : new Error('Request aborted'));
    if (input.signal.aborted) { abort(); return; }
    input.signal.addEventListener('abort', abort, { once: true });
    const hostname = input.url.hostname.replace(/^\[|\]$/g, '');
    const port = input.url.port || (input.url.protocol === 'https:' ? '443' : '80');
    const authority = `${isIP(input.address) === 6 ? `[${input.address}]` : input.address}:${port}`;
    const send = (connection: Socket) => {
      if (destroyed) { connection.destroy(); return; }
      socket = connection;
      const secure = input.url.protocol === 'https:';
      agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
      // Supply only this established socket; the request cannot resolve or connect elsewhere.
      agent.createConnection = () => connection;
      try {
        request = (secure ? https : http).request(input.url, {
          method: 'GET', agent, headers: input.headers, rejectUnauthorized: true,
        }, incoming => {
          response = incoming;
          resolve({ statusCode: incoming.statusCode ?? 0, headers: incoming.headers, body: incoming, destroy });
        });
        request.on('error', failure);
        request.end();
      } catch (error) { failure(error instanceof Error ? error : new Error('Request failed')); }
    };
    try {
      connectRequest = http.request({
        hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || 80,
        method: 'CONNECT', path: authority, agent: false, headers: { Host: authority },
      });
      connectRequest.on('error', failure);
      connectRequest.on('connect', (incoming, connection, head) => {
        tunnel = connection;
        connection.on('error', failure);
        connection.once('close', () => {
          if (!destroyed && !response?.complete) failure(new Error('Proxy tunnel closed'));
        });
        if (destroyed) { connection.destroy(); return; }
        if (incoming.statusCode !== 200) { failure(new Error('Proxy tunnel rejected')); return; }
        if (head.length) connection.unshift(head);
        if (input.url.protocol !== 'https:') { send(connection); return; }
        try {
          const secureSocket = tls.connect({
            socket: connection, host: hostname, rejectUnauthorized: true,
            ...(isIP(hostname) ? {} : { servername: hostname }),
          });
          socket = secureSocket;
          secureSocket.on('error', failure);
          secureSocket.once('secureConnect', () => send(secureSocket));
        } catch (error) { failure(error instanceof Error ? error : new Error('TLS failed')); }
      });
      connectRequest.end();
    } catch (error) { failure(error instanceof Error ? error : new Error('Proxy connection failed')); }
  });
}
