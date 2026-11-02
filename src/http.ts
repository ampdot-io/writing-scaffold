import { createServer } from 'node:http';
import { loadWebApp } from './runtime-assets.js';
import { detemplatize, createDetemplatizeDependencies } from './detemplatize.js';
import { getRequestListener } from '@hono/node-server';
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse,
  localhostAllowedHostnames } from '@modelcontextprotocol/server';
import type { McpServerFactory } from '@modelcontextprotocol/server';

/** One immutable corpus is shared; the SDK creates a fresh server per request. */
export async function serveHttp(factory: McpServerFactory, options: { host: string; port: number; rewrite?: (scaffold: string, text: string, signal: AbortSignal) => Promise<string> }) {
  const handler = createMcpHandler(factory, {
    onerror: error => console.error(`writing-scaffold: ${error.message}`),
  });
  const allowedHosts = [...localhostAllowedHostnames(), options.host,
    ...(process.env.WRITING_SCAFFOLD_ALLOWED_HOSTS?.split(',').map(host => host.trim()).filter(Boolean) ?? [])];
  const listener = getRequestListener(async request => {
    const rejected = hostHeaderValidationResponse(request, allowedHosts)
      ?? originValidationResponse(request, allowedHosts);
    if (rejected) return rejected;
    const path = new URL(request.url).pathname;
    if ((path === '/app' || path === '/') && request.method === 'GET') {
      return new Response(await loadWebApp(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (path === '/api/detemplatize' && request.method === 'POST') {
      // Browser-only adapter: keep the public MCP tool's scaffold_id contract intact.
      if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response('Expected JSON', { status: 415 });
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) { await reader.cancel(); return new Response('Request is too large', { status: 413 }); }
        chunks.push(value);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
      const fields = body as { scaffold?: unknown; text?: unknown } | null;
      if (!fields || typeof fields.scaffold !== 'string' || !fields.scaffold.trim() || typeof fields.text !== 'string' || !fields.text.trim()) {
        return Response.json({ error: 'Provide nonempty scaffold and text strings' }, { status: 400 });
      }
      try {
        const text = options.rewrite
          ? await options.rewrite(fields.scaffold, fields.text, request.signal)
          : (await detemplatize(fields.scaffold, fields.text, await createDetemplatizeDependencies(), request.signal)).text;
        return Response.json({ text });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Detemplatize failed' }, { status: 502 });
      }
    }
    if (path !== '/mcp') return new Response('Not found', { status: 404 });
    return handler.fetch(request);
  }, { overrideGlobalObjects: false });
  const server = createServer(listener);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) { await handler.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP server has no TCP address');
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  console.error(`writing-scaffold: listening on http://${host}:${address.port}/mcp`);
  return {
    server,
    async close(): Promise<void> {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await handler.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
