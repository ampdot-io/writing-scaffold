import { SERVER_DESCRIPTION } from './sources.js';
import { Server } from '@modelcontextprotocol/server';
import { RECORD_SCAFFOLD, URI_SCAFFOLD } from './corpus.js';
import type { Tool, CallToolResult, ListResourcesResult, ReadResourceResult } from '@modelcontextprotocol/server';
import type { ScaffoldStore } from './scaffold-store.js';

type MaybePromise<T> = T | Promise<T>;
export interface ScaffoldBackend {
  tools: Tool[];
  instructions: string;
  callTool(name: string, args: unknown, signal: AbortSignal): MaybePromise<CallToolResult>;
  listResources(cursor?: string): MaybePromise<ListResourcesResult>;
  readResource(uri: string): MaybePromise<ReadResourceResult>;
  additionalResourceScaffolds?: ScaffoldStore['additionalResourceScaffolds'];
}

export function createScaffoldServer(backend: ScaffoldBackend): Server {
  const server = new Server(
    { name: 'writing-scaffold', version: '0.1.0', description: SERVER_DESCRIPTION },
    {
      capabilities: { resources: {}, tools: {} },
      instructions: backend.instructions,
    },
  );
  server.setRequestHandler('tools/list', () => ({ tools: backend.tools }));
  server.setRequestHandler('tools/call', (request, extra) => backend.callTool(request.params.name, request.params.arguments, extra.mcpReq.signal));
  server.setRequestHandler('resources/list', request => backend.listResources(request.params?.cursor));
  server.setRequestHandler('resources/read', request => backend.readResource(request.params.uri));
  server.setRequestHandler('resources/templates/list', () => ({
    resourceTemplates: [
      {
        uriTemplate: URI_SCAFFOLD, name: 'copypasta-text', title: 'Copypasta text',
        description: 'Exact text for any listed entry ID, including standalone collections.', mimeType: 'text/plain',
      },
      {
        uriTemplate: RECORD_SCAFFOLD, name: 'copypasta-record', title: 'Complete copypasta record',
        description: 'Original metadata, separate variants, article text, source URLs, and HTML for an entry ID.',
        mimeType: 'application/json',
      },
      ...(backend.additionalResourceScaffolds ?? []),
    ],
  }));
  return server;
}
