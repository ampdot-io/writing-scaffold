import { DEFAULT_PAGE_CHARS, MIN_PAGE_CHARS, MAX_PAGE_CHARS, MAX_PAGE_LIMIT } from './catalog-settings.js';
import { writeWithScaffoldPrompt } from './archive-prompts.js';
export { DEFAULT_PAGE_CHARS, MIN_PAGE_CHARS, MAX_PAGE_CHARS, MAX_PAGE_LIMIT } from './catalog-settings.js';
export { writeWithScaffoldPrompt } from './archive-prompts.js';
import { randomInt } from 'node:crypto';
import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { DEFAULT_PREVIEW_LENGTH, MAX_PREVIEW_LENGTH, validatePreviewLength } from './corpus.js';
import { isUuid, UUID_PATTERN } from './scaffold-store.js';
import type { AsyncScaffoldStore, ScaffoldStore, ScaffoldCatalog, ScaffoldId, ReferenceSummary } from './scaffold-store.js';
import { SCAFFOLD_SOURCES } from './sources.js';
import type { ScaffoldSource } from './sources.js';
export { SCAFFOLD_SOURCES } from './sources.js';

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const ARCHIVE_TOOLS: Tool[] = [
  {
    name: 'write_with_scaffold',
    description: 'Return a prompt to find an appropriate archived scaffold for an objective and topic, then follow it exactly.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'What the writing should accomplish.' },
        topic: { type: 'string', description: 'What the writing should be about.' },
      },
      required: ['objective', 'topic'],
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: 'get_scaffold',
    description: 'Read a cached writing scaffold or an explicitly marked external reference. Provide exactly one lookup: id (original numeric post ID or imported UUID), or sequential_id (stable client catalog alias). A sequential alias must be passed as sequential_id, not id. Works through tool-only connections.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: UUID_PATTERN }], description: 'Canonical archive ID: original numeric post ID or persistent random UUID.' },
        sequential_id: { type: 'integer', minimum: 1, description: 'Stable sequential_id from a catalog entry, independent of shuffled order.' },
      },
      oneOf: [{ required: ['id'] }, { required: ['sequential_id'] }],
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: 'list_scaffolds',
    description: `List every eligible writing scaffold in a fresh random order on each call, as tab-separated lines: a comment line with the archive total, the listed count, and the preview length; a second comment line saying how many entries have been shown so far, how many remain, without repeating the continuation cursor; a column header; then one line per entry with sequential_id, source, length, and preview (plus an nsfw column when nsfw: true). Use include_sources to select collections and exclude_sources to hide collections; exclusions take precedence. Omit include_sources for all sources; [] selects none. source is single-source shorthand, mutually exclusive with include_sources. Available sources: ${SCAFFOLD_SOURCES.join(', ')}. total counts the selected sources after source exclusions and before NSFW filtering. Both source filters are inherited from cursor and cannot change mid-listing. The preview is the first ${DEFAULT_PREVIEW_LENGTH} Unicode characters by default (preview_length adjusts this, up to ${MAX_PREVIEW_LENGTH}); length counts Unicode grapheme clusters in the full text. Tab, newline, carriage return, and backslash inside a preview are escaped as \\t \\n \\r \\\\. NSFW labels identify scaffolds primarily usable for NSFW intentions. NSFW entries are excluded by default; pass nsfw: true to include them. Entries come in pages sized by max_chars (default ${DEFAULT_PAGE_CHARS} characters) and optionally by limit: the first line reports total, eligible, offset, listed, preview_length, max_chars, and next_cursor (none on the last page); pass next_cursor back as cursor to continue the same listing in the same order. The order is shuffled afresh for each new listing and fixed for all its pages.`,
    inputSchema: {
      type: 'object',
      properties: {
        nsfw: { type: 'boolean', default: false, description: 'Include entries labeled NSFW. Omitted or false excludes them.' },
        source: { type: 'string', enum: [...SCAFFOLD_SOURCES], description: 'Single-source shorthand for include_sources. Do not combine with include_sources. Inherited from cursor on later pages.' },
        include_sources: {
          type: 'array', items: { type: 'string', enum: [...SCAFFOLD_SOURCES] }, uniqueItems: true, maxItems: SCAFFOLD_SOURCES.length,
          description: 'Only list these sources. Omit for all sources; [] selects none. Do not combine with source. Inherited from cursor on later pages.',
        },
        exclude_sources: {
          type: 'array', items: { type: 'string', enum: [...SCAFFOLD_SOURCES] }, uniqueItems: true, maxItems: SCAFFOLD_SOURCES.length,
          description: 'Hide these sources, even if included by source or include_sources. Omit or [] excludes none. Inherited from cursor on later pages.',
        },
        preview_length: {
          type: 'integer', minimum: 1, maximum: MAX_PREVIEW_LENGTH, default: DEFAULT_PREVIEW_LENGTH,
          description: `Visible characters of each scaffold to include in its preview, 1 to ${MAX_PREVIEW_LENGTH}. Smaller values shorten the listing.`,
        },
        max_chars: {
          type: 'integer', minimum: MIN_PAGE_CHARS, maximum: MAX_PAGE_CHARS, default: DEFAULT_PAGE_CHARS,
          description: `Character budget for one page of output, including the header lines; default ${DEFAULT_PAGE_CHARS}. A page stops before the entry that would exceed it (at least one entry is always included).`,
        },
        limit: {
          type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT,
          description: 'Optional cap on entries per page, applied together with max_chars.',
        },
        cursor: {
          type: 'string',
          description: 'next_cursor from a previous page, to continue the same listing in the same order. Omit to start a new listing.',
        },
      },
      not: { required: ['source', 'include_sources'] },
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: 'list_references',
    description: 'List enabled external writing references as TSV. Article bodies are not cached. Entries have a stable sequential_id, title, author and URL. Results are shuffled per call. NSFW reference entries require nsfw: true. Use get_scaffold to retrieve the bibliographic reference, not the external article body.',
    inputSchema: { type: 'object', properties: { nsfw: { type: 'boolean', default: false } }, additionalProperties: false },
    annotations,
  },
];


