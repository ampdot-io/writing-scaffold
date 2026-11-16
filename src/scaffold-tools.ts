import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { ARCHIVE_TOOLS, callLocalScaffoldTool as callArchiveTool } from './archive-tools.js';
import { callDetemplatizeTool } from './detemplatize-tool.js';
import { writeWithScaffoldPrompt } from './prompts.js';
import { UUID_PATTERN } from './scaffold-store.js';
import type { ScaffoldStore } from './scaffold-store.js';
export { DEFAULT_PAGE_CHARS, MIN_PAGE_CHARS, MAX_PAGE_CHARS, MAX_PAGE_LIMIT,
  SCAFFOLD_SOURCES, orderScaffolds, renderScaffoldPage } from './archive-tools.js';
export { writeWithScaffoldPrompt } from './prompts.js';

export const SCAFFOLD_TOOLS: Tool[] = [ARCHIVE_TOOLS[0]!,
  {
    name: 'detemplatize',
    description: 'Rewrite text using Llama 3.1 8B base-model top-100 prompt logprobs and parallel TypeSafe Jev choices for tokens unchanged from the scaffold. Preserves formatting and grammatical structure; rejects proposed edits that make the following text much less likely. Numeric scaffold_id is the stable sequential_id from list_scaffolds, not a numeric canonical post ID; imported UUIDs also work. Sends the scaffold and new text to ACS and TypeSafe. Returns the rewritten text. Jev instructions are editable in prompts/detemplatize-jev.txt.',
    inputSchema: {
      type: 'object',
      properties: {
        scaffold_id: { anyOf: [{type:'integer',minimum:1},{type:'string',pattern:'^[1-9][0-9]*$'},{type:'string',pattern:UUID_PATTERN}], description:'Stable sequential_id from list_scaffolds (integer or decimal string), or an imported canonical UUID.' },
        text: {type:'string',description:'Complete new draft to detemplatize.'},
      },
      required:['scaffold_id','text'],
      additionalProperties:false,
    },
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  },
  ...ARCHIVE_TOOLS.slice(1),
];

export async function callScaffoldTool(name: string, args: unknown, corpus: ScaffoldStore, signal?: AbortSignal): Promise<CallToolResult> {
  if (name === 'detemplatize') return callDetemplatizeTool(args, corpus, undefined, signal);
  return callLocalScaffoldTool(name, args, corpus);
}

export function callLocalScaffoldTool(name: string, args: unknown, corpus: ScaffoldStore): CallToolResult {
  const result = callArchiveTool(name, args, corpus);
  if (name !== 'write_with_scaffold') return result;
  const { objective, topic } = args as { objective: string; topic: string };
  return { content: [{ type: 'text', text: writeWithScaffoldPrompt(objective, topic) }] };
}
