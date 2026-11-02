#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Corpus } from './corpus.js';
import { createServer } from './server.js';
import { loadBundledLibrary } from './bundled-library.js';
import { loadOriginalBytes } from './runtime-assets.js';
import { serveHttp } from './http.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { data: { type: 'string' }, transport: { type: 'string', default: 'stdio' },
      host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '3000' },
      help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log('Usage: writing-scaffold [--transport stdio|http] [--host 127.0.0.1] [--port 3000] [--data file.jsonl]\n' +
      'Default: stdio with the bundled source library. HTTP endpoint: /mcp.\n' +
      '--data or WRITING_SCAFFOLD_CORPUS selects a standalone original-format corpus.\n' +
      'WRITING_SCAFFOLD_JEV_PROMPT overrides the detemplatize prompt.');
    return;
  }
  if (values.transport !== 'stdio' && values.transport !== 'http') throw new Error('--transport must be stdio or http');
  if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) throw new Error('--port must be an integer from 0 to 65535');
  if (!values.host.trim()) throw new Error('--host must not be empty');
  const data = values.data ?? process.env.WRITING_SCAFFOLD_CORPUS;
  if (values.data === '') throw new Error('--data must name a JSONL file');
  const original = data ? await Corpus.load(data) : new Corpus(await loadOriginalBytes());
  const standalone = values.data !== undefined || Boolean(process.env.WRITING_SCAFFOLD_CORPUS);
  const corpus = standalone ? original : await loadBundledLibrary(original);
  const handle = values.transport === 'http'
    ? await serveHttp(() => createServer(corpus), { host: values.host, port: Number(values.port) })
    : serveStdio(() => createServer(corpus), {
    onerror: error => console.error(`writing-scaffold: ${error.message}`),
  });
  const shutdown = (): void => { void handle.close().catch(error => {
    console.error(`writing-scaffold: ${String(error)}`);
    process.exitCode = 1;
  }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => {
  console.error(`writing-scaffold: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
