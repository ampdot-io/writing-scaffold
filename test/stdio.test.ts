import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { INVALID_PARAMS, ProtocolError, ResourceNotFoundError } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { parseCatalog, textOf } from './content.js';
import type { ParsedCatalog } from './content.js';
import { NSFW_SCAFFOLD_IDS } from '../src/nsfw-labels.js';
import { writeWithScaffoldPrompt } from '../src/prompts.js';
import { SERVER_DESCRIPTION, SCAFFOLD_SOURCES } from '../src/sources.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = join(root, 'dist/index.js');
const data = join(root, 'artifacts/copypastatext/copypastas.jsonl');
const exec = promisify(execFile);

function connection(args: string[] = [], modern = false) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, ...(args.length ? args : ['--data', data])], cwd: tmpdir(), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'writing-scaffold-test', version: '1.0.0' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  return { client, transport, stderr: () => stderr };
}

function toolPrompt(result: CallToolResult): string {
  assert.notEqual(result.isError, true);
  assert.equal(result.content.length, 1);
  const content = result.content[0]!;
  assert.equal(content.type, 'text');
  assert.ok('text' in content);
  return content.text;
}

for (const modern of [false, true]) {
  test(`scaffold tools are discoverable and callable over ${modern ? 'modern' : 'legacy'} stdio`, { timeout: 30_000 }, async () => {
    const { client, transport, stderr } = connection([], modern);
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.equal(client.getServerVersion()?.description, SERVER_DESCRIPTION);
      for (const source of SCAFFOLD_SOURCES) assert.ok(client.getInstructions()?.includes(source));
      assert.deepEqual(listed.tools.map(tool => tool.name), ['write_with_scaffold', 'detemplatize', 'get_scaffold', 'list_scaffolds', 'list_references']);
      const writing = listed.tools[0]!;
      const rewriting = listed.tools[1]!;
      assert.deepEqual(writing.inputSchema.required, ['objective', 'topic']);
      assert.deepEqual(writing.inputSchema.properties, {
        objective: { type: 'string', description: 'What the writing should accomplish.' },
        topic: { type: 'string', description: 'What the writing should be about.' },
      });
      assert.equal(writing.inputSchema.additionalProperties, false);
      assert.deepEqual(rewriting.inputSchema.required, ['scaffold_id','text']);
      assert.deepEqual(Object.keys(rewriting.inputSchema.properties ?? {}), ['scaffold_id','text']);
      assert.equal(rewriting.inputSchema.additionalProperties, false);
      assert.deepEqual(Object.keys(listed.tools[3]!.inputSchema.properties ?? {}), ['nsfw', 'source', 'include_sources', 'exclude_sources', 'preview_length', 'max_chars', 'limit', 'cursor']);
      assert.deepEqual((listed.tools[3]!.inputSchema.properties as Record<string, { default?: unknown }>).max_chars!.default, 45_000);
      assert.equal(listed.tools[3]!.inputSchema.additionalProperties, false);
      assert.equal(writing.annotations?.readOnlyHint, true);
      assert.equal(rewriting.annotations?.readOnlyHint, true);
      const hidden = parseCatalog(toolPrompt(await client.callTool({ name: 'list_scaffolds', arguments: { exclude_sources: ['copypastatext'] } })));
      assert.equal(hidden.total, 0); assert.equal(hidden.listed, 0);

      const request = { objective: 'Explain a discovery\n"clearly"', topic: 'Moon cafés 😀\u2028and tea' };
      const prompt = toolPrompt(await client.callTool({ name: 'write_with_scaffold', arguments: request }));
      assert.match(prompt, /Find an appropriate.*scaffold/);
      assert.match(prompt, /following that scaffold exactly/);
      assert.match(prompt, /list_scaffolds\(\)/);
      assert.equal(prompt, writeWithScaffoldPrompt(request.objective, request.topic));
      assert.match(prompt, /next_cursor/);

      for (const params of [
        { name: 'write_with_scaffold', arguments: { objective: 5, topic: 'tea' } },
        { name: 'write_with_scaffold', arguments: { topic: 'tea' } },
        { name: 'detemplatize', arguments: { topic: 'tea' } },
        { name: 'detemplatize', arguments: {} },
        { name: 'detemplatize', arguments: {scaffold_id:1,text:42} },
        { name: 'unknown_tool', arguments: {} },
        { name: 'get_scaffold', arguments: { id: '17' } },
        { name: 'get_scaffold', arguments: {} },
        { name: 'list_scaffolds', arguments: { cursor: 'invalid' } },
        { name: 'list_scaffolds', arguments: { nsfw: 'true' } },
        { name: 'list_scaffolds', arguments: { preview_length: 0 } },
        { name: 'list_scaffolds', arguments: { preview_length: 301 } },
      ]) {
        await assert.rejects(client.request({ method: 'tools/call', params }),
          e => e instanceof ProtocolError && e.code === INVALID_PARAMS);
      }
      assert.equal(stderr(), '');
    } finally {
      await client.close();
      await transport.close();
    }
  });
}

