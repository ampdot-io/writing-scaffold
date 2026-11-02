import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';
import { callLocalScaffoldTool as dispatch, writeWithScaffoldPrompt } from '../src/scaffold-tools.js';
import { Corpus } from '../src/corpus.js';
import { parseCatalog } from './content.js';
import type { ParsedCatalog } from './content.js';

const fullText = '  ' + '😀'.repeat(80) + '\nFull scaffold, not just a preview.';
const corpus = new Corpus(Buffer.from(JSON.stringify({ id: 7, type: 'post', title: 'Example',
  url: 'https://example.test/7', text: fullText, nsfw: false, copy_blocks: [{ kind: 'pre', text: fullText }] })));
const callScaffoldTool = (name: string, args?: unknown) => dispatch(name, args, corpus);
const text = (result: ReturnType<typeof dispatch>) => {
  const content = result.content[0]!;
  assert.ok(content.type === 'text');
  return content.text;
};

test('TSV previews escape tabs, newlines, carriage returns, and backslashes', () => {
  const tricky = 'a\tb\\c\r\nd\u2028e';
  const small = new Corpus(Buffer.from(JSON.stringify({ id: 3, type: 'post', title: 'Tricky', url: 'https://example.test/3',
    text: tricky, nsfw: false, copy_blocks: [] })));
  const listed = text(dispatch('list_scaffolds', { nsfw: true }, small));
  assert.deepEqual(listed.split('\n').slice(2), ['sequential_id\tsource\tlength\tnsfw\tpreview', '1\tcopypastatext\t9\tfalse\ta\\tb\\\\c\\r\\nd\u2028e']);
  assert.deepEqual(parseCatalog(listed).scaffolds, [{ sequential_id: 1, source: 'copypastatext', length: 9, nsfw: false, preview: tricky }]);
});

test('custom writing prompt lowercases only the initial character of objective and topic and describes all 120-character previews', () => {
  const objective = 'Persuade a reader\n"Please consider it" 😀';
  const topic = 'Moon cafés\u2028and tea';
  const prompt = writeWithScaffoldPrompt(objective, topic);
  assert.match(prompt, /Find an appropriate.*scaffold/);
  assert.match(prompt, /following that scaffold exactly/);
  assert.match(prompt, /list_scaffolds\(\)/);
  assert.match(prompt, /120 characters of every eligible writing scaffold/);
  assert.match(prompt, /preview_length \(up to 300\)/);
  assert.match(prompt, /next_cursor/);
  assert.match(prompt, /45000 characters/);
  assert.doesNotMatch(prompt, /random|subset|sample/i);
  assert.match(prompt, /ID and full text/);
  assert.ok(prompt.includes('persuade a reader\n"Please consider it" 😀'));
  assert.ok(prompt.includes('moon cafés\u2028and tea'));
});

test('writing prompt preserves internal capitals, Unicode and empty inputs', () => {
  assert.match(writeWithScaffoldPrompt('Explain NASA and OpenAI', 'AI Safety in New York'), /explain NASA and OpenAI/);
  assert.match(writeWithScaffoldPrompt('Explain NASA and OpenAI', 'AI Safety in New York'), /aI Safety in New York/);
  assert.match(writeWithScaffoldPrompt('Écrire pour Paris', '𐐀 Unicode Title'), /écrire pour Paris/);
  assert.ok(writeWithScaffoldPrompt('Écrire pour Paris', '𐐀 Unicode Title').includes('𐐨 Unicode Title'));
  assert.ok(writeWithScaffoldPrompt('', '').includes('scaffold to .'));
});

