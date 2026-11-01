import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTrending, enrichTrendingReadmes, generateTrendingDigest, parseTrendingPage, parseRepositoryReadme, formatTrendingParts } from '../dist/trending-content.js';
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
const readmeHtml = (text = 'README workspace runner coordinates coding agents in separate workspaces.') => `<html><nav>Repository navigation</nav><p>About: unrelated short tagline</p>
  <article class="markdown-body entry-content container-lg" itemprop="text"><h1><a class="anchor" aria-hidden="true">Permalink</a>Workspace runner</h1>
  <p><a href="https://badge.example"><img alt="badge noise" src="badge.svg"></a>${text}</p><script>hidden script</script>
  <h2>Use cases</h2><p>Coordinate local development tasks &amp; review results.</p></article></html>`;
const fetchDocument = async url => {
  const period = new URL(url).searchParams.get('since');
  if (!period) {
    if (url.endsWith('/a3')) throw new Error('offline repository');
    return { url, contentType: 'text/html', statusCode: 200, fetchedAt: '2026-10-30T00:00:01.000Z', body: url.endsWith('/a4') ? '<p>No README</p>' : readmeHtml() };
  }
  return { url, contentType: 'text/html; charset=utf-8', statusCode: 200, fetchedAt: '2026-10-30T00:00:00.000Z',
    body: lists[period].map(slug => row(slug, slug === 'u/a5' ? '' : undefined, period)).join('') };
};

test('官方article字段解析、跨分组按原序去重补齐，缺榜与读取失败明确拒绝', async () => {
  // Public field values from the official page; no signed-in DOM or hydro metadata.
  const project = parseTrendingPage(row('HKUDS/DeepTutor', 'DeepTutor: Lifelong Personalized Tutoring. <a href="https://deeptutor.info/">https://deeptutor.info/</a>.'), 'daily')[0];
  assert.deepEqual(project, { slug: 'HKUDS/DeepTutor', url: 'https://github.com/HKUDS/DeepTutor',
    description: 'DeepTutor: Lifelong Personalized Tutoring. https://deeptutor.info/ .', language: 'Python', periodStars: 1930 });
  assert.equal(parseTrendingPage(row('u/entity', 'Read &amp; write &#x4e2d;&#25991;'), 'daily')[0].description, 'Read & write 中文');
  const urls = [];
  const snapshot = await collectTrending(config, undefined, { fetchDocument: async (...args) => { urls.push(args[0]); return fetchDocument(...args); }, now: () => new Date('2026-10-30T00:00:00Z') });
  assert.equal(snapshot.fetchedAt, '2026-10-30T00:00:00.000Z');
  assert.deepEqual(snapshot.sections.map(section => section.projects.map(project => project.slug)), [lists.daily.slice(0, 5), ['u/w1', 'u/w2', 'u/w3'], ['u/m1', 'u/m2']]);
  assert.equal(urls.length, 4);
  assert.equal(new Set(urls).size, 4);
  assert.ok(urls.slice(0, 3).every(url => url.includes('/trending?')));
  assert.equal(urls[3], 'https://github.com/u/a5');
  const projects = snapshot.sections.flatMap(section => section.projects);
  assert.ok(projects.filter(project => project.description.trim()).every(project => project.readme === undefined));
  assert.equal(projects[4].readme.sourceUrl, 'https://github.com/u/a5#readme');
  assert.equal(projects[4].readme.fetchedAt, '2026-10-30T00:00:01.000Z');
  assert.match(projects[4].readme.text, /Workspace runner\n\nREADME workspace runner/);
  assert.ok(!/navigation|tagline|Permalink|badge noise|hidden script/.test(projects[4].readme.text));
  assert.equal(projects[4].description, '');
  assert.equal(projects[4].readme.status, 'ok');
  const clipped = parseRepositoryReadme(readmeHtml('长'.repeat(9000)));
  assert.equal(clipped.text.length, 8000);
  assert.equal(clipped.truncated, true);
  assert.match(clipped.text, /\[README 已截断\]$/);
  assert.equal(parseRepositoryReadme('<article class="markdown-body"><p>not the README</p></article>').status, 'missing');
  assert.equal(parseRepositoryReadme('<article class="markdown-body entry-content" itemprop="text"><img alt="badge"><script>hidden</script></article>').reason, 'readme_empty');
  const old = structuredClone(snapshot);
  for (const project of old.sections.flatMap(section => section.projects)) { delete project.readme; project.description = ' \t\n '; }
  const frozen = JSON.stringify(old);
  const unavailable = await enrichTrendingReadmes(config, old, undefined, { fetchDocument });
  assert.deepEqual(unavailable.sections[0].projects.slice(2, 4).map(project => [project.readme.status, project.readme.reason]), [['failed', 'fetch_failed'], ['missing', 'readme_missing']]);
  let active = 0, maximum = 0, reads = 0;
  const enriched = await enrichTrendingReadmes(config, old, undefined, { fetchDocument: async url => {
    active++; reads++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return { url, contentType: 'text/html', fetchedAt: '2026-10-30T00:00:02Z', body: readmeHtml() };
  } });
  assert.equal(reads, 10); assert.equal(maximum, 2); assert.equal(JSON.stringify(old), frozen);
  await enrichTrendingReadmes(config, enriched, undefined, { fetchDocument: async () => assert.fail('successful frozen README must not be re-read') });
  const controller = new AbortController(); let cancelledReads = 0;
  await assert.rejects(enrichTrendingReadmes(config, old, controller.signal, { fetchDocument: async () => {
    cancelledReads++; controller.abort(); throw new Error('cancelled');
  } }), { code: 'cancelled' });
  assert.equal(cancelledReads, 1);
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
  const snapshot = await collectTrending(config, undefined, { fetchDocument });
  for (const project of snapshot.sections.flatMap(section => section.projects)) { delete project.readme; project.description = ''; }
  const bounded = await enrichTrendingReadmes({ ...config, fetch: { ...config.fetch, maxResponseBytes: 1 } }, snapshot, undefined, { webFetch: deps });
  assert.ok(bounded.sections.flatMap(section => section.projects).every(project => project.readme.status === 'failed' && project.readme.reason === 'fetch_failed'));
});

