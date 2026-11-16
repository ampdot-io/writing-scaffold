import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { logRequest } from '../dist/request-log.js';
import { isSetupRequest, renderSetupPage } from '../dist/setup-page.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('public Worker serves both MCP versions, excludes rewriting, and persists every request', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'writing-scaffold-cloudflare-'));
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'writing-scaffold', modules: true,
    scriptPath: join(root, 'dist/cloudflare/worker.mjs'),
    compatibilityDate: '2026-11-16', compatibilityFlags: ['nodejs_compat'],
    assets: { directory: join(root, 'dist/cloudflare/assets'), binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true }, assetConfig: { html_handling: 'none' } },
    r2Buckets: { REQUEST_LOGS: 'writing-scaffold-requests' }, r2Persist: dir,
  }));
  let requests = 0;
  const dispatch = (input, init) => { requests++; return mf.dispatchFetch(input, init); };
  const fetcher = async (input, init) => dispatch(input instanceof URL ? input.toString() : input, init);
  try {
    await mf.ready;
    for (const modern of [false, true]) {
      const client = new Client({ name: 'public-cloudflare-test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
      await client.connect(new StreamableHTTPClientTransport(new URL('https://writing-scaffold.test/mcp'), { fetch: fetcher }));
      try {
        const tools = (await client.listTools()).tools;
        assert.deepEqual(tools.map(tool => tool.name).sort(), ['get_scaffold', 'list_references', 'list_scaffolds', 'write_with_scaffold']);
        assert.doesNotMatch(JSON.stringify(tools), /detemplatize|ACS_API_KEY|TYPESAFE/i);
        const listing = await client.callTool({ name: 'list_scaffolds', arguments: { source: 'gutenberg', limit: 1 } });
        const lines = listing.content[0].text.split('\n');
        const seq = Number(lines[3].split('\t')[0]);
        assert.ok(seq > 0);
        const got = await client.callTool({ name: 'get_scaffold', arguments: { sequential_id: seq } });
        assert.ok(got.content[0].text.length > 0);
        const resources = await client.listResources();
        assert.ok(resources.resources.length > 0);
        const resource = await client.readResource({ uri: 'copypasta://posts/17/record' });
        assert.equal(JSON.parse(resource.contents[0].text).id, 17);
        const prompt = await client.callTool({ name: 'write_with_scaffold', arguments: { objective: 'Explain NASA', topic: 'Space' } });
        assert.match(prompt.content[0].text, /explain NASA/);
        assert.doesNotMatch(prompt.content[0].text, /detemplatize/i);
        await assert.rejects(client.callTool({ name: 'detemplatize', arguments: { scaffold_id: seq, text: 'Hello.' } }), /Unknown tool/);
      } finally { await client.close(); }
    }
    for (const path of ['/app', '/api/detemplatize', '/__library/catalog.json', '/__library/records/17.json']) {
      assert.equal((await dispatch(`https://writing-scaffold.test${path}`)).status, 404);
    }
    assert.equal((await dispatch('https://writing-scaffold.test/mcp', { headers: { origin: 'https://other.test' } })).status, 403);
    assert.equal((await dispatch('https://writing-scaffold.test/?token=secret', { headers: { Authorization: 'Bearer secret', Cookie: 'secret' } })).status, 200);
    assert.equal((await dispatch('https://writing-scaffold.test/mcp', { method: 'POST', body: '{', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } })).status, 400);
    for (const accept of [undefined, '*/*', 'text/html', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8']) {
      const page = await dispatch('https://writing-scaffold.test/mcp', { headers: accept ? { accept } : {} });
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      const html = await page.text();
      for (const agent of ['pi', 'claude', 'codex']) for (const mode of ['cli', 'gui']) {
        assert.ok(html.includes('data-setup="' + agent + '-' + mode + '"'));
      }
      assert.ok(html.includes('https://writing-scaffold.test/mcp'));
      assert.ok(html.includes('Requests, including their bodies, are logged.'));
    }
    const head = await dispatch('https://writing-scaffold.test/mcp', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const headers of [{ accept: 'text/event-stream' }, { 'mcp-protocol-version': '2025-11-25' }, { 'mcp-session-id': 'session' }]) {
      const protocolGet = await dispatch('https://writing-scaffold.test/mcp', { headers });
      assert.equal(protocolGet.status, 405);
      assert.doesNotMatch(protocolGet.headers.get('content-type') ?? '', /text\/html/);
    }
    const benchmarkUrl = 'https://writing-scaffold.test/pangram-miss-benchmark.html';
    const benchmark = await dispatch(benchmarkUrl);
    assert.equal(benchmark.status, 200);
    assert.match(benchmark.headers.get('content-type'), /text\/html/);
    assert.equal(await benchmark.text(), await readFile(join(root, 'web/pangram-miss-benchmark.html'), 'utf8'));
    const benchmarkHead = await dispatch(benchmarkUrl, { method: 'HEAD' });
    assert.equal(benchmarkHead.status, 200);
    assert.equal(await benchmarkHead.text(), '');
    const benchmarkPost = await dispatch(benchmarkUrl, { method: 'POST' });
    assert.equal(benchmarkPost.status, 405);
    assert.equal(benchmarkPost.headers.get('allow'), 'GET, HEAD');
    assert.ok(renderSetupPage('https://writing-scaffold.test/mcp').includes('href="/pangram-miss-benchmark.html"'));
    const bucket = await mf.getR2Bucket('REQUEST_LOGS');
    const objects = await bucket.list({ limit: 1000 });
    assert.equal(objects.objects.length, requests, 'each request is persisted once, including rejected requests');
    const logs = await Promise.all(objects.objects.map(async object => JSON.parse(await (await bucket.get(object.key)).text())));
    assert.ok(logs.some(log => log.body.includes('get_scaffold')));
    assert.ok(logs.some(log => log.body.includes('detemplatize')));
    assert.ok(logs.some(log => log.status === 404));
    assert.ok(logs.some(log => log.status === 403));
    assert.ok(logs.some(log => log.status === 400));
    const redacted = logs.find(log => log.url.includes('?token='));
    assert.equal(redacted.headers.authorization, '[REDACTED]');
    assert.equal(redacted.headers.cookie, '[REDACTED]');
    assert.ok(!redacted.url.includes('secret'));
    const receipt = JSON.parse(await readFile(join(root, 'dist/cloudflare/build.json'), 'utf8'));
    assert.ok(receipt.records > 9000);
    assert.ok(receipt.inputs.every(path => !/detemplatize|provider-http|llama3-tokenizer/.test(path)));
  } finally { await mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('request logging waits for storage and fails closed if the write fails', async () => {
  let stored;
  const request = new Request('https://writing-scaffold.test/mcp', { method: 'POST', body: 'test-body' });
  const response = await logRequest(request, { async put(key, body) { stored = { key, entry: JSON.parse(body) }; } }, async () => new Response('ok'));
  assert.equal(response.status, 200);
  assert.equal(stored.entry.body, 'test-body');
  assert.match(stored.key, /^\d{4}-\d{2}-\d{2}\//);
  const failed = await logRequest(new Request('https://writing-scaffold.test/'), { async put() { throw Error('offline'); } }, async () => new Response('ok'));
  assert.equal(failed.status, 503);
});

test('oversized requests are rejected and their bounded prefix is logged', async () => {
  let log;
  const response = await logRequest(new Request('https://writing-scaffold.test/mcp', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }), { async put(_key, body) { log = JSON.parse(body); } }, async () => { throw Error('must not route oversized input'); });
  assert.equal(response.status, 413);
  assert.equal(log.bodyTruncated, true);
  assert.equal(log.bodyBytes, 1024 * 1024);
});


test('setup content escapes URLs and distinguishes document requests from MCP requests', () => {
  const base = 'https://writing-scaffold.test/mcp';
  for (const method of ['GET', 'HEAD']) assert.equal(isSetupRequest(new Request(base, { method })), true);
  assert.equal(isSetupRequest(new Request(base, { method: 'POST' })), false);
  assert.equal(isSetupRequest(new Request(base, { headers: { accept: 'text/event-stream' } })), false);
  assert.equal(isSetupRequest(new Request(base, { headers: { accept: 'text/html, text/event-stream' } })), true);
  assert.equal(isSetupRequest(new Request(base, { headers: { 'MCP-Protocol-Version': '2026-07-28', accept: 'text/html' } })), false);
  const html = renderSetupPage(base + '?x=<script>&q="unsafe"');
  assert.ok(html.includes('&lt;script&gt;&amp;q=&quot;unsafe&quot;'));
  assert.ok(!html.includes('?x=<script>'));
  assert.match(html, /claude mcp add --transport http --scope user writing-scaffold/);
  assert.match(html, /pi mcp add writing-scaffold --url/);
  assert.match(html, /codex mcp add writing-scaffold --url/);
  assert.match(html, /Settings → MCP servers → Add server/);
  assert.match(html, /Customize → Connectors/);
  assert.match(html, /~\/\.pi\/agent\/mcp\.json/);
});


test('GitHub benchmark defaults to Gemini and permits other views', async () => {
  const html = await readFile(join(root, 'web/pangram-miss-benchmark.html'), 'utf8');
  const gemini = 'gemini_4_argon_high_initial_n100_seed20261031';
  assert.ok(html.includes('value="' + gemini + '" selected'));
  const handlers = {};
  const selector = { value: gemini, addEventListener: (event, handler) => { handlers[event] = handler; } };
  const main = { addEventListener: () => {}, innerHTML: html.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1] };
  assert.match(main.innerHTML, /Gemini 4 Argon high/);
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: () => selector, querySelector: () => main },
  });
  selector.value = 'pangram_mcp_n60_seed42';
  handlers.change();
  assert.match(main.innerHTML, /Claude Opus 5\.5/);
  selector.value = gemini;
  handlers.change();
  assert.match(main.innerHTML, /Gemini 4 Argon high/);
});