test('tool contracts reject wrong types, missing fields, extra arguments, and unknown names', () => {
  const invalid: [string, unknown][] = [
    ['write_with_scaffold', undefined], ['write_with_scaffold', {}],
    ['write_with_scaffold', { objective: 42, topic: 'tea' }],
    ['write_with_scaffold', { objective: 'explain', topic: null }],
    ['write_with_scaffold', { objective: 'explain', topic: 'tea', extra: true }],
    ['write_with_scaffold', []], ['detemplatize', { topic: 'tea' }],
    ['detemplatize', null], ['detemplatize', 'text'], ['unknown', {}],
    ['get_scaffold', {}], ['get_scaffold', { id: '7' }], ['get_scaffold', { id: 0 }],
    ['get_scaffold', { id: -1 }], ['get_scaffold', { id: 7.5 }], ['get_scaffold', { id: 7, other: true }],
    ['list_scaffolds', { cursor: null }], ['list_scaffolds', { cursor: 1 }], ['list_scaffolds', { cursor: 'old cursor' }], ['list_scaffolds', { other: true }],
    ['list_scaffolds', { nsfw: 'true' }], ['list_scaffolds', { nsfw: 1 }], ['list_scaffolds', { nsfw: null }],
    ['list_scaffolds', { preview_length: 0 }], ['list_scaffolds', { preview_length: 301 }], ['list_scaffolds', { preview_length: 7.5 }],
    ['list_scaffolds', { preview_length: '10' }], ['list_scaffolds', { preview_length: null }],
    ['list_scaffolds', { limit: 0 }], ['list_scaffolds', { limit: 2.5 }], ['list_scaffolds', { limit: '5' }],
    ['list_scaffolds', { max_chars: 999 }], ['list_scaffolds', { max_chars: 100_000_001 }], ['list_scaffolds', { max_chars: '5000' }],
    ['list_scaffolds', { cursor: '' }], ['list_scaffolds', { cursor: 'bm90IGEgY3Vyc29y' }],
  ];
  for (const [name, args] of invalid) {
    assert.throws(() => callScaffoldTool(name, args), e => e instanceof ProtocolError && e.code === INVALID_PARAMS);
  }
  assert.deepEqual(callScaffoldTool('write_with_scaffold', { objective: '', topic: '' }), {
    content: [{ type: 'text', text: writeWithScaffoldPrompt('', '') }],
  });
});

test('listing and fetching work through tool text results alone', () => {
  const listed = callScaffoldTool('list_scaffolds');
  assert.deepEqual(callScaffoldTool('list_scaffolds', {}), listed);
  const first = listed.content[0]!;
  assert.ok(first.type === 'text');
  const escaped = '  ' + '😀'.repeat(80) + '\\nFull scaffold, not just a preview.';
  assert.equal(first.text, [
    '# total 1, eligible 1, offset 0, listed 1, preview_length 120, max_chars 45000, next_cursor none. Escapes in preview: \\t tab, \\n newline, \\r carriage return, \\\\ backslash.',
    '# 1 of 1 shown; this is the last page.',
    'sequential_id\tsource\tlength\tpreview',
    `1\tcopypastatext\t117\t${escaped}`,
  ].join('\n'));
  assert.deepEqual(parseCatalog(first.text), {
    total: 1, eligible: 1, offset: 0, listed: 1, previewLength: 120, maxChars: 45000, columns: ['sequential_id', 'source', 'length', 'preview'],
    scaffolds: [{ sequential_id: 1, source: 'copypastatext', length: 117, preview: fullText }],
  });
  assert.deepEqual(callScaffoldTool('list_scaffolds', { nsfw: false }), listed);
  assert.deepEqual(callScaffoldTool('list_scaffolds', { preview_length: 120 }), listed);
  assert.deepEqual(parseCatalog(text(callScaffoldTool('list_scaffolds', { preview_length: 300 }))).scaffolds,
    parseCatalog(first.text).scaffolds);
  const included = text(callScaffoldTool('list_scaffolds', { nsfw: true }));
  assert.deepEqual(included.split('\n').slice(2), ['sequential_id\tsource\tlength\tnsfw\tpreview', `1\tcopypastatext\t117\tfalse\t${escaped}`]);
  assert.deepEqual(text(callScaffoldTool('list_scaffolds', { nsfw: false, preview_length: 5 })).split('\n').at(-1), '1\tcopypastatext\t117\t  😀😀😀');
  assert.deepEqual(callScaffoldTool('get_scaffold', { id: 7 }), { content: [{ type: 'text', text: fullText }] });
  assert.deepEqual(callScaffoldTool('get_scaffold', { sequential_id: 1 }), callScaffoldTool('get_scaffold', { id: 7 }));
  assert.throws(() => callScaffoldTool('get_scaffold', { id: 7, sequential_id: 1 }), ProtocolError);
  assert.throws(() => callScaffoldTool('get_scaffold', { sequential_id: '1' }), ProtocolError);
});

const pagedCorpus = (count: number) => new Corpus(Buffer.from(Array.from({ length: count }, (_, i) => JSON.stringify({
  id: i + 1, type: 'post', title: `Title ${i + 1}`, url: `https://example.test/${i + 1}`,
  text: `Post ${i + 1}: ${'word '.repeat(10 + (i % 7))}`, nsfw: i % 5 === 4, copy_blocks: [],
})).join('\n')));

function collect(corpus: Corpus, args: Record<string, unknown>) {
  const pages: ParsedCatalog[] = [];
  let cursor: string | undefined;
  do {
    const page = parseCatalog(text(dispatch('list_scaffolds', cursor === undefined ? args : { ...args, cursor }, corpus)));
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== undefined && pages.length < 1000);
  return pages;
}

