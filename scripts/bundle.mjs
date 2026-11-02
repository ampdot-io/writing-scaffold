import { build } from 'esbuild';
import { readFile, chmod, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { OPTIONAL_COLLECTION_PATHS } from '../dist/runtime-assets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const original = await readFile(new URL('../artifacts/copypastatext/copypastas.jsonl', import.meta.url));
const imports = [await readFile(new URL('../artifacts/library/imports.jsonl', import.meta.url))];
const included = ['artifacts/copypastatext/copypastas.jsonl', 'artifacts/library/imports.jsonl'];
for (const path of OPTIONAL_COLLECTION_PATHS) {
  try {
    imports.push(await readFile(new URL(path, import.meta.url)));
    included.push(path.replace(/^\.\.\//, ''));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const pack = bytes => JSON.stringify(gzipSync(bytes, { level: 9 }).toString('base64'));
const prompt = await readFile(new URL('../prompts/detemplatize-jev.txt', import.meta.url), 'utf8');
const html = await readFile(new URL('../dist/detemplatize.html', import.meta.url), 'utf8');
const assets = `
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
export const IS_STANDALONE_BUNDLE = true;
export async function loadWebApp() { return ${JSON.stringify(html)}; }
export const ENV_PATH = new URL('file:///unused');
export const JEV_PROMPT_PATH = new URL('file:///embedded-detemplatize-jev.txt');
export const OPTIONAL_COLLECTION_PATHS = ${JSON.stringify(OPTIONAL_COLLECTION_PATHS)};
export async function loadOriginalBytes() { return gunzipSync(Buffer.from(${pack(original)}, 'base64')); }
export async function loadImportedBytes() { return gunzipSync(Buffer.from(${pack(Buffer.concat(imports.flatMap(bytes => [bytes, Buffer.from('\n')])))}, 'base64')); }
export async function loadJevPrompt() {
  return process.env.WRITING_SCAFFOLD_JEV_PROMPT ? readFile(process.env.WRITING_SCAFFOLD_JEV_PROMPT, 'utf8') : ${JSON.stringify(prompt)};
}
`;
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const outfile = `${root}dist/writing-scaffold.mjs`;
await build({
  absWorkingDir: root, entryPoints: ['src/index.ts'], outfile,
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'inline',
  plugins: [{ name: 'embedded-runtime-assets', setup(build) {
    build.onLoad({ filter: /[/\\]runtime-assets\.ts$/ }, () => ({ contents: assets, loader: 'js' }));
  } }],
});
await chmod(outfile, 0o755);
console.log(`Bundled ${included.length} data files plus prompt and dependencies into ${outfile} (${(await stat(outfile)).size} bytes)`);
