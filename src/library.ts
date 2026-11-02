import { createHash, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { INVALID_PARAMS, ProtocolError, ResourceNotFoundError } from '@modelcontextprotocol/server';
import type { ListResourcesResult, ReadResourceResult, Resource } from '@modelcontextprotocol/server';
import { Corpus, PAGE_SIZE, DEFAULT_PREVIEW_LENGTH, MAX_PREVIEW_LENGTH, validatePreviewLength } from './corpus.js';
import { isUuid } from './scaffold-store.js';
import { PRUNED_CORPUS_SHA256, PRUNED_SCAFFOLD_IDS } from './pruned-scaffolds.js';
import type { ReferenceSummary, ScaffoldCatalog, ScaffoldId, ScaffoldStore, ScaffoldSummary } from './scaffold-store.js';
import { SCAFFOLD_SOURCES } from './sources.js';

export interface ImportedRecord extends Record<string, unknown> {
  id: string; sequential_id: number; type: 'scaffold'; source: string;
  title: string; text: string; text_sha256: string; url: string;
  author: string | null; content_kind: string; nsfw: boolean;
  license: Record<string, unknown>;
  discoverable?: boolean;
}

function validate(value: unknown): asserts value is ImportedRecord {
  const r = value as Partial<ImportedRecord> | null;
  if (!r || typeof r !== 'object' || !isUuid(r.id) || !Number.isSafeInteger(r.sequential_id) || r.sequential_id! <= 0 ||
      r.type !== 'scaffold' || !(r.source === 'mcsweeneys' || (r.source !== 'copypastatext' && SCAFFOLD_SOURCES.some(source => source === r.source))) ||
      typeof r.title !== 'string' || typeof r.text !== 'string' || !r.text.trim() || typeof r.url !== 'string' ||
      (r.author !== null && typeof r.author !== 'string') || typeof r.content_kind !== 'string' ||
      typeof r.nsfw !== 'boolean' || !r.license || typeof r.license !== 'object' ||
      (r.discoverable !== undefined && typeof r.discoverable !== 'boolean') ||
      r.text_sha256 !== createHash('sha256').update(r.text).digest('hex')) {
    throw new Error('Invalid imported entry: identity, reviewed label, text hash, or provenance is missing');
  }
}

const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** New providers layered over the unchanged original archive and resource URIs. */
export class Library implements ScaffoldStore {
  readonly size: number;
  readonly fingerprint: string;
  readonly additionalResourceScaffolds = [
    { uriTemplate: 'scaffold://entries/{id}', name: 'imported-entry', title: 'Imported scaffold or reference',
      description: 'Cached scaffold text or an explicitly marked external reference, by persistent UUID.', mimeType: 'text/plain' },
    { uriTemplate: 'scaffold://entries/{id}/record', name: 'imported-entry-record', title: 'Imported entry provenance',
      description: 'Source, author, license, revision and reviewed label for an imported entry.', mimeType: 'application/json' },
  ];
  private readonly imported = new Map<string, ImportedRecord>();
  private readonly sequential = new Map<number, ScaffoldId>();
  private readonly previews = new Map<string, { segments: string[]; length: number }>();
  private readonly resources: Resource[] = [];
  private readonly pageSize: number;
  private readonly scaffoldCount: number;
  private readonly referenceCount: number;
  private readonly legacyTitles = new Map<number, string>();
  private readonly prunedIds: ReadonlySet<number>;

  constructor(private readonly original: Corpus, bytes: Buffer) {
    this.prunedIds = original.fingerprint === PRUNED_CORPUS_SHA256 ? PRUNED_SCAFFOLD_IDS : new Set();
    const fingerprint = createHash('sha256').update(original.fingerprint).update(bytes).update('\nmcsweeneys-disabled');
    if (this.prunedIds.size) fingerprint.update('\npruned:').update([...this.prunedIds].sort((a,b) => a-b).join(','));
    this.fingerprint = fingerprint.digest('hex');
    for (const r of original.listScaffolds(true, 1).scaffolds) this.sequential.set(r.sequential_id, r.id);
    let cursor: string | undefined;
    do {
      const page = original.list(cursor);
      this.resources.push(...page.resources.filter(r => !this.prunedIds.has(Number(r.uri.split('/').at(-1)))));
      for (const r of page.resources) this.legacyTitles.set(Number(r.uri.split('/').at(-1)), r.title ?? r.name);
      cursor = page.nextCursor;
    } while (cursor);
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line) continue;
      const record: unknown = JSON.parse(line);
      validate(record);
      if (record.source === 'mcsweeneys') continue;
      if (this.imported.has(record.id) || this.sequential.has(record.sequential_id)) throw new Error('Duplicate imported UUID or sequential alias');
      this.imported.set(record.id, record);
      this.sequential.set(record.sequential_id, record.id);
      if (record.discoverable === false) continue;
      let length = 0;
      const segments: string[] = [];
      for (const { segment } of characters.segment(record.text)) {
        if (length < MAX_PREVIEW_LENGTH) segments.push(segment);
        length += 1;
      }
      this.previews.set(record.id, { segments, length });
      this.resources.push({ uri: `scaffold://entries/${record.id}`, name: `${record.title} [${record.sequential_id}]`,
        title: record.title, description: `${record.source}; ${record.content_kind}; ${record.url}`,
        mimeType: 'text/plain', size: Buffer.byteLength(record.text) });
    }
    const active = [...this.imported.values()].filter(r => r.discoverable !== false);
    this.referenceCount = active.filter(r => r.content_kind === 'reference').length;
    this.scaffoldCount = original.size + active.length - this.referenceCount - this.prunedIds.size;
    this.size = this.resources.length;
    const order = new Map([...this.sequential].map(([seq, id]) => [typeof id === 'number' ? `copypasta://posts/${id}` : `scaffold://entries/${id}`, seq]));
    this.resources.sort((a, b) => order.get(a.uri)! - order.get(b.uri)!);
    this.pageSize = Math.max(PAGE_SIZE, Math.ceil(this.size / 64));
  }

  static async load(original: Corpus, path: string): Promise<Library> {
    return new Library(original, await readFile(path));
  }

  listScaffolds(nsfw = false, previewLength = DEFAULT_PREVIEW_LENGTH): ScaffoldCatalog<ScaffoldId> {
    const limit = validatePreviewLength(previewLength);
    const scaffolds: ScaffoldSummary<ScaffoldId>[] = this.original.listScaffolds(nsfw, limit).scaffolds
      .filter(r => !this.prunedIds.has(r.id)).map(r =>
      ({ ...r, source: 'copypastatext', title: this.legacyTitles.get(r.id)!, content_kind: 'full_text' }));
    for (const r of this.imported.values()) {
      if (r.discoverable === false || r.content_kind === 'reference' || (!nsfw && r.nsfw)) continue;
      const summary = this.previews.get(r.id)!;
      scaffolds.push({ id: r.id, sequential_id: r.sequential_id, preview: summary.segments.slice(0, limit).join(''),
        length: summary.length, nsfw: r.nsfw, source: r.source, title: r.title, author: r.author, content_kind: r.content_kind });
    }
    return { scaffolds: shuffle(scaffolds), total: this.scaffoldCount };
  }

  listReferences(nsfw = false): { references: ReferenceSummary[]; total: number } {
    const references = [...this.imported.values()].filter(r => r.discoverable !== false && r.content_kind === 'reference' && (nsfw || !r.nsfw)).map(r => ({
      id: r.id, sequential_id: r.sequential_id, title: r.title, author: r.author, source: r.source,
      url: r.url, nsfw: r.nsfw, ...(typeof r.published === 'string' ? { published: r.published } : {}),
    }));
    return { references: shuffle(references), total: this.referenceCount };
  }

  getScaffold(id: ScaffoldId): string {
    if (typeof id === 'number') return this.original.getScaffold(id);
    const record = this.imported.get(id);
    if (!record) throw new ResourceNotFoundError(`scaffold://entries/${id}`);
    return record.text;
  }

  getScaffoldBySequentialId(id: number): string {
    const canonical = this.sequential.get(id);
    if (canonical === undefined) throw new ResourceNotFoundError(`scaffold://sequential/${id}`);
    return this.getScaffold(canonical);
  }

  private cursor(offset: number): string {
    return Buffer.from(JSON.stringify({ v: 1, library: this.fingerprint, offset })).toString('base64url');
  }

  list(cursor?: string): ListResourcesResult {
    let offset = 0;
    if (cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw Error();
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown };
        if (typeof decoded.offset !== 'number' || !Number.isSafeInteger(decoded.offset) || decoded.offset <= 0 ||
            decoded.offset >= this.size || decoded.offset % this.pageSize !== 0 || this.cursor(decoded.offset) !== cursor) throw Error();
        offset = decoded.offset;
      } catch { throw new ProtocolError(INVALID_PARAMS, 'Invalid or stale library cursor'); }
    }
    const next = offset + this.pageSize;
    return { resources: this.resources.slice(offset, next).map(r => ({ ...r })),
      ...(next < this.size ? { nextCursor: this.cursor(next) } : {}) };
  }

  read(uri: string): ReadResourceResult {
    if (uri.startsWith('copypasta://')) return this.original.read(uri);
    const match = /^scaffold:\/\/entries\/([0-9a-f-]+)(\/record)?$/.exec(uri);
    if (!match || !isUuid(match[1])) throw new ResourceNotFoundError(uri);
    const record = this.imported.get(match[1]);
    if (!record) throw new ResourceNotFoundError(uri);
    return { contents: [{ uri, mimeType: match[2] ? 'application/json' : 'text/plain',
      text: match[2] ? JSON.stringify(record) : record.text }] };
  }
}