test('tool-only connections shuffle every eligible preview and fetch every full scaffold', { timeout: 120_000 }, async () => {
  const bytes = await readFile(data);
  const source = new Map<number, string>();
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line) {
      const row = JSON.parse(line) as { id: number; text: string };
      source.set(row.id, row.text);
    }
  }
  const orderedIds = [...source.keys()].sort((a,b)=>a-b);
  const canonicalId = (sequentialId: number) => orderedIds[sequentialId-1]!;
  const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const modern of [false, true]) {
    const { client, transport, stderr } = connection([], modern);
    try {
      await client.connect(transport);
      const collect = async (args: Record<string, unknown>) => {
        const pages: ParsedCatalog[] = [];
        let cursor: string | undefined;
        do {
          const raw = toolPrompt(await client.callTool({ name: 'list_scaffolds', arguments: cursor === undefined ? args : { ...args, cursor } }));
          assert.ok(raw.length <= (typeof args.max_chars === 'number' ? args.max_chars : 45_000), 'every page fits its character budget');
          const page = parseCatalog(raw);
          pages.push(page);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        assert.ok(pages.length > 1, 'the corpus needs more than one page');
        assert.ok(pages.every((p, i) => p.offset === pages.slice(0, i).reduce((n, q) => n + q.listed, 0)));
        return { ...pages[0]!, scaffolds: pages.flatMap(p => p.scaffolds) };
      };
      const catalog = await collect({});
      assert.equal(catalog.total, 6466);
      assert.equal(catalog.previewLength, 120);
      assert.equal(catalog.maxChars, 45_000);
      assert.deepEqual(catalog.columns, ['sequential_id', 'source', 'length', 'preview']);
      const eligibleIds = [...source.keys()].filter(id => !NSFW_SCAFFOLD_IDS.has(id)).sort((a, b) => a - b);
      assert.equal(catalog.scaffolds.length, eligibleIds.length);
      const ids: number[] = [];
      for (const item of catalog.scaffolds) {
        const original = source.get(canonicalId(item.sequential_id))!;
        const segments = [...characters.segment(original)];
        const expected = segments.slice(0, 120).map(c => c.segment).join('');
        assert.equal(item.preview, expected, `Preview differs for ${canonicalId(item.sequential_id)}`);
        assert.equal(item.length, segments.length, `Full length differs for ${canonicalId(item.sequential_id)}`);
        assert.equal(item.nsfw, undefined);
        assert.ok(!NSFW_SCAFFOLD_IDS.has(canonicalId(item.sequential_id)));
        ids.push(canonicalId(item.sequential_id));
      }
      assert.deepEqual([...ids].sort((a, b) => a - b), eligibleIds);
      const repeated = await collect({ preview_length: 40 });
      assert.equal(repeated.total, 6466);
      assert.equal(repeated.previewLength, 40);
      assert.deepEqual(repeated.scaffolds.map(t => canonicalId(t.sequential_id)).sort((a,b)=>a-b), catalog.scaffolds.map(t => canonicalId(t.sequential_id)).sort((a,b)=>a-b));
      assert.notDeepEqual(repeated.scaffolds.map(t => canonicalId(t.sequential_id)), ids);
      for (const item of repeated.scaffolds) {
        const original = source.get(canonicalId(item.sequential_id))!;
        const segments = [...characters.segment(original)];
        assert.equal(item.preview, segments.slice(0, 40).map(c => c.segment).join(''));
        assert.equal(item.length, segments.length, `Full length differs for ${canonicalId(item.sequential_id)}`);
        assert.equal(item.nsfw, undefined);
      }
      const included = await collect({ nsfw: true, preview_length: 300 });
      assert.deepEqual(included.columns, ['sequential_id', 'source', 'length', 'nsfw', 'preview']);
      assert.equal(included.scaffolds.length, source.size);
      assert.equal(included.total, 6466);
      assert.deepEqual(included.scaffolds.map(t => canonicalId(t.sequential_id)).sort((a, b) => a - b), [...source.keys()].sort((a, b) => a - b));
      assert.ok(included.scaffolds.some(t => t.nsfw));
      assert.ok(included.scaffolds.some(t => !t.nsfw));
      for (const item of included.scaffolds) {
        assert.equal(item.nsfw, NSFW_SCAFFOLD_IDS.has(canonicalId(item.sequential_id)));
        const segments = [...characters.segment(source.get(canonicalId(item.sequential_id))!)];
        assert.equal(item.preview, segments.slice(0, 300).map(c => c.segment).join(''));
        assert.equal(item.length, segments.length);
      }
      const allIds = orderedIds;
      for (let offset = 0; offset < allIds.length; offset += 16) {
        await Promise.all(allIds.slice(offset, offset + 16).map(async (id,index) => {
          const result = await client.callTool({ name: 'get_scaffold', arguments: { sequential_id: offset+index+1 } });
          assert.equal(toolPrompt(result), source.get(id), `Full scaffold differs for ${id}`);
        }));
      }
      await assert.rejects(client.callTool({ name: 'get_scaffold', arguments: { id: 999999999 } }),
        e => e instanceof ResourceNotFoundError);
      assert.equal(stderr(), '');
    } finally {
      await client.close();
      await transport.close();
    }
  }
  assert.deepEqual(await readFile(data), bytes);
});

