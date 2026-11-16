import { ARCHIVE_INSTRUCTIONS, writeWithScaffoldPrompt as archivePrompt } from './archive-prompts.js';

export function writeWithScaffoldPrompt(objective: string, topic: string): string {
  return archivePrompt(objective, topic) + " Keep the selected scaffold's sequential ID and full text, together with the draft, in this conversation so a later detemplatize call can use the same scaffold.";
}

export const SERVER_INSTRUCTIONS = ARCHIVE_INSTRUCTIONS + ' ' + 'write_with_scaffold returns writing instructions; detemplatize requires scaffold_id (the stable sequential_id from the listing, or a UUID) and text (the full new draft); it returns a rewritten draft using ACS Llama 3.1 8B base token scores and parallel TypeSafe Jev decisions. It sends the scaffold and draft to those providers. The Jev prompt is editable in prompts/detemplatize-jev.txt.';
