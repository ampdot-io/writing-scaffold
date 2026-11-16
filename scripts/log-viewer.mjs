import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { extractTopics, permittedRequest, keyBefore } from './log-viewer/core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cachePath = resolve(process.env.WRITING_LOG_CACHE || resolve(root, '.local/topic-viewer/cache.json'));
const port = Number(process.env.WRITING_LOG_PORT || 54101);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid WRITING_LOG_PORT');
const html = await readFile(new URL('./log-viewer/index.html', import.meta.url));
const seen = new Set();
const rows = new Map();
const clients = new Set();
let lastPoll;
let state = { phase: 'Connecting to private storage', checkedAt: null, scanned: 0 };
function ingest(key, record) {
  for (const row of extractTopics(key, record)) rows.set(row.id, row);
  seen.add(key);
}
try {
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  for (const key of cache.seen) seen.add(key);
  for (const row of cache.rows) rows.set(row.id, row);
  if (cache.lastPoll) lastPoll = cache.lastPoll;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (process.env.WRITING_LOG_SEED) {
  const seed = JSON.parse(await readFile(process.env.WRITING_LOG_SEED, 'utf8'));
  for (const item of seed.records) if (item.record) ingest(item.key, item.record);
  if (seed.fetchedAt) lastPoll = Math.max(lastPoll || 0, Date.parse(seed.fetchedAt));
}
const sortedRows = () => [...rows.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
const send = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
function broadcast(type, data) { for (const res of clients) send(res, type, data); }
function update(change) { state = { ...state, ...change }; broadcast('state', state); }
const server = createServer((req, res) => {
  if (!permittedRequest(req, port)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    send(res, 'snapshot', sortedRows()); send(res, 'state', state);
    clients.add(res); req.on('close', () => clients.delete(res));
  } else if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
  } else if (pathname === '/export.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="writing-scaffold-topics.json"' });
    res.end(JSON.stringify(sortedRows(), null, 2));
  } else { res.writeHead(404); res.end('Not found'); }
});
await new Promise((ok, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ok); });
console.log(`Private topic viewer: http://127.0.0.1:${port}`);
const heartbeat = setInterval(() => { for (const res of clients) res.write(': heartbeat\n\n'); }, 15_000);
const proxy = await getPlatformProxy({ configPath: fileURLToPath(new URL('./log-viewer/remote.jsonc', import.meta.url)), persist: false, envFiles: [] });
const bucket = proxy.env.REQUEST_LOGS;
let stopped = false;
async function save() {
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
  await writeFile(cachePath + '.tmp', JSON.stringify({ seen: [...seen], rows: sortedRows(), lastPoll }), { mode: 0o600 });
  await rename(cachePath + '.tmp', cachePath);
}
async function retry(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 4) throw error;
      await new Promise(ok => setTimeout(ok, 500 * 2 ** attempt + Math.random() * 250));
    }
  }
}
async function poll() {
  const started = Date.now();
  const fresh = [];
  let cursor;
  update({ phase: lastPoll ? 'Checking for new requests' : 'Loading request history' });
  do {
    const page = await retry(() => bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}), ...(lastPoll ? { startAfter: keyBefore(lastPoll) } : {}) }));
    for (const object of page.objects) if (!seen.has(object.key)) fresh.push(object);
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor) await new Promise(ok => setTimeout(ok, 200));
  } while (cursor && !stopped);
  let next = 0;
  let failed = 0;
  const before = rows.size;
  async function worker() {
    while (next < fresh.length && !stopped) {
      const { key } = fresh[next++];
      try {
        const object = await retry(() => bucket.get(key));
        if (!object) { failed++; continue; }
        const record = await object.json();
        const found = extractTopics(key, record);
        ingest(key, record);
        for (const row of found) broadcast('topic', row);
        if (seen.size % 100 === 0) update({ scanned: seen.size });
      } catch { failed++; }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  if (!failed) lastPoll = started;
  await save();
  update({ phase: failed ? `Retrying ${failed} unread requests` : 'Live · checking every 5 seconds', checkedAt: new Date().toISOString(), scanned: seen.size, error: null });
  console.log(`${state.checkedAt}: ${fresh.length} new requests, ${rows.size - before} new topic calls${failed ? `, ${failed} retrying` : ''}`);
}
async function loop() {
  if (stopped) return;
  try { await poll(); }
  catch (error) { update({ phase: 'Connection interrupted · retrying', error: String(error.message).slice(0, 300) }); console.error('Log poll failed; retrying.'); }
  if (!stopped) timer = setTimeout(loop, 5000);
}
let timer;
async function close() {
  stopped = true; clearTimeout(timer); clearInterval(heartbeat);
  for (const res of clients) res.end();
  server.close(); await proxy.dispose(); process.exit(0);
}
process.once('SIGINT', close); process.once('SIGTERM', close);
await loop();
