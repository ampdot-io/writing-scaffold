import { SERVER_INSTRUCTIONS } from './prompts.js';
import { SERVER_DESCRIPTION } from './sources.js';
import { Server } from '@modelcontextprotocol/server';
import { RECORD_SCAFFOLD, URI_SCAFFOLD } from './corpus.js';
import { callScaffoldTool, SCAFFOLD_TOOLS } from './scaffold-tools.js';
import type { ScaffoldStore } from './scaffold-store.js';

export function createServer(corpus: ScaffoldStore): Server {
  const server = new Server(
    { name: 'writing-scaffold', version: '0.1.0', description: SERVER_DESCRIPTION },
    {
      capabilities: { resources: {}, tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  server.setRequestHandler('tools/list', () => ({ tools: SCAFFOLD_TOOLS }));
  server.setRequestHandler('tools/call', (request, extra) => callScaffoldTool(request.params.name, request.params.arguments, corpus, extra.mcpReq.signal));
  server.setRequestHandler('resources/list', request => corpus.list(request.params?.cursor));
  server.setRequestHandler('resources/read', request => corpus.read(request.params.uri));
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
      ...(corpus.additionalResourceScaffolds ?? []),
    ],
  }));
  return server;
}
