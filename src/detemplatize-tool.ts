import { INVALID_PARAMS, ProtocolError } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { isUuid } from './scaffold-store.js';
import type { ScaffoldStore } from './scaffold-store.js';
import { createDetemplatizeDependencies, detemplatize } from './detemplatize.js';
import type { DetemplatizeDependencies } from './detemplatize.js';

/** Numeric scaffold_id is the stable sequential alias shown by list_scaffolds. */
export async function callDetemplatizeTool(args: unknown, store: ScaffoldStore,
  dependencies?: DetemplatizeDependencies, signal?: AbortSignal): Promise<CallToolResult> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ProtocolError(INVALID_PARAMS,'detemplatize requires scaffold_id and text');
  const values=args as Record<string,unknown>;
  const unexpected=Object.keys(values).filter(key=>key !== 'scaffold_id' && key !== 'text');
  if (unexpected.length) throw new ProtocolError(INVALID_PARAMS,`Unexpected detemplatize argument(s): ${unexpected.join(', ')}. Use scaffold_id and text.`);
  if (typeof values.text !== 'string') throw new ProtocolError(INVALID_PARAMS,`detemplatize.text must be a string; received ${values.text === null ? 'null' : typeof values.text}`);
  const id=typeof values.scaffold_id === 'string' && /^[1-9][0-9]*$/.test(values.scaffold_id) ? Number(values.scaffold_id) : values.scaffold_id;
  if (!isUuid(id) && !(typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
    throw new ProtocolError(INVALID_PARAMS,'detemplatize.scaffold_id must be a positive safe integer, a decimal ID string such as "12004", or a canonical UUID');
  }
  const scaffold=typeof id === 'number' ? store.getScaffoldBySequentialId(id) : store.getScaffold(id as string);
  try {
    const result=await detemplatize(scaffold,values.text,dependencies ?? await createDetemplatizeDependencies(),signal);
    return {content:[{type:'text',text:result.text}]};
  } catch (error) {
    return {isError:true,content:[{type:'text',text:`Detemplatize failed: ${error instanceof Error ? error.message : 'unknown provider error'}`}]};
  }
}
