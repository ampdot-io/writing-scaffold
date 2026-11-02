import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseCatalog, textOf } from './content.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = join(root, 'dist/writing-scaffold.mjs');

// Build explicitly with npm run bundle before running this deployment test.
test('standalone bundle works without project files over stdio and HTTP in both protocol eras', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'writing-scaffold-bundle-'));
  const entry = join(dir, 'writing-scaffold.mjs');
  await copyFile(bundle, entry);
  const env = { ...process.env, ACS_API_KEY: '', TYPESAFE_API_KEY: '', WRITING_SCAFFOLD_CORPUS: '' };
  try {
    assert.equal((await readFile(entry, 'utf8')).split('\n')[0], '#!/usr/bin/env node');
    const stdio = new StdioClientTransport({ command: entry, cwd: dir, env, stderr: 'pipe' });
    const local = new Client({ name: 'bundle-stdio-test', version: '1' });
    await local.connect(stdio);
    const expected = textOf(await local.readResource({ uri: 'copypasta://posts/17' }));
    const catalog = await local.callTool({ name: 'list_scaffolds', arguments: { source: 'gutenberg', limit: 1 } });
    assert.equal(catalog.content[0]?.type, 'text');
    const listing = parseCatalog((catalog.content[0] as { text: string }).text);
    assert.equal(listing.scaffolds.length, 1);
    const selected = listing.scaffolds[0]!.sequential_id;
    const imported = await local.callTool({ name: 'get_scaffold', arguments: { sequential_id: selected } });
    assert.ok((imported.content[0] as { text: string }).text.length > 0);
    const missingKeys = await local.callTool({ name: 'detemplatize', arguments: { scaffold_id: selected, text: 'Hello.' } });
    assert.equal(missingKeys.isError, true);
    assert.match(JSON.stringify(missingKeys), /ACS_API_KEY/);
    await local.close();

    const child = spawn(entry, ['--transport', 'http', '--port', '0'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', data => { stdout += String(data); });
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('HTTP startup timed out')), 30_000);
        let stderr = '';
        child.stderr.on('data', data => {
          stderr += String(data);
          const match = /listening on (http:\/\/[^\s]+)/.exec(stderr);
          if (match) { clearTimeout(timer); resolve(match[1]!); }
        });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Early HTTP exit ${code}: ${stderr}`)); });
      });
      for (const modern of [false, true]) {
        const client = new Client({ name: 'bundle-http-test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
        const transport = new StreamableHTTPClientTransport(new URL(endpoint));
        try {
          await client.connect(transport);
          assert.equal((await client.listTools()).tools.length, 5);
          assert.equal(textOf(await client.readResource({ uri: 'copypasta://posts/17' })), expected);
          assert.deepEqual((await client.callTool({ name: 'get_scaffold', arguments: { sequential_id: selected } })).content, imported.content);
          const prompt = await client.callTool({ name: 'write_with_scaffold', arguments: { objective: 'Explain NASA', topic: 'OpenAI' } });
          assert.match(JSON.stringify(prompt), /explain NASA/);
          assert.ok((await client.listResources()).resources.length > 0);
        } finally { await client.close(); }
      }
      assert.equal((await fetch(endpoint.replace('/mcp', '/missing'))).status, 404);
      assert.equal((await fetch(endpoint, { headers: { Origin: 'https://evil.example' } })).status, 403);
      assert.equal(await new Promise<number | undefined>((resolve, reject) => {
        const req = request(endpoint, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end();
      }), 403);
      assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{' })).status, 400);
      assert.equal(stdout, '');
    } finally {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
      assert.equal(child.exitCode, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
