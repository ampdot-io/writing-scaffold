import { readFile } from 'node:fs/promises';

export const OPTIONAL_COLLECTION_PATHS = [
  '../artifacts/queneau/scaffolds.jsonl',
  '../artifacts/snowclones/scaffolds.jsonl',
  '../artifacts/sec-s1/scaffolds.jsonl',
  '../artifacts/halimedemf/scaffolds.jsonl',
  '../artifacts/rfc/scaffolds.jsonl',
  '../artifacts/press-releases/scaffolds.jsonl',
  '../artifacts/common-sense/scaffolds.jsonl',
  '../artifacts/iso-iec/scaffolds.jsonl',
  '../artifacts/ntsb/scaffolds.jsonl',
  '../artifacts/elife/scaffolds.jsonl',
  '../artifacts/spoon-river/scaffolds.jsonl',
  '../artifacts/fantastic-fables/scaffolds.jsonl',
  '../artifacts/proclamations/scaffolds.jsonl',
  '../artifacts/scotus-oral-arguments/scaffolds.jsonl',
  '../artifacts/congressional-hearings/scaffolds.jsonl',
  '../artifacts/uspto/scaffolds.jsonl',
  '../artifacts/tumblr/scaffolds.jsonl',
  '../artifacts/fourchan/scaffolds.jsonl',
  '../artifacts/lesswrong/scaffolds.jsonl',
] as const;

export const IS_STANDALONE_BUNDLE = false;
export const JEV_PROMPT_PATH = new URL('../prompts/detemplatize-jev.txt', import.meta.url);
export const ENV_PATH = new URL('../../../.env', import.meta.url);

export function loadOriginalBytes(): Promise<Buffer> {
  return readFile(new URL('../artifacts/copypastatext/copypastas.jsonl', import.meta.url));
}
export async function loadImportedBytes(): Promise<Buffer> {
  const collections = [await readFile(new URL('../artifacts/library/imports.jsonl', import.meta.url))];
  for (const path of OPTIONAL_COLLECTION_PATHS) {
    try { collections.push(await readFile(new URL(path, import.meta.url))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return Buffer.concat(collections.flatMap(bytes => [bytes, Buffer.from('\n')]));
}
export function loadJevPrompt(): Promise<string> {
  return readFile(process.env.WRITING_SCAFFOLD_JEV_PROMPT || JEV_PROMPT_PATH, 'utf8');
}

export function loadWebApp(): Promise<string> {
  return readFile(new URL('../dist/detemplatize.html', import.meta.url), 'utf8');
}