interface SourceFilter { include_sources?: ScaffoldSource[]; exclude_sources?: ScaffoldSource[] }
interface PageCursor extends SourceFilter { v: 2; store: string; nsfw: boolean; seed: number; offset: number; eligible: number; source?: ScaffoldSource }

function isSource(value: unknown): value is ScaffoldSource {
  return typeof value === 'string' && (SCAFFOLD_SOURCES as readonly string[]).includes(value);
}

function sourceList(value: unknown, name: string): ScaffoldSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > SCAFFOLD_SOURCES.length || !value.every(isSource) || new Set(value).size !== value.length) {
    throw new ProtocolError(INVALID_PARAMS, `${name} must be an array of unique sources from: ${SCAFFOLD_SOURCES.join(', ')}`);
  }
  return SCAFFOLD_SOURCES.filter(source => value.includes(source));
}

function sameSources(left: ScaffoldSource[] | undefined, right: ScaffoldSource[] | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

const CURSOR_ERROR = 'Invalid or stale list_scaffolds cursor; start again without a cursor';

function decodeCursor(token: unknown, store: string): PageCursor {
  try {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(token)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error();
    const { v, store: owner, nsfw, seed, offset, eligible, source } = parsed as Record<string, unknown>;
    const include = sourceList((parsed as Record<string, unknown>).include_sources, 'include_sources');
    const exclude = sourceList((parsed as Record<string, unknown>).exclude_sources, 'exclude_sources');
    if (v !== 2 || owner !== store || typeof nsfw !== 'boolean' ||
        typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff ||
        typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
        typeof eligible !== 'number' || !Number.isSafeInteger(eligible) || offset >= eligible ||
        (source !== undefined && (!isSource(source) || include !== undefined))) throw new Error();
    const cursor: PageCursor = { v: 2, store, nsfw, seed, offset, eligible, ...(source === undefined ? {} : { source: source as ScaffoldSource }),
      ...(include === undefined ? {} : { include_sources: include }), ...(exclude === undefined ? {} : { exclude_sources: exclude }) };
    if (encodeCursor(cursor) !== token) throw new Error();
    return cursor;
  } catch {
    throw new ProtocolError(INVALID_PARAMS, CURSOR_ERROR);
  }
}

function validateMaxChars(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE_CHARS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_PAGE_CHARS || value > MAX_PAGE_CHARS) {
    throw new ProtocolError(INVALID_PARAMS, `max_chars must be an integer from ${MIN_PAGE_CHARS} to ${MAX_PAGE_CHARS}`);
  }
  return value;
}

function validateLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new ProtocolError(INVALID_PARAMS, `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
  }
  return value;
}

/** Deterministic 32-bit PRNG (mulberry32) so one seed yields one order across pages. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Order a catalog by seed: canonical sequential_id order, then a seeded Fisher-Yates shuffle. */
export function orderScaffolds(catalog: ScaffoldCatalog<ScaffoldId>, seed: number): ScaffoldCatalog<ScaffoldId>['scaffolds'] {
  const ordered = [...catalog.scaffolds].sort((a, b) => a.sequential_id - b.sequential_id);
  const random = seededRandom(seed);
  for (let i = ordered.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
  }
  return ordered;
}

function storeKey(store: Pick<ScaffoldStore, 'listScaffolds'>): string {
  const fingerprint = (store as { fingerprint?: unknown }).fingerprint;
  return typeof fingerprint === 'string' ? fingerprint.slice(0, 16) : 'store';
}

const ESCAPES: Record<string, string> = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };

function escapeField(text: string): string {
  return text.replace(/[\\\t\n\r]/g, c => ESCAPES[c]!);
}

const PREVIEW_ESCAPE_NOTE = 'Escapes in preview: \\t tab, \\n newline, \\r carriage return, \\\\ backslash.';

function headerLine(total: number, eligible: number, offset: number, listed: number, previewLength: number, maxChars: number, nextCursor: string | undefined): string {
  return `# total ${total}, eligible ${eligible}, offset ${offset}, listed ${listed}, preview_length ${previewLength}, max_chars ${maxChars}, next_cursor ${nextCursor ?? 'none'}. ${PREVIEW_ESCAPE_NOTE}`;
}

/** Plain-language progress line so a model that has read nothing else knows how to get the next page. */
function progressLine(eligible: number, shown: number, hasMore: boolean): string {
  if (!hasMore) return `# ${shown} of ${eligible} shown; this is the last page.`;
  return `# ${shown} of ${eligible} shown so far; ${eligible - shown} remain. Use the cursor above for the next page.`;
}

function entryLine(entry: ScaffoldCatalog<ScaffoldId>['scaffolds'][number], includeNsfw: boolean): string {
  const { sequential_id, source, length, nsfw, preview } = entry;
  const prefix = `${sequential_id}\t${escapeField(source ?? 'copypastatext')}\t${length}`;
  return includeNsfw ? `${prefix}\t${nsfw}\t${escapeField(preview)}` : `${prefix}\t${escapeField(preview)}`;
}

/**
 * Render one page of a listing as TSV: a stats comment line, a progress comment line, a header row, then one entry per line.
 * The page holds as many entries as fit in max_chars (and limit, when given); a cursor for the
 * following page is issued while entries remain. The first page of a listing draws a fresh seed.
 */
