import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTrending, generateTrendingDigest, parseTrendingPage } from '../dist/trending-content.js';
import { fetchWebDocument, fetchWebPage } from '../dist/web-fetch.js';
import { DiagnosticLog } from '../dist/diagnostics.js';

const periods = ['daily', 'weekly', 'monthly'];
const row = (slug, description = 'A tool for managing local files.', period = 'daily') => `<article class="Box-row">
  <template><dialog><h2>Lists</h2><p>Unrelated menu copy</p></dialog></template>
  <h2 class="h3 lh-condensed"><a href="/${slug}"><svg><path d="x"></path></svg><span>${slug.split('/')[0]} /</span> ${slug.split('/')[1]}</a></h2>
  ${description ? `<p class="col-9 color-fg-muted my-1">${description}</p>` : ''}
  <div><span itemprop="programmingLanguage">Python</span><span class="d-inline-block float-sm-right"><svg></svg>1,930 stars ${period === 'daily' ? 'today' : period === 'weekly' ? 'this week' : 'this month'}</span></div>
</article>`;
const config = { cwd: process.cwd(), dataDir: '', provider: 'bailian', model: 'deepseek-v4.1-flash', apiKey: 'fixture-key',
  contextWindow: 32768, maxOutputTokens: 2048, timeoutMs: 3000,
  fetch: { enabled: true, timeoutMs: 1000, maxResponseBytes: 1048576, maxTextChars: 8000 } };
const lists = { daily: ['u/a1', 'u/a2', 'u/a3', 'u/a4', 'u/a5', 'u/extra'],
  weekly: ['U/A1', 'u/a2', 'u/w1', 'u/w2', 'u/w3', 'u/w4'], monthly: ['u/w1', 'u/a3', 'u/m1', 'u/m2', 'u/m3'] };
const fetchDocument = async url => {
  const period = new URL(url).searchParams.get('since');
  return { url, contentType: 'text/html; charset=utf-8', statusCode: 200, fetchedAt: '2026-10-30T00:00:00.000Z',
    body: lists[period].map(slug => row(slug, slug === 'u/a5' ? '' : undefined, period)).join('') };
};

test('官方article字段解析、跨分组按原序去重补齐，缺榜与读取失败明确拒绝', async () => {
  // Public field values from the official page; no signed-in DOM or hydro metadata.
  const project = parseTrendingPage(row('HKUDS/DeepTutor', 'DeepTutor: Lifelong Personalized Tutoring. <a href="https://deeptutor.info/">https://deeptutor.info/</a>.'), 'daily')[0];
  assert.deepEqual(project, { slug: 'HKUDS/DeepTutor', url: 'https://github.com/HKUDS/DeepTutor',
    description: 'DeepTutor: Lifelong Personalized Tutoring. https://deeptutor.info/ .', language: 'Python', periodStars: 1930 });
  assert.equal(parseTrendingPage(row('u/entity', 'Read &amp; write &#x4e2d;&#25991;'), 'daily')[0].description, 'Read & write 中文');
  const snapshot = await collectTrending(config, undefined, { fetchDocument, now: () => new Date('2026-10-30T00:00:00Z') });
  assert.equal(snapshot.fetchedAt, '2026-10-30T00:00:00.000Z');
  assert.deepEqual(snapshot.sections.map(section => section.projects.map(project => project.slug)), [lists.daily.slice(0, 5), ['u/w1', 'u/w2', 'u/w3'], ['u/m1', 'u/m2']]);
  const shortSnapshot = await collectTrending(config, undefined, { fetchDocument: async url => ({ ...await fetchDocument(url), body: row('u/only') }) });
  assert.deepEqual(shortSnapshot.sections.map(section => section.projects.length), [1, 0, 0]);
  await assert.rejects(collectTrending(config, undefined, { fetchDocument: async () => { throw new Error('offline'); } }), { code: 'fetch' });
  assert.throws(() => parseTrendingPage('<article class="Box-row"><h2>unexpected</h2></article>', 'daily'), { code: 'structure' });
});

