import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INVALID_PARAMS, ProtocolError, ResourceNotFoundError } from '@modelcontextprotocol/server';
import { Corpus, PAGE_SIZE } from '../src/corpus.js';
import { textOf } from './content.js';

const row = (id: number, text = `post ${id}`) => ({
  id, type: 'post', title: `Title ${id}`, url: `https://example.test/${id}/`, text, nsfw: false,
  copy_blocks: [{ kind: 'pre', text }],
});
const corpus = (rows: unknown[]) => new Corpus(Buffer.from(rows.map(r => JSON.stringify(r)).join('\n')));

test('all entries are listed once, in ID order, across resource pages', () => {
  const c = corpus(Array.from({ length: 207 }, (_, i) => row(207 - i)));
  const resources = [];
  let cursor: string | undefined;
  do {
    const page = c.list(cursor);
    assert.ok(page.resources.length <= PAGE_SIZE);
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(resources.map(r => r.uri), Array.from({ length: 207 }, (_, i) => `copypasta://posts/${i + 1}`));
  assert.equal(new Set(resources.map(r => r.uri)).size, 207);
  assert.equal(resources[0]!.title, 'Title 1');
  resources[0]!.title = 'client modification';
  assert.equal(c.list().resources[0]!.title, 'Title 1');
});

test('text reads preserve indentation, CRLF, Unicode separators and emoji; JSON preserves every field', () => {
  const original = { ...row(41, '  /\\\r\n /__\\  \u2028\u2029😀\n'), type: 'page', extra: { notes: ['original', 42] } };
  const c = corpus([original]);
  const text = c.read('copypasta://posts/41').contents[0]!;
  assert.equal(text.mimeType, 'text/plain');
  assert.equal(textOf(c.read('copypasta://posts/41')), original.text);
  assert.equal(c.list().resources[0]!.size, Buffer.byteLength(original.text));
  assert.match(c.list().resources[0]!.description!, /^Collection;/);
  const record = c.read('copypasta://posts/41/record').contents[0]!;
  assert.equal(record.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(textOf(c.read('copypasta://posts/41/record'))), original);
});

test('invalid, forged and foreign-snapshot cursors fail without losing a valid cursor', () => {
  const c = corpus(Array.from({ length: PAGE_SIZE + 1 }, (_, i) => row(i + 1)));
  const valid = c.list().nextCursor!;
  const foreign = corpus(Array.from({ length: PAGE_SIZE + 1 }, (_, i) => row(i + 1, 'different'))).list().nextCursor!;
  const invalid = (offset: unknown) => Buffer.from(JSON.stringify({ v: 1, corpus: c.fingerprint, offset })).toString('base64url');
  for (const cursor of ['', 'garbage', valid + '=', foreign, invalid(0), invalid(-1), invalid(1), invalid(c.size), invalid(1e100)]) {
    assert.throws(() => c.list(cursor), e => e instanceof ProtocolError && e.code === INVALID_PARAMS);
  }
  assert.equal(c.list(valid).resources[0]!.uri, `copypasta://posts/${PAGE_SIZE + 1}`);
});

test('unknown and malformed URIs are resource errors, never file reads', () => {
  const c = corpus([row(1)]);
  for (const uri of ['copypasta://posts/2', 'file:///etc/passwd', 'https://example.test/',
    'copypasta://posts/01', 'copypasta://posts/1?raw=true', 'copypasta://posts/1#fragment',
    'copypasta://posts/%31', 'copypasta://posts/../1', 'copypasta://posts/9007199254740993',
    'copypasta://posts/1/record/extra']) {
    assert.throws(() => c.read(uri), e => e instanceof ResourceNotFoundError && e.uri === uri);
  }
});

test('invalid records and duplicate IDs fail startup instead of serving a partial corpus', () => {
  for (const rows of [[], [null], [row(1), row(1)], [{ ...row(1), text: 42 }],
    [{ ...row(1), id: -1 }], [{ ...row(1), id: 1.5 }], [{ ...row(1), copy_blocks: [null] }],
    [{ ...row(1), nsfw: 'false' }], [{ ...row(1), nsfw: null }]]) {
    assert.throws(() => corpus(rows));
  }
  assert.throws(() => new Corpus(Buffer.from('{ broken\n')), /line 1/);
  assert.throws(() => new Corpus(Buffer.from(`${JSON.stringify(row(1))}\n{broken`)), /line 2/);
});

test('small corpora return every eligible ID and preserve up to the first 300 visible characters', () => {
  const family = '👩‍👩‍👧‍👦';
  const accent = 'e\u0301';
  const first = 'x'.repeat(299) + family;
  const second = '😀'.repeat(299) + accent;
  const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => row(i + 1, `short ${i + 1}`));
  rows[0] = row(1, first + 'not part of preview');
  rows[1] = row(2, second + 'not part of preview');
  const c = corpus(rows.reverse());
  const catalog = c.listScaffolds(false, 300);
  const { scaffolds } = catalog;
  assert.equal(catalog.total, rows.length);
  assert.deepEqual(Object.keys(catalog), ['scaffolds', 'total']);
  assert.deepEqual(scaffolds.map(t => t.id).sort((a, b) => a - b), Array.from({ length: rows.length }, (_, i) => i + 1));
  const previews = new Map(scaffolds.map(t => [t.id, t.preview]));
  assert.equal(previews.get(1), first);
  assert.equal(previews.get(2), second);
  assert.equal(previews.get(3), 'short 3');
  const lengths = new Map(scaffolds.map(t => [t.id, t.length]));
  assert.equal(lengths.get(1), 319);
  assert.equal(lengths.get(2), 319);
  assert.equal(lengths.get(3), 7);
  assert.equal(c.getScaffold(1), first + 'not part of preview');
  assert.throws(() => c.getScaffold(99999), ResourceNotFoundError);
  const defaults = new Map(c.listScaffolds().scaffolds.map(t => [t.id, t.preview]));
  assert.equal(defaults.get(1), 'x'.repeat(120));
  assert.equal(defaults.get(2), '😀'.repeat(120));
  assert.equal(defaults.get(3), 'short 3');
  const tiny = new Map(c.listScaffolds(false, 1).scaffolds.map(t => [t.id, t.preview]));
  assert.equal(tiny.get(1), 'x');
  assert.equal(tiny.get(2), '😀');
  assert.equal(c.listScaffolds(false, 300).scaffolds.find(t => t.id === 2)?.preview, second);
  for (const bad of [0, 301, 2.5, Number.NaN, -1]) {
    assert.throws(() => c.listScaffolds(false, bad), e => e instanceof ProtocolError && e.code === INVALID_PARAMS);
  }
});

