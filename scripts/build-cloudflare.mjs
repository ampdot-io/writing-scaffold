import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Corpus } from '../dist/corpus.js';
import { loadBundledLibrary } from '../dist/bundled-library.js';
import { loadOriginalBytes, loadImportedBytes } from '../dist/runtime-assets.js';

const root = new URL('../', import.meta.url);
const destination = new URL('../dist/cloudflare/assets/', import.meta.url);
await mkdir(new URL('__library/records/', destination), { recursive: true });
// Keep the public benchmark snapshot byte-for-byte identical to its source.
await writeFile(new URL('pangram-miss-benchmark.html', destination),
  await readFile(new URL('../web/pangram-miss-benchmark.html', import.meta.url)));
const originalBytes = await loadOriginalBytes();
const importedBytes = await loadImportedBytes();
const library = await loadBundledLibrary(new Corpus(originalBytes));
const records = Object.create(null);
for (const [bytes, original] of [[originalBytes, true], [importedBytes, false]]) {
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!original && row.source === 'mcsweeneys') continue;
    const file = `${row.id}.json`;
    const json = JSON.stringify(row);
    if (Buffer.byteLength(json) > 25 * 1024 * 1024) throw new Error(`Record ${row.id} exceeds Cloudflare's asset limit`);
    await writeFile(new URL(`__library/records/${file}`, destination), json);
    records[String(row.id)] = `/__library/records/${file}`;
  }
}
const resources = [];
let cursor;
do {
  const page = library.list(cursor);
  resources.push(...page.resources);
  cursor = page.nextCursor;
} while (cursor);
const sequential = Object.create(null);
for (const row of new Corpus(originalBytes).listScaffolds(true, 300).scaffolds) sequential[String(row.sequential_id)] = row.id;
for (const line of importedBytes.toString('utf8').split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row.source !== 'mcsweeneys') sequential[String(row.sequential_id)] = row.id;
}
const listing = library.listScaffolds(true, 300);
const catalog = {
  version: 1, fingerprint: library.fingerprint, total: listing.total,
  scaffolds: listing.scaffolds.sort((a, b) => a.sequential_id - b.sequential_id),
  resources, references: library.listReferences(true).references,
  records, sequential, additionalResourceScaffolds: library.additionalResourceScaffolds,
};
const catalogJson = JSON.stringify(catalog);
if (Buffer.byteLength(catalogJson) > 25 * 1024 * 1024) throw new Error('Catalog exceeds the asset limit');
await writeFile(new URL('__library/catalog.json', destination), catalogJson);
const result = await build({
  absWorkingDir: root.pathname, entryPoints: ['src/cloudflare.ts'],
  outfile: new URL('../dist/cloudflare/worker.mjs', import.meta.url).pathname,
  bundle: true, platform: 'neutral', target: 'es2022', format: 'esm',
  mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'],
  external: ['node:*'], metafile: true, minify: true, legalComments: 'none',
});
const forbidden = Object.keys(result.metafile.inputs).filter(path => /(?:detemplatize|provider-http|llama3-tokenizer|hybrid-|clause-moves|\/http\.ts$)/.test(path));
if (forbidden.length) throw new Error(`Public bundle includes private rewriting dependencies: ${forbidden.join(', ')}`);
await writeFile(new URL('../dist/cloudflare/build.json', import.meta.url), JSON.stringify({
  records: Object.keys(records).length, scaffolds: listing.total, catalogBytes: Buffer.byteLength(catalogJson),
  fingerprint: library.fingerprint, workerSha256: createHash('sha256').update(await readFile(new URL('../dist/cloudflare/worker.mjs', import.meta.url))).digest('hex'),
  inputs: Object.keys(result.metafile.inputs),
}, null, 2));
console.log(`Built public Worker: ${listing.total} scaffolds, ${Object.keys(records).length} records, no rewriting code.`);
