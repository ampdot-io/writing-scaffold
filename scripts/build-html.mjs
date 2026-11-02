import { readFile, writeFile } from 'node:fs/promises';
import { SCAFFOLD_SOURCES } from '../dist/sources.js';
const template = await readFile(new URL('../web/detemplatize.html', import.meta.url), 'utf8');
await writeFile(new URL('../dist/detemplatize.html', import.meta.url), template.replace('__SOURCES__', JSON.stringify(SCAFFOLD_SOURCES)));
console.log('Built dist/detemplatize.html (self-contained styles and scripts)');