test('each call shuffles every eligible scaffold without mutating stored previews or resource order', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => row(i + 1));
  const c = corpus(rows);
  const resources = c.list();
  const first = c.listScaffolds();
  const second = c.listScaffolds();
  for (const catalog of [first, second]) {
    assert.equal(catalog.total, 2000);
    assert.equal(catalog.scaffolds.length, 2000);
    assert.deepEqual(catalog.scaffolds.map(t => t.id).sort((a, b) => a - b), rows.map(t => t.id));
    for (const { id, preview, length } of catalog.scaffolds) {
      assert.ok(id >= 1 && id <= 2000);
      assert.equal(preview, `post ${id}`);
      assert.equal(length, `post ${id}`.length);
    }
  }
  assert.notDeepEqual(first.scaffolds.map(t => t.id), second.scaffolds.map(t => t.id));
  first.scaffolds[0]!.preview = 'client change';
  first.scaffolds.pop();
  assert.ok(c.listScaffolds().scaffolds.every(t => t.preview === `post ${t.id}`));
  assert.deepEqual(c.list(), resources);
  assert.equal(c.getScaffold(2000), 'post 2000');
});

test('NSFW and unclassified custom scaffolds are hidden unless explicitly included', () => {
  const c = corpus([row(1), { ...row(2), nsfw: true }, { ...row(3), nsfw: undefined }]);
  assert.deepEqual(c.listScaffolds(), { scaffolds: [{ id: 1, sequential_id: 1, preview: 'post 1', length: 6, nsfw: false }], total: 3 });
  assert.deepEqual(c.listScaffolds(false), c.listScaffolds());
  const included = c.listScaffolds(true).scaffolds.sort((a, b) => a.id - b.id);
  assert.deepEqual(included.map(({ id, nsfw }) => ({ id, nsfw })), [
    { id: 1, nsfw: false }, { id: 2, nsfw: true }, { id: 3, nsfw: true },
  ]);
  const allNsfw = corpus([{ ...row(1), nsfw: true }]);
  assert.deepEqual(allNsfw.listScaffolds(), { scaffolds: [], total: 1 });
  assert.equal(allNsfw.listScaffolds(true).scaffolds.length, 1);
});

test('listing includes all eligible entries beyond the old sample limit', () => {
  const c = corpus(Array.from({ length: 2500 }, (_, i) => ({ ...row(i + 1), nsfw: i >= 1500 })));
  const catalog = c.listScaffolds();
  assert.equal(catalog.total, 2500);
  assert.equal(catalog.scaffolds.length, 1500);
  assert.deepEqual(catalog.scaffolds.map(t => t.id).sort((a, b) => a - b), Array.from({ length: 1500 }, (_, i) => i + 1));
  assert.ok(catalog.scaffolds.every(t => !t.nsfw && t.id <= 1500));
  assert.equal(c.listScaffolds(true).scaffolds.length, 2500);
});
