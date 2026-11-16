import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { logRequest } from '../dist/request-log.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('public Worker serves both MCP versions, excludes rewriting, and persists every request', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'writing-scaffold-cloudflare-'));
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'writing-scaffold', modules: true,
    scriptPath: join(root, 'dist/cloudflare/worker.mjs'),
    compatibilityDate: '2026-11-16', compatibilityFlags: ['nodejs_compat'],
    assets: { directory: join(root, 'dist/cloudflare/assets'), binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true } },
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