test('limit pages a listing in one fixed order, with a cursor exactly while entries remain', () => {
  const corpus = pagedCorpus(23);
  const pages = collect(corpus, { limit: 5 });
  assert.deepEqual(pages.map(p => p.listed), [5, 5, 5, 4]);
  assert.deepEqual(pages.map(p => p.offset), [0, 5, 10, 15]);
  assert.ok(pages.every(p => p.eligible === 19 && p.total === 23));
  const ids = pages.flatMap(p => p.scaffolds.map(e => e.sequential_id));
  assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i + 1).filter(id => id % 5 !== 0));
  assert.equal(new Set(ids).size, ids.length, 'no entry repeats across pages');
  const firstRaw = text(dispatch('list_scaffolds', { limit: 5 }, corpus)).split('\n');
  assert.equal(firstRaw[1], "# 5 of 19 shown so far; 14 remain. Use the cursor above for the next page.");
  for (const nsfw of [false, true]) {
    const raw = text(dispatch('list_scaffolds', { limit: 5, nsfw }, corpus));
    const token = parseCatalog(raw).nextCursor!;
    assert.equal(raw.split(token).length - 1, 1, 'the continuation token is printed once');
    assert.equal((raw.match(/next_cursor/g) ?? []).length, 1);
  }
  const again = parseCatalog(text(dispatch('list_scaffolds', { limit: 5, cursor: pages[0]!.nextCursor! }, corpus)));
  assert.deepEqual(again.scaffolds, pages[1]!.scaffolds, 'the same cursor returns the same page');
  const bigger = parseCatalog(text(dispatch('list_scaffolds', { limit: 10, preview_length: 3, cursor: pages[0]!.nextCursor! }, corpus)));
  assert.deepEqual(bigger.scaffolds.map(e => e.sequential_id), [...pages[1]!.scaffolds, ...pages[2]!.scaffolds].map(e => e.sequential_id), 'limit and preview_length may change mid-listing without changing the order');
  assert.ok(bigger.scaffolds.every(e => e.preview === 'Pos'));
  const orders = new Set(Array.from({ length: 6 }, () => collect(corpus, { limit: 100 })[0]!.scaffolds.map(e => e.sequential_id).join(',')));
  assert.ok(orders.size > 1, 'new listings draw new orders');
});

test('max_chars sizes a page by output length and always makes progress', () => {
  const corpus = pagedCorpus(40);
  const pages = collect(corpus, { max_chars: 1000, nsfw: true });
  assert.ok(pages.length > 1);
  assert.ok(pages.every(p => p.maxChars === 1000 && p.eligible === 40));
  assert.equal(pages.reduce((n, p) => n + p.listed, 0), 40);
  assert.ok(pages.slice(0, -1).every(p => p.listed >= 1));
  const single = text(dispatch('list_scaffolds', { max_chars: 1000, limit: 1 }, corpus));
  assert.equal(parseCatalog(single).listed, 1);
  const whole = parseCatalog(text(dispatch('list_scaffolds', { max_chars: 100_000_000 }, corpus)));
  assert.equal(whole.listed, 32);
  assert.equal(whole.nextCursor, undefined);
});

test('cursors are bound to their listing: nsfw filter, corpus, and well-formedness', () => {
  const corpus = pagedCorpus(12);
  const first = parseCatalog(text(dispatch('list_scaffolds', { limit: 4, nsfw: true }, corpus)));
  const cursor = first.nextCursor!;
  assert.deepEqual(parseCatalog(text(dispatch('list_scaffolds', { cursor, nsfw: true }, corpus))).offset, 4, 'matching nsfw is accepted');
  assert.deepEqual(parseCatalog(text(dispatch('list_scaffolds', { cursor }, corpus))).scaffolds.length, 8, 'omitted nsfw inherits the listing filter');
  for (const bad of [
    { cursor, nsfw: false },
    { cursor: cursor.slice(0, -2) },
    { cursor: Buffer.from(JSON.stringify({ v: 2, store: 'store', nsfw: true, seed: 1, offset: 99, eligible: 12 })).toString('base64url') },
    { cursor: Buffer.from('{"v":1}').toString('base64url') },
  ]) {
    assert.throws(() => dispatch('list_scaffolds', bad, corpus), e => e instanceof ProtocolError && e.code === INVALID_PARAMS);
  }
  const other = pagedCorpus(13);
  assert.throws(() => dispatch('list_scaffolds', { cursor }, other), e => e instanceof ProtocolError && e.code === INVALID_PARAMS, 'a cursor from another corpus is stale');
});