test('原HTML和普通web_fetch共用公开地址、响应大小和HTML提取边界', async () => {
  const html = '<html><body><script>hidden</script><h1>Visible</h1></body></html>';
  const deps = { lookup: async () => [{ address: '93.184.216.34', family: 4 }], transport: async () => ({
    statusCode: 200, headers: { 'content-type': 'text/html' }, body: (async function* () { yield Buffer.from(html); })() }) };
  assert.equal((await fetchWebDocument('https://github.com/trending?since=daily', config.fetch, undefined, deps)).body, html);
  assert.equal((await fetchWebPage('https://github.com/trending?since=daily', config.fetch, undefined, deps)).text, 'Visible');
  await assert.rejects(fetchWebDocument('http://127.0.0.1', config.fetch, undefined, deps), { code: 'address' });
  await assert.rejects(fetchWebDocument('https://github.com', { ...config.fetch, maxResponseBytes: 1 }, undefined, deps), { code: 'size' });
});

test('真实Pi最终请求单次JSON Object且关闭thinking，程序固定slug/数量/链接并独立记录诊断', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-trending-content-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
    const projects = input.projects.map(project => ({ slug: project.slug,
      introduction: project.description ? '这是一个管理本地文件的工具，适用于整理和管理本地文件。' : '项目没有提供榜单描述，目前资料有限。' }));
    if (requests.length === 1) projects[0].introduction = '管理本地文件。'.repeat(20);
    if (requests.length === 2) projects[0].slug = 'invented/project';
    if (requests.length === 3) projects[0].url = 'https://invented.example';
    if (requests.length === 4) projects.pop();
    if (requests.length === 6) projects[0].introduction = '项目地址为 deeptutor.info，可查看资料。';
    if (requests.length === 7) projects[0].introduction = '管理本地文件。'.repeat(26);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choices of [[{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ projects }) }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: 'stop' }]]) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: config.model, choices })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const localConfig = { ...config, dataDir, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const snapshot = await collectTrending(localConfig, undefined, { fetchDocument });
  snapshot.sections[0].projects[0].description = 'Manage local files. https://deeptutor.info/ http://docs.example/path?q=1。Local tools.';
  const originalDescription = snapshot.sections[0].projects[0].description;
  const digest = await generateTrendingDigest(localConfig, snapshot);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].enable_thinking, false);
  assert.equal(requests[0].thinking, undefined);
  assert.equal(requests[0].reasoning_effort, undefined);
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.equal(requests[0].tools, undefined);
  const modelInput = JSON.parse(requests[0].messages.find(message => message.role === 'user').content);
  assert.equal(modelInput.projects[0].description, 'Manage local files. 。Local tools.');
  assert.equal(snapshot.sections[0].projects[0].description, originalDescription);
  assert.ok(digest.sections[0].text.includes('管理本地文件。'.repeat(20)));
  assert.deepEqual(digest.sections.map(section => section.period), periods);
  for (const section of snapshot.sections) for (const project of section.projects) assert.ok(digest.sections.find(item => item.period === section.period).text.includes(project.url));
  assert.match(digest.sections[0].text, /资料有限/);
  const records = new DiagnosticLog(dataDir).calls({});
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'memory');
  assert.equal(records[0].phase, 'trending_digest');
  assert.match(records[0].traceId, /^trending:/);
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(generateTrendingDigest(localConfig, snapshot), { code: 'model_contract' });
  assert.equal(requests.length, 4);
  const shortSnapshot = await collectTrending(localConfig, undefined, { fetchDocument: async url => ({ ...await fetchDocument(url), body: row('u/only') }) });
  const shortDigest = await generateTrendingDigest(localConfig, shortSnapshot);
  assert.equal(requests.length, 5);
  assert.match(shortDigest.sections[1].text, /本榜当前项目已在前面分组介绍。\nhttps:\/\/github.com\/trending\?since=weekly$/);
  assert.match(shortDigest.sections[2].text, /本榜当前项目已在前面分组介绍。\nhttps:\/\/github.com\/trending\?since=monthly$/);
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(generateTrendingDigest(localConfig, snapshot), { code: 'model_contract' });
  assert.equal(requests.length, 7);
});