test('actual stdio server lists and serves every archived entry exactly', { timeout: 120_000 }, async () => {
  const before = await readFile(data);
  const hash = createHash('sha256').update(before).digest('hex');
  const expected = new Map<number, Record<string, unknown>>();
  // Split on ASCII LF only: U+2028/U+2029 are valid characters within JSON strings.
  for (const line of before.toString('utf8').split('\n')) {
    if (line) {
      const row = JSON.parse(line) as Record<string, unknown>;
      expected.set(row.id as number, row);
    }
  }
  assert.equal(expected.size, 6466);
  const { client, transport, stderr } = connection();
  try {
    await client.connect(transport);
    assert.ok(client.getServerCapabilities()?.resources);
    const seen = new Map<number, string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await client.request({ method: 'resources/list', params: cursor === undefined ? {} : { cursor } });
      pages += 1;
      assert.ok(result.resources.length > 0 && result.resources.length <= 200);
      for (const resource of result.resources) {
        const id = Number(resource.uri.split('/').at(-1));
        assert.ok(!seen.has(id), `Repeated ${id}`);
        assert.equal(resource.title, expected.get(id)?.title);
        seen.set(id, resource.uri);
      }
      cursor = result.nextCursor;
    } while (cursor);
    assert.equal(pages, 33);
    assert.equal((await client.listResources()).resources.length, expected.size);
    assert.deepEqual(new Set(seen.keys()), new Set(expected.keys()));
    const pairs = [...seen];
    for (let offset = 0; offset < pairs.length; offset += 16) {
      await Promise.all(pairs.slice(offset, offset + 16).map(async ([id, uri]) => {
        const read = await client.readResource({ uri });
        assert.equal(read.contents.length, 1);
        assert.equal(read.contents[0]!.uri, uri);
        assert.equal(read.contents[0]!.mimeType, 'text/plain');
        assert.equal(textOf(read), expected.get(id)!.text, `Text differs for ${id}`);
      }));
    }
    for (const id of [pairs[0]![0], pairs.at(-1)![0], 7172, 9789, 13047, 25221]) {
      const read = await client.readResource({ uri: `copypasta://posts/${id}/record` });
      assert.deepEqual(JSON.parse(textOf(read)), expected.get(id));
    }
    const scaffolds = await client.listResourceTemplates();
    assert.deepEqual(scaffolds.resourceTemplates.map(r => r.uriTemplate), ['copypasta://posts/{id}', 'copypasta://posts/{id}/record']);
    await assert.rejects(client.listResources({ cursor: 'invalid' }), e => e instanceof ProtocolError && e.code === INVALID_PARAMS);
    await assert.rejects(client.readResource({ uri: 'file:///etc/passwd' }), e => e instanceof ResourceNotFoundError);
    assert.equal(stderr(), '');
  } finally {
    await client.close();
    await transport.close();
  }
  assert.equal(createHash('sha256').update(await readFile(data)).digest('hex'), hash);
});

test('modern protocol, custom corpus, and snapshot stability over stdio', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'writing-scaffold-'));
  const path = join(directory, 'fixture.jsonl');
  const record = { id: 3, type: 'page', title: 'Unicode 😀', text: '  /\\\n /__\\ \u2028\u2029😀',
    url: 'https://example.test/3', copy_blocks: [{ kind: 'pre', text: 'variant' }] };
  await writeFile(path, JSON.stringify(record) + '\n');
  const { client, transport, stderr } = connection(['--data', path], true);
  try {
    await client.connect(transport);
    const list = await client.listResources();
    assert.equal(list.resources.length, 1);
    assert.equal(list.nextCursor, undefined);
    // Modern pinned clients start stdio lazily on the first request, not connect().
    await writeFile(path, '{changed after startup');
    const result = await client.readResource({ uri: 'copypasta://posts/3' });
    assert.equal(textOf(result), record.text);
    const json = await client.readResource({ uri: 'copypasta://posts/3/record' });
    assert.deepEqual(JSON.parse(textOf(json)), record);
    assert.equal(stderr(), '');
  } catch (error) {
    throw new Error(`Modern stdio check failed. Server stderr: ${stderr()}`, { cause: error });
  } finally {
    await client.close();
    await transport.close();
    await rm(directory, { recursive: true });
  }
});

test('startup failures use stderr and a failing exit, never protocol stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'writing-scaffold-invalid-'));
  const bad = join(directory, 'bad.jsonl');
  await writeFile(bad, '{malformed');
  try {
    for (const args of [['--data', join(directory, 'missing.jsonl')], ['--data', bad], ['--unknown']]) {
      await assert.rejects(exec(process.execPath, [entry, ...args]), (e: unknown) => {
        const error = e as Error & { code: number; stdout: string; stderr: string };
        assert.notEqual(error.code, 0);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /writing-scaffold:/);
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});