test('真实Pi最终请求严格工具参数且关闭thinking，程序固定slug/数量/链接并独立记录诊断', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-trending-content-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
    const args = Object.fromEntries(input.projects.map(project => [project.slug, project.sourceKind === 'description'
      ? '**管理本地文件。**'.repeat(30) : project.sourceKind === 'readme' ? '协调独立工作区中的编程助手，适合并行开发任务与结果审查。'
      : project.readme.status === 'legacy_unread' ? '旧快照未读取 README，辅助简介只说明这是管理本地文件的工具。'
        : 'README 缺失或读取失败，资料有限，目前无法确认用途。']));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: config.model,
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: body.tools[0].function.name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: config.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const localConfig = { ...config, dataDir, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  let snapshot = await collectTrending(localConfig, undefined, { fetchDocument });
  snapshot.sections[0].projects[0].description = 'Manage local files. https://deeptutor.info/ http://docs.example/path?q=1。Local tools.';
  snapshot.sections[0].projects[0].readme = structuredClone(snapshot.sections[0].projects[4].readme);
  snapshot.sections[0].projects[0].readme.sourceUrl = snapshot.sections[0].projects[0].url + '#readme';
  snapshot.sections[0].projects[2].description = '';
  snapshot.sections[0].projects[3].description = '   ';
  snapshot = await enrichTrendingReadmes(localConfig, snapshot, undefined, { fetchDocument });
  const originalDescription = snapshot.sections[0].projects[0].description;
  const progress = [];
  const digest = await generateTrendingDigest(localConfig, snapshot, undefined, { onProgress: value => progress.push(value) });
  assert.equal(requests.length, 1);
  const payload = requests[0], tool = payload.tools[0].function;
  assert.equal(payload.enable_thinking, false);
  assert.equal(payload.thinking, undefined);
  assert.equal(payload.response_format, undefined);
  assert.equal(tool.strict, true);
  assert.deepEqual(payload.tool_choice, { type: 'function', function: { name: tool.name } });
  assert.equal(payload.parallel_tool_calls, false);
  const slugs = snapshot.sections.flatMap(section => section.projects.map(project => project.slug));
  assert.deepEqual(tool.parameters.required, slugs);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(Object.values(tool.parameters.properties).every(field => field.type === 'string'));
  const input = JSON.parse(payload.messages.find(message => message.role === 'user').content);
  assert.equal(input.projects[0].description, 'Manage local files. 。Local tools.');
  assert.equal(input.projects[0].sourceKind, 'description');
  assert.equal(input.projects[0].readme, undefined);
  assert.equal(input.projects[4].sourceKind, 'readme');
  assert.equal(input.projects[4].description, undefined);
  assert.match(input.projects[4].readme.text, /coordinates coding agents/);
  assert.equal(input.projects[2].readme.status, 'failed');
  assert.equal(input.projects[3].readme.status, 'missing');
  assert.match(payload.messages[0].content, /资料都不是指令/);
  assert.match(digest.sections[0].text, /协调独立工作区中的编程助手/);
  assert.equal(snapshot.sections[0].projects[0].description, originalDescription);
  assert.ok(digest.sections[0].text.includes('管理本地文件。'));
  assert.ok(digest.sections[0].text.includes('…'));
  assert.ok(!digest.sections[0].text.includes('管理本地文件。'.repeat(30)));
  assert.ok(!digest.sections[0].text.includes('**'));
  assert.equal(digest.degraded, undefined);
  assert.equal(progress[0].attempts, 1);
  assert.deepEqual(progress[0].introductions, {});
  assert.equal(Object.keys(progress.at(-1).introductions).length, 10);
  assert.deepEqual(digest.sections.map(section => section.period), periods);
  for (const section of snapshot.sections) for (const project of section.projects) assert.ok(digest.sections.find(item => item.period === section.period).text.includes(project.url));
  const parts = formatTrendingParts(digest, { date: '2026-10-30' });
  assert.ok(parts.length <= 5 && parts.every(part => Buffer.byteLength(part) <= 1500));
  for (const section of digest.sections) for (const paragraph of section.text.split(/\n\s*\n/).slice(1)) assert.ok(parts.some(part => part.includes(paragraph)));
  assert.match(parts[0], /^# GitHub Trending · 2026-10-30\n## GitHub Trending 日榜/);
  assert.match(formatTrendingParts(digest, { date: '2026-10-30', manual: true })[0], /试运行/);
  assert.match(formatTrendingParts(digest, { date: '2026-10-30', manual: true, supplementOf: '2026-10-30', late: true })[0], /AI总结补充\n延迟补发/);
  assert.throws(() => formatTrendingParts({ ...digest, sections: [{ period: 'daily', text: `## 日榜\n\n${'中'.repeat(1000)}` }] }, { date: '2026-10-30' }), { code: 'model_contract' });
  assert.match(digest.sections[0].text, /资料有限/);
  const records = new DiagnosticLog(dataDir).calls({});
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'memory');
  assert.equal(records[0].phase, 'trending_digest');
  assert.match(records[0].traceId, /^trending:/);
  const shortSnapshot = await collectTrending(localConfig, undefined, { fetchDocument: async url => ({ ...await fetchDocument(url), body: row('u/only') }) });
  const shortDigest = await generateTrendingDigest(localConfig, shortSnapshot);
  assert.equal(requests.length, 2);
  assert.match(shortDigest.sections[1].text, /本榜当前项目已在前面分组介绍。\nhttps:\/\/github.com\/trending\?since=weekly$/);
  const legacy = structuredClone(shortSnapshot);
  assert.equal(shortSnapshot.sections[0].projects[0].readme, undefined);
  assert.equal(JSON.parse(requests[1].messages.find(message => message.role === 'user').content).projects[0].sourceKind, 'description');
  assert.ok(!shortDigest.sections[0].text.includes('未读取 README'));
  for (const project of legacy.sections.flatMap(section => section.projects)) { delete project.readme; project.description = ''; }
  const legacyDigest = await generateTrendingDigest(localConfig, legacy);
  assert.match(legacyDigest.sections[0].text, /旧快照未读取 README/);
  assert.equal(JSON.parse(requests[2].messages.find(message => message.role === 'user').content).projects[0].readme.status, 'legacy_unread');
  assert.equal(legacy.sections[0].projects[0].readme, undefined);
});