test('every model prompt toggles its escaped saved outputs, including below-ratio rows', async () => {
  const html = await readFile(join(root, 'web/pangram-miss-benchmark.html'), 'utf8');
  const handlers = {};
  const selector = { value: '', addEventListener: (event, handler) => { handlers[event] = handler; } };
  let expanded = 'false';
  const detail = { hidden: true };
  const button = { getAttribute: key => key === 'aria-controls' ? 'output-0' : expanded, setAttribute: (_, value) => { expanded = value; } };
  const row = { querySelector: () => button, classList: { toggle() {} } };
  const main = { innerHTML: '', addEventListener: (event, handler) => { handlers[event] = handler; } };
  const context = vm.createContext({ document: { getElementById: id => id === 'run-pick' ? selector : detail, querySelector: () => main } });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  for (const key of vm.runInContext('Object.keys(views)', context)) {
    selector.value = key; handlers.change();
    assert.match(main.innerHTML, /Initial output/);
    const prompts = [...main.innerHTML.matchAll(/class="prompt-toggle"/g)];
    const rows = [...main.innerHTML.matchAll(/<tr id="doc-\d+"/g)];
    assert.equal(prompts.length, rows.length);
    assert.equal([...main.innerHTML.matchAll(/class="detail" hidden/g)].length, rows.length);
  }
  const event = { target: { closest: css => css === '.prompt-toggle' ? button : row } };
  handlers.click(event); assert.equal(expanded, 'true'); assert.equal(detail.hidden, false);
  handlers.click(event); assert.equal(expanded, 'false'); assert.equal(detail.hidden, true);
});
