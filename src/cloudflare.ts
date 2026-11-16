import { isSetupRequest, renderSetupPage } from './setup-page.js';
import { logRequest } from './request-log.js';
import type { RequestLogBucket } from './request-log.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createScaffoldServer } from './archive-server.js';
import { ARCHIVE_INSTRUCTIONS } from './archive-prompts.js';
import { ARCHIVE_TOOLS, callArchiveTool } from './archive-tools.js';
import { CloudflareScaffoldStore } from './cloudflare-store.js';
import type { AssetBinding, CloudflareCatalog } from './cloudflare-store.js';

interface Env { ASSETS: AssetBinding; REQUEST_LOGS: RequestLogBucket }
const stores = new WeakMap<AssetBinding, Promise<CloudflareScaffoldStore>>();
function getStore(assets: AssetBinding): Promise<CloudflareScaffoldStore> {
  let promise = stores.get(assets);
  if (!promise) {
    promise = (async () => {
      const response = await assets.fetch('https://library.invalid/__library/catalog.json');
      if (!response.ok) throw new Error(`Scaffold catalog unavailable: ${response.status}`);
      return new CloudflareScaffoldStore(await response.json() as CloudflareCatalog, assets);
    })();
    stores.set(assets, promise);
    void promise.catch(() => stores.delete(assets));
  }
  return promise;
}


async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // All paths pass through this Worker, so raw build assets are never public routes.
    if (url.pathname !== '/' && url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return new Response('Forbidden origin', { status: 403 });
    if ((url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) ||
        (url.pathname === '/mcp' && isSetupRequest(request))) {
      return new Response(request.method === 'HEAD' ? null : renderSetupPage(new URL('/mcp', url).href), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
    }
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    // This endpoint has no notifications/subscriptions that need an idle stream.
    // Construct its per-request handler after assets load and close it after streaming.
    const store = await getStore(env.ASSETS);
    const handler = createMcpHandler(() => createScaffoldServer({
      tools: ARCHIVE_TOOLS,
      instructions: ARCHIVE_INSTRUCTIONS,
      callTool: (name, args) => callArchiveTool(name, args, store),
      listResources: cursor => store.list(cursor),
      readResource: uri => store.read(uri),
      additionalResourceScaffolds: store.additionalResourceScaffolds,
    }), { maxRequestBodySize: 1024 * 1024, keepAliveMs: 0 });
    try {
      const response = await handler.fetch(request);
      if (!response.body) { await handler.close(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { controller.close(); await handler.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { controller.error(error); await handler.close(); }
        },
        async cancel(reason) { await reader.cancel(reason); await handler.close(); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { await handler.close(); throw error; }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return logRequest(request, env.REQUEST_LOGS, req => route(req, env));
  },
};
