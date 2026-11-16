import { ResourceNotFoundError, ProtocolError, INVALID_PARAMS } from '@modelcontextprotocol/server';
import type { ListResourcesResult, ReadResourceResult, Resource } from '@modelcontextprotocol/server';
import type { ScaffoldCatalog, ScaffoldId, ScaffoldSummary, ReferenceSummary, ScaffoldStore } from './scaffold-store.js';
import { DEFAULT_PREVIEW_LENGTH, MAX_PREVIEW_LENGTH, validatePreviewLength } from './corpus.js';

export interface AssetBinding { fetch(input: Request | string): Promise<Response> }
export interface CloudflareCatalog {
  version: 1;
  fingerprint: string;
  total: number;
  scaffolds: ScaffoldSummary<ScaffoldId>[];
  resources: Resource[];
  references: ReferenceSummary[];
  records: Record<string, string>;
  sequential: Record<string, ScaffoldId>;
  additionalResourceScaffolds: NonNullable<ScaffoldStore['additionalResourceScaffolds']>;
}

/** The catalog stays in memory; full texts and provenance load only when requested. */
export class CloudflareScaffoldStore {
  readonly fingerprint: string;
  readonly additionalResourceScaffolds: CloudflareCatalog['additionalResourceScaffolds'];
  private readonly pageSize: number;

  constructor(private readonly catalog: CloudflareCatalog, private readonly assets: AssetBinding) {
    if (catalog.version !== 1) throw new Error('Unsupported scaffold catalog');
    this.fingerprint = catalog.fingerprint;
    this.additionalResourceScaffolds = catalog.additionalResourceScaffolds;
    this.pageSize = Math.max(200, Math.ceil(catalog.resources.length / 64));
  }

  listScaffolds(nsfw = false, previewLength = DEFAULT_PREVIEW_LENGTH): ScaffoldCatalog<ScaffoldId> {
    const limit = validatePreviewLength(previewLength);
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const scaffolds = this.catalog.scaffolds.filter(row => nsfw || !row.nsfw).map(row => {
      let preview = row.preview;
      if (limit !== MAX_PREVIEW_LENGTH) {
        if (/^[\x00-\x7F]*$/.test(preview) && !preview.includes('\r\n')) preview = preview.slice(0, limit);
        else {
          const parts: string[] = [];
          for (const { segment } of segmenter.segment(preview)) {
            if (parts.length === limit) break;
            parts.push(segment);
          }
          preview = parts.join('');
        }
      }
      return { ...row, preview };
    });
    return { scaffolds, total: this.catalog.total };
  }

  listReferences(nsfw = false) {
    return { references: this.catalog.references.filter(row => nsfw || !row.nsfw), total: this.catalog.references.length };
  }

  private async record(id: ScaffoldId): Promise<Record<string, unknown> & { text: string }> {
    const asset = this.catalog.records[String(id)];
    if (!asset) throw new ResourceNotFoundError(`scaffold://entries/${id}`);
    const response = await this.assets.fetch(`https://library.invalid${asset}`);
    if (!response.ok) throw new Error(`Scaffold asset unavailable: ${response.status}`);
    const record = await response.json() as Record<string, unknown> & { text: string };
    if (typeof record.text !== 'string') throw new Error('Invalid scaffold asset');
    return record;
  }

  async getScaffold(id: ScaffoldId): Promise<string> { return (await this.record(id)).text; }

  getScaffoldBySequentialId(id: number): Promise<string> {
    const canonical = this.catalog.sequential[String(id)];
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
            decoded.offset >= this.catalog.resources.length || decoded.offset % this.pageSize !== 0 || this.cursor(decoded.offset) !== cursor) throw Error();
        offset = decoded.offset;
      } catch { throw new ProtocolError(INVALID_PARAMS, 'Invalid or stale library cursor'); }
    }
    const next = offset + this.pageSize;
    return { resources: this.catalog.resources.slice(offset, next).map(row => ({ ...row })),
      ...(next < this.catalog.resources.length ? { nextCursor: this.cursor(next) } : {}) };
  }

  async read(uri: string): Promise<ReadResourceResult> {
    const original = /^copypasta:\/\/posts\/([1-9][0-9]*)(\/record)?$/.exec(uri);
    const imported = /^scaffold:\/\/entries\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/record)?$/.exec(uri);
    const match = original ?? imported;
    if (!match) throw new ResourceNotFoundError(uri);
    const id = original ? Number(match[1]) : match[1]!;
    if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new ResourceNotFoundError(uri);
    const record = await this.record(id);
    return { contents: [{ uri, mimeType: match[2] ? 'application/json' : 'text/plain',
      text: match[2] ? JSON.stringify(record) : record.text }] };
  }
}
