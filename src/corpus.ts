import { createHash, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { INVALID_PARAMS, ProtocolError, ResourceNotFoundError } from '@modelcontextprotocol/server';
import type { ListResourcesResult, ReadResourceResult, Resource } from '@modelcontextprotocol/server';
import { LABELED_CORPUS_SHA256, NSFW_SCAFFOLD_IDS } from './nsfw-labels.js';
import type { ScaffoldCatalog, ScaffoldId } from './scaffold-store.js';
export type { ScaffoldCatalog } from './scaffold-store.js';

export const PAGE_SIZE = 200;
/** Visible characters stored per entry; the upper bound for a requested preview length. */
export const MAX_PREVIEW_LENGTH = 300;
/** Preview length used when list_scaffolds is called without preview_length. */
export const DEFAULT_PREVIEW_LENGTH = 120;
export const URI_SCAFFOLD = 'copypasta://posts/{id}';
export const RECORD_SCAFFOLD = 'copypasta://posts/{id}/record';

interface CorpusRecord extends Record<string, unknown> {
  id: number;
  type: 'post' | 'page';
  title: string;
  url: string;
  text: string;
  copy_blocks: { kind: string; text: string }[];
  nsfw?: boolean;
}

interface Entry {
  id: number;
  sequential_id: number;
  start: number;
  end: number;
  resource: Resource;
  previewSegments: string[];
  length: number;
  nsfw: boolean;
}

const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function summarizeText(text: string): { previewSegments: string[]; length: number } {
  const previewSegments: string[] = [];
  let length = 0;
  for (const { segment } of characters.segment(text)) {
    if (length < MAX_PREVIEW_LENGTH) previewSegments.push(segment);
    length += 1;
  }
  return { previewSegments, length };
}

export function validatePreviewLength(value: unknown): number {
  if (value === undefined) return DEFAULT_PREVIEW_LENGTH;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_PREVIEW_LENGTH) {
    throw new ProtocolError(INVALID_PARAMS, `preview_length must be an integer from 1 to ${MAX_PREVIEW_LENGTH}`);
  }
  return value;
}