export function renderScaffoldPage(store: Pick<ScaffoldStore, 'listScaffolds'>, values: Record<string, unknown>): string {
  const previewLength = validatePreviewLength(values.preview_length);
  const maxChars = validateMaxChars(values.max_chars);
  const limit = validateLimit(values.limit);
  const key = storeKey(store);
  const cursor = values.cursor === undefined ? undefined : decodeCursor(values.cursor, key);
  if (values.source !== undefined && !isSource(values.source)) {
    throw new ProtocolError(INVALID_PARAMS, `source must be one of: ${SCAFFOLD_SOURCES.join(', ')}`);
  }
  if (values.source !== undefined && values.include_sources !== undefined) {
    throw new ProtocolError(INVALID_PARAMS, 'Provide only one of source or include_sources');
  }
  const requestedInclude = sourceList(values.include_sources, 'include_sources') ?? (values.source === undefined ? undefined : [values.source as ScaffoldSource]);
  const requestedExclude = sourceList(values.exclude_sources, 'exclude_sources');
  const cursorInclude = cursor?.source === undefined ? cursor?.include_sources : [cursor.source];
  if (cursor && requestedInclude !== undefined && !sameSources(requestedInclude, cursorInclude)) {
    throw new ProtocolError(INVALID_PARAMS, 'source must match the listing the cursor came from (source/include_sources)');
  }
  if (cursor && requestedExclude !== undefined && !sameSources(requestedExclude, cursor.exclude_sources ?? [])) {
    throw new ProtocolError(INVALID_PARAMS, 'exclude_sources must match the listing the cursor came from');
  }
  const include = cursor ? cursorInclude : requestedInclude;
  const exclude = cursor ? cursor.exclude_sources : requestedExclude;
  if (cursor && values.nsfw !== undefined && values.nsfw !== cursor.nsfw) {
    throw new ProtocolError(INVALID_PARAMS, 'nsfw must match the listing the cursor came from');
  }
  const includeNsfw = cursor ? cursor.nsfw : values.nsfw === true;
  let catalog = store.listScaffolds(includeNsfw, previewLength);
  if (include !== undefined || exclude?.length) {
    const all = store.listScaffolds(true, previewLength).scaffolds.filter(r => {
      const source = r.source ?? 'copypastatext';
      return (include === undefined || include.includes(source as ScaffoldSource)) && !exclude?.includes(source as ScaffoldSource);
    });
    catalog = { total: all.length, scaffolds: includeNsfw ? all : all.filter(r => !r.nsfw) };
  }
  const eligible = catalog.scaffolds.length;
  if (cursor && cursor.eligible !== eligible) throw new ProtocolError(INVALID_PARAMS, CURSOR_ERROR);
  const seed = cursor?.seed ?? randomInt(0, 0x100000000);
  const offset = cursor?.offset ?? 0;
  const ordered = orderScaffolds(catalog, seed);
  const columns = includeNsfw ? 'sequential_id\tsource\tlength\tnsfw\tpreview' : 'sequential_id\tsource\tlength\tpreview';
  const sourceState: SourceFilter = { ...(include === undefined ? {} : { include_sources: include }), ...(exclude === undefined ? {} : { exclude_sources: exclude }) };
  const widestCursor = encodeCursor({ v: 2, store: key, nsfw: includeNsfw, seed, offset: Math.max(eligible - 1, 0), eligible, ...sourceState });
  // Reserve the widest possible header lines: the cursor at its largest offset, every count at the digit
  // width of `eligible` (the progress line's "remain" is 0 when shown = eligible, so pad for its digits).
  const widestProgress = progressLine(eligible, eligible, true).length + (String(eligible).length - 1);
  let used = headerLine(catalog.total, eligible, offset, eligible, previewLength, maxChars, widestCursor).length + 1 +
    widestProgress + 1 + columns.length;
  const lines: string[] = [];
  let next = offset;
  while (next < eligible && (limit === undefined || lines.length < limit)) {
    const line = entryLine(ordered[next]!, includeNsfw);
    if (lines.length > 0 && used + 1 + line.length > maxChars) break;
    lines.push(line);
    used += 1 + line.length;
    next += 1;
  }
  const nextCursor = next < eligible ? encodeCursor({ v: 2, store: key, nsfw: includeNsfw, seed, offset: next, eligible, ...sourceState }) : undefined;
  return [
    headerLine(catalog.total, eligible, offset, lines.length, previewLength, maxChars, nextCursor),
    progressLine(eligible, next, nextCursor !== undefined),
    columns,
    ...lines,
  ].join('\n');
}

