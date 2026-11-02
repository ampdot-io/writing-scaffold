import assert from 'node:assert/strict';
import type { ReadResourceResult } from '@modelcontextprotocol/server';

export function textOf(result: ReadResourceResult): string {
  assert.equal(result.contents.length, 1);
  const content = result.contents[0]!;
  assert.ok('text' in content, 'Expected a text resource, not binary content');
  return content.text;
}

export interface ParsedScaffold {
  length: number;
  preview: string;
  nsfw?: boolean;
  sequential_id: number;
  source: string;
}

export interface ParsedCatalog {
  total: number;
  eligible: number;
  offset: number;
  listed: number;
  previewLength: number;
  maxChars: number;
  nextCursor?: string;
  columns: string[];
  scaffolds: ParsedScaffold[];
}

const UNESCAPES: Record<string, string> = { '\\\\': '\\', '\\t': '\t', '\\n': '\n', '\\r': '\r' };

export function unescapeField(field: string): string {
  return field.replace(/\\[\\tnr]/g, m => UNESCAPES[m]!);
}

/** Parse the client-facing sequential-ID catalog. */
export function parseCatalog(text: string): ParsedCatalog {
  const lines = text.split('\n');
  const head = /^# total (\d+), eligible (\d+), offset (\d+), listed (\d+), preview_length (\d+), max_chars (\d+), next_cursor (none|[A-Za-z0-9_-]+)\. Escapes in preview: \\t tab, \\n newline, \\r carriage return, \\\\ backslash\.$/.exec(lines[0] ?? '');
  assert.ok(head, `Unexpected comment line: ${lines[0]}`);
  const progress = lines[1] ?? '';
  const headerEnd = lines.findIndex(line => !line.startsWith('#'));
  assert.equal(headerEnd, 2, `Expected exactly two comment lines before the column header: ${lines.slice(0, 3).join(' | ')}`);
  const columns = lines[2]!.split('\t');
  for (const required of ['sequential_id', 'source', 'length', 'preview']) assert.ok(columns.includes(required), `Header lacks ${required}: ${lines[2]}`);
  assert.ok(!columns.includes('id'), 'canonical id is not a listing column');
  assert.equal(columns.at(-1), 'preview', `preview must be the last column: ${lines[2]}`);
  assert.equal(new Set(columns).size, columns.length, `Duplicate columns: ${lines[2]}`);
  const scaffolds = lines.slice(3).map(line => {
    const fields = line.split('\t');
    assert.equal(fields.length, columns.length, `Field count differs on: ${line}`);
    const get = (name: string) => fields[columns.indexOf(name)]!;
    const entry: ParsedScaffold = {
      sequential_id: Number(get('sequential_id')),
      source: unescapeField(get('source')),
      length: Number(get('length')),
      preview: unescapeField(get('preview')),
    };
    if (columns.includes('nsfw')) {
      const nsfw = get('nsfw');
      assert.ok(nsfw === 'true' || nsfw === 'false', `Bad nsfw value on: ${line}`);
      entry.nsfw = nsfw === 'true';
    }
    assert.ok(Number.isSafeInteger(entry.sequential_id) && entry.sequential_id > 0);
    return entry;
  });
  const parsed: ParsedCatalog = {
    total: Number(head[1]), eligible: Number(head[2]), offset: Number(head[3]), listed: Number(head[4]),
    previewLength: Number(head[5]), maxChars: Number(head[6]), columns, scaffolds,
  };
  if (head[7] !== 'none') parsed.nextCursor = head[7]!;
  const shown = parsed.offset + scaffolds.length;
  if (parsed.nextCursor === undefined) {
    assert.equal(progress, `# ${shown} of ${parsed.eligible} shown; this is the last page.`);
  } else {
    assert.equal(progress, `# ${shown} of ${parsed.eligible} shown so far; ${parsed.eligible - shown} remain. Use the cursor above for the next page.`);
  }
  assert.equal(parsed.listed, scaffolds.length);
  assert.ok(parsed.offset + parsed.listed <= parsed.eligible);
  assert.equal(parsed.nextCursor === undefined, parsed.offset + parsed.listed === parsed.eligible, 'a cursor is issued exactly while entries remain');
  assert.ok(text.length <= parsed.maxChars || parsed.listed <= 1, 'a page fits max_chars unless a single entry overflows it');
  return parsed;
}