function validateRecord(value: unknown, line: number): asserts value is CorpusRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid corpus record at line ${line}: expected an object`);
  }
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.id) || (row.id as number) <= 0 ||
      (row.type !== 'post' && row.type !== 'page') ||
      typeof row.title !== 'string' || typeof row.url !== 'string' ||
      typeof row.text !== 'string' || (row.nsfw !== undefined && typeof row.nsfw !== 'boolean') ||
      !Array.isArray(row.copy_blocks) ||
      !row.copy_blocks.every(block => block !== null && typeof block === 'object' &&
        typeof block.kind === 'string' && typeof block.text === 'string')) {
    throw new Error(`Invalid corpus record at line ${line}: invalid ID, type, title, URL, text, NSFW label, or copy blocks`);
  }
}

/** One immutable UTF-8 snapshot, indexed by byte ranges rather than keeping every parsed object. */
export class Corpus {
  readonly fingerprint: string;
  readonly size: number;
  private readonly entries: Entry[] = [];
  private readonly safeEntries: Entry[] = [];
  private readonly byId = new Map<number, Entry>();

  constructor(private readonly bytes: Buffer) {
    this.fingerprint = createHash('sha256').update(bytes).digest('hex');
    const hasArchiveLabels = this.fingerprint === LABELED_CORPUS_SHA256;
    let start = 0;
    let line = 0;
    while (start < bytes.length) {
      line += 1;
      const newline = bytes.indexOf(0x0a, start);
      const end = newline < 0 ? bytes.length : newline;
      if (end > start) {
        let row: unknown;
        try {
          row = JSON.parse(bytes.subarray(start, end).toString('utf8'));
        } catch {
          throw new Error(`Invalid corpus JSON at line ${line}`);
        }
        validateRecord(row, line);
        if (this.byId.has(row.id)) throw new Error(`Duplicate corpus ID ${row.id} at line ${line}`);
        const entry: Entry = {
          id: row.id, sequential_id: 0, start, end, ...summarizeText(row.text),
          nsfw: row.nsfw ?? (hasArchiveLabels ? NSFW_SCAFFOLD_IDS.has(row.id) : true),
          resource: {
            uri: `copypasta://posts/${row.id}`,
            name: `${row.title} [${row.id}]`,
            title: row.title,
            description: `${row.type === 'page' ? 'Collection' : 'Post'}; ${row.copy_blocks.length} copy blocks. Source: ${row.url}`,
            mimeType: 'text/plain',
            size: Buffer.byteLength(row.text, 'utf8'),
          },
        };
        this.entries.push(entry);
        this.byId.set(row.id, entry);
      }
      start = end + 1;
    }
    if (this.entries.length === 0) throw new Error('Corpus contains no records');
    this.entries.sort((a, b) => a.id - b.id);
    this.entries.forEach((entry, index) => { entry.sequential_id = index + 1; });
    this.safeEntries.push(...this.entries.filter(entry => !entry.nsfw));
    this.size = this.entries.length;
  }

  static async load(path: string): Promise<Corpus> {
    return new Corpus(await readFile(path));
  }

  private cursor(offset: number): string {
    return Buffer.from(JSON.stringify({ v: 1, corpus: this.fingerprint, offset })).toString('base64url');
  }

  private resourceOffset(cursor?: string): number {
    let offset = 0;
    if (cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw new Error();
        const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!decoded || typeof decoded !== 'object') throw new Error();
        const candidate = (decoded as { offset?: unknown }).offset;
        if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate <= 0 ||
            candidate >= this.size || candidate % PAGE_SIZE !== 0 || this.cursor(candidate) !== cursor) {
          throw new Error();
        }
        offset = candidate;
      } catch {
        throw new ProtocolError(INVALID_PARAMS, 'Invalid or stale resource cursor; restart resources/list without a cursor');
      }
    }
    return offset;
  }

  list(cursor?: string): ListResourcesResult {
    const offset = this.resourceOffset(cursor);
    const next = offset + PAGE_SIZE;
    return {
      resources: this.entries.slice(offset, next).map(entry => ({ ...entry.resource })),
      ...(next < this.size ? { nextCursor: this.cursor(next) } : {}),
    };
  }

  listScaffolds(nsfw = false, previewLength = DEFAULT_PREVIEW_LENGTH): ScaffoldCatalog {
    const limit = validatePreviewLength(previewLength);
    const entries = nsfw ? this.entries : this.safeEntries;
    const scaffolds = entries.map(({ id, sequential_id, previewSegments, length, nsfw }) =>
      ({ id, sequential_id, preview: previewSegments.slice(0, limit).join(''), length, nsfw }));
    for (let i = scaffolds.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [scaffolds[i], scaffolds[j]] = [scaffolds[j]!, scaffolds[i]!];
    }
    return {
      scaffolds,
      total: this.size,
    };
  }

  getScaffold(id: ScaffoldId): string {
    if (typeof id !== 'number') throw new ResourceNotFoundError(`scaffold://entries/${id}`);
    const entry = this.byId.get(id);
    if (!entry) throw new ResourceNotFoundError(`copypasta://posts/${id}`);
    const row = JSON.parse(this.bytes.subarray(entry.start, entry.end).toString('utf8')) as CorpusRecord;
    return row.text;
  }

  getScaffoldBySequentialId(id: number): string {
    const entry = Number.isSafeInteger(id) && id > 0 ? this.entries[id - 1] : undefined;
    if (!entry) throw new ResourceNotFoundError(`scaffold://sequential/${id}`);
    return this.getScaffold(entry.id);
  }

  read(uri: string): ReadResourceResult {
    // URI input selects an indexed ID only. It is never used as a filesystem path or network URL.
    const match = /^copypasta:\/\/posts\/([1-9][0-9]*)(\/record)?$/.exec(uri);
    if (!match) throw new ResourceNotFoundError(uri);
    const id = Number(match[1]);
    const entry = Number.isSafeInteger(id) ? this.byId.get(id) : undefined;
    if (!entry) throw new ResourceNotFoundError(uri);
    const row = JSON.parse(this.bytes.subarray(entry.start, entry.end).toString('utf8')) as CorpusRecord;
    const isRecord = match[2] !== undefined;
    return {
      contents: [{
        uri,
        mimeType: isRecord ? 'application/json' : 'text/plain',
        text: isRecord ? JSON.stringify(row) : row.text,
      }],
    };
  }
}
