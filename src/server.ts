import { SERVER_INSTRUCTIONS } from './prompts.js';
import { callScaffoldTool, SCAFFOLD_TOOLS } from './scaffold-tools.js';
import { createScaffoldServer } from './archive-server.js';
import type { ScaffoldStore } from './scaffold-store.js';

export function createServer(corpus: ScaffoldStore) {
  return createScaffoldServer({
    tools: SCAFFOLD_TOOLS,
    instructions: SERVER_INSTRUCTIONS,
    callTool: (name, args, signal) => callScaffoldTool(name, args, corpus, signal),
    listResources: cursor => corpus.list(cursor),
    readResource: uri => corpus.read(uri),
    ...(corpus.additionalResourceScaffolds ? { additionalResourceScaffolds: corpus.additionalResourceScaffolds } : {}),
  });
}
