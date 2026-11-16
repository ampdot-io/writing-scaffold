import type { ListResourcesResult, ReadResourceResult } from '@modelcontextprotocol/server';

export type ScaffoldId = number | string;
export interface ScaffoldSummary<Id extends ScaffoldId = number> {
  id: Id;
  sequential_id: number;
  preview: string;
  length: number;
  nsfw: boolean;
  source?: string;
  title?: string;
  author?: string | null;
  content_kind?: string;
}
export interface ScaffoldCatalog<Id extends ScaffoldId = number> {
  scaffolds: ScaffoldSummary<Id>[];
  total: number;
}
export interface ReferenceSummary {
  id: string; sequential_id: number; title: string; author: string | null;
  source: string; url: string; nsfw: boolean; published?: string;
}
export interface ScaffoldStore {
  listScaffolds(nsfw?: boolean, previewLength?: number): ScaffoldCatalog<ScaffoldId>;
  listReferences?(nsfw?: boolean): { references: ReferenceSummary[]; total: number };
  getScaffold(id: ScaffoldId): string;
  getScaffoldBySequentialId(id: number): string;
  list(cursor?: string): ListResourcesResult;
  read(uri: string): ReadResourceResult;
  additionalResourceScaffolds?: {
    uriTemplate: string; name: string; title: string; description: string; mimeType: string;
  }[];
}
export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const isUuid = (value: unknown): value is string => typeof value === 'string' && new RegExp(UUID_PATTERN).test(value);

/** Public deployments load record text asynchronously from asset storage. */
export type AsyncScaffoldStore = Omit<ScaffoldStore, 'getScaffold' | 'getScaffoldBySequentialId' | 'read'> & {
  getScaffold(id: ScaffoldId): string | Promise<string>;
  getScaffoldBySequentialId(id: number): string | Promise<string>;
  read(uri: string): ReadResourceResult | Promise<ReadResourceResult>;
};