function formatReferenceCatalog(references: ReferenceSummary[], total: number, includeNsfw: boolean): string {
  const lines = [`# total ${total}, listed ${references.length}. External reference metadata only; article bodies are not cached.`,
    'sequential_id\tauthor\ttitle\turl' + (includeNsfw ? '\tnsfw' : '')];
  for (const r of references) {
    const fields = [String(r.sequential_id), r.author ?? '', r.title, r.url].map(escapeField);
    if (includeNsfw) fields.push(String(r.nsfw));
    lines.push(fields.join('\t'));
  }
  return lines.join('\n');
}

/** Synchronous adapter retained for the local, in-memory library. */
export function callLocalScaffoldTool(name: string, args: unknown, corpus: ScaffoldStore): CallToolResult {
  return callArchiveTool(name, args, corpus) as CallToolResult;
}

function textResult(value: string | Promise<string>): CallToolResult | Promise<CallToolResult> {
  const wrap = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
  return typeof value === 'string' ? wrap(value) : value.then(wrap);
}

/** Credential-free tools support lazy asset reads in the public deployment. */
export function callArchiveTool(name: string, args: unknown, corpus: AsyncScaffoldStore): CallToolResult | Promise<CallToolResult> {
  if (!ARCHIVE_TOOLS.some(tool => tool.name === name)) {
    throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`);
  }
  const input = args === undefined ? {} : args;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError(INVALID_PARAMS, 'Tool arguments must be an object');
  }
  const values = input as Record<string, unknown>;
  if (name === 'get_scaffold') {
    const hasId = Object.hasOwn(values, 'id');
    const hasSequential = Object.hasOwn(values, 'sequential_id');
    if (hasId === hasSequential || Object.keys(values).some(key => key !== 'id' && key !== 'sequential_id')) {
      throw new ProtocolError(INVALID_PARAMS, 'Provide exactly one of id or sequential_id');
    }
    if (hasSequential) {
      if (typeof values.sequential_id !== 'number' || !Number.isSafeInteger(values.sequential_id) || values.sequential_id <= 0) {
        throw new ProtocolError(INVALID_PARAMS, 'sequential_id must be a positive integer');
      }
      return textResult(corpus.getScaffoldBySequentialId(values.sequential_id));
    }
    if (!isUuid(values.id) && !(typeof values.id === 'number' && Number.isSafeInteger(values.id) && values.id > 0)) {
      throw new ProtocolError(INVALID_PARAMS, 'id must be an original positive numeric ID or a UUID');
    }
    return textResult(corpus.getScaffold(values.id));
  }
  if (name === 'list_references') {
    if ((values.nsfw !== undefined && typeof values.nsfw !== 'boolean') || Object.keys(values).some(key => key !== 'nsfw')) {
      throw new ProtocolError(INVALID_PARAMS, 'list_references accepts only an optional boolean nsfw');
    }
    const catalog = corpus.listReferences?.(values.nsfw === true) ?? { references: [], total: 0 };
    return { content: [{ type: 'text', text: formatReferenceCatalog(catalog.references, catalog.total, values.nsfw === true) }] };
  }
  if (name === 'list_scaffolds') {
    if ((values.nsfw !== undefined && typeof values.nsfw !== 'boolean') ||
        Object.keys(values).some(key => !['nsfw', 'source', 'include_sources', 'exclude_sources', 'preview_length', 'max_chars', 'limit', 'cursor'].includes(key))) {
      throw new ProtocolError(INVALID_PARAMS, 'list_scaffolds accepts only optional nsfw (boolean), source (string), include_sources and exclude_sources (source arrays), preview_length, max_chars, limit (integers), and cursor (string)');
    }
    return { content: [{ type: 'text', text: renderScaffoldPage(corpus, values) }] };
  }
  if (typeof values.objective !== 'string' || typeof values.topic !== 'string' ||
      Object.keys(values).some(key => key !== 'objective' && key !== 'topic')) {
    throw new ProtocolError(INVALID_PARAMS, 'write_with_scaffold requires exactly objective and topic, both strings');
  }
  return { content: [{ type: 'text', text: writeWithScaffoldPrompt(values.objective, values.topic) }] };
}
