import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { diffArrays } from 'diff';
import tokenizer from 'llama3-tokenizer-js';
import { postProvider, ProviderHttpError } from './provider-http.js';
export { providerFailure } from './provider-http.js';

import { ENV_PATH, IS_STANDALONE_BUNDLE, loadJevPrompt } from './runtime-assets.js';
export { JEV_PROMPT_PATH } from './runtime-assets.js';
const ACS_URL = 'https://infra.acsresearch.org/v1/completions';
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const BASE_MODEL = 'meta-llama/Llama-3.1-8B';
export interface Candidate { id: number; token: string; logprob: number; rank: number; valid_utf8?: boolean }
export interface ScoredToken extends Candidate { candidates: Candidate[] }
export interface TokenizedText { model: string; tokens: ScoredToken[] }
export interface AlignmentSlot { scaffold: number | null; text: number | null; same: boolean }
export interface Decision { text_index: number; scaffold_index: number; original: string; replacement: string; token_id: number; model: string; proposed_token_id?:number; proposed_replacement?:string }
export interface DetemplatizeResult { text: string; matched_tokens: number; changed_tokens: number; rejected_tokens?:number; decisions: Decision[]; acs_model: string; jev_models: string[] }
export interface JevRequest {
  model: string;
  state: {
    scaffold_exemplar: string; before_text: string; current_token: string; after_text: string;
    alternate_tokens: string[];
  };
  questions: { token: { type: 'choice'; instructions: string; criteria: Record<string, string> } };
}
export interface DetemplatizeDependencies {
  codec?: { tokenBytes(id:number):Buffer; decodeTokens(ids:number[]):string };
  score(text: string, count: 0 | 100, signal?: AbortSignal): Promise<TokenizedText>;
  choose(request: JevRequest, signal?: AbortSignal): Promise<{ choice: string; model: string }>;
  prompt(): Promise<string>;
  validate?(text:TokenizedText,changes:Decision[],signal?:AbortSignal):Promise<Set<number>>;
}

export interface JevBatch {
  request: {
    model: string; state: { scaffold_exemplar: string };
    questions: Record<string,{type:'choice';instructions:{prompt:string;before_text:string;current_token:string;after_text:string;alternate_tokens:JevRequest['state']['alternate_tokens']};criteria:Record<string,string>}>;
  };
  indices: number[];
}
export class JevContextLimitError extends Error {}

export async function evaluateJevBatch(batch: JevBatch, send: (request:JevBatch['request'])=>Promise<unknown>): Promise<{index:number;answer:{choice:string;model:string}}[]> {
  let raw: unknown;
  try { raw=await send(batch.request); }
  catch (error) {
    if (!(error instanceof JevContextLimitError) || batch.indices.length<2) throw error;
    const middle=Math.ceil(batch.indices.length/2);
    const halves=[batch.indices.slice(0,middle),batch.indices.slice(middle)].map(indices=>({
      request:{...batch.request,questions:Object.fromEntries(indices.map(index=>[`token_${index}`,batch.request.questions[`token_${index}`]!]))},indices,
    }));
    return (await Promise.all(halves.map(half=>evaluateJevBatch(half,send)))).flat();
  }
  const result=record(raw);
  if (typeof result.model!=='string' || !result.model) throw new Error('Invalid Jev model response');
  const answers=record(result.answers);
  return batch.indices.map(index=>{
    const answer=record(answers[`token_${index}`]);
    if (answer.type!=='choice' || typeof answer.choice!=='string' || !Object.hasOwn(batch.request.questions[`token_${index}`]!.criteria,answer.choice)) throw new Error('Invalid or missing Jev batch choice');
    return {index,answer:{choice:answer.choice,model:result.model as string}};
  });
}

/** Questions are independently evaluated against the shared scaffold. */
export function batchJevRequests(requests: JevRequest[], maxBytes=28*1024*1024): JevBatch[] {
  const batches: JevBatch[]=[];
  let batch: JevBatch | undefined;
  let size=0;
  requests.forEach((request,index)=>{
    const {scaffold_exemplar,before_text,current_token,after_text,alternate_tokens}=request.state;
    const question={type:'choice' as const,instructions:{prompt:request.questions.token.instructions,before_text,current_token,after_text,alternate_tokens},criteria:request.questions.token.criteria};
    const key=`token_${index}`;
    const bytes=Buffer.byteLength(JSON.stringify({[key]:question}))+1;
    if (!batch || batch.request.model!==request.model || batch.request.state.scaffold_exemplar!==scaffold_exemplar || size+bytes>maxBytes) {
      batch={request:{model:request.model,state:{scaffold_exemplar},questions:{}},indices:[]};
      size=Buffer.byteLength(JSON.stringify(batch.request));
      if (size+bytes>maxBytes) throw new Error('A Jev token question exceeds the request body limit; no text was truncated');
      batches.push(batch);
    }
    batch.request.questions[key]=question;
    batch.indices.push(index);
    size+=bytes;
  });
  return batches;
}

// Llama's byte-level vocabulary is needed because a token may contain only part of
// a UTF-8 character. Concatenating individually decoded API tokens can corrupt it.
const byteAlphabet = [...Array.from({length:94},(_,i)=>i+33), ...Array.from({length:12},(_,i)=>i+161), ...Array.from({length:82},(_,i)=>i+174)];
const byteMap = new Map<string, number>();
for (const value of byteAlphabet) byteMap.set(String.fromCodePoint(value), value);
let extension = 256;
for (let value=0;value<256;value++) if (!byteAlphabet.includes(value)) byteMap.set(String.fromCodePoint(extension++), value);
export function tokenBytes(id: number): Buffer {
  const raw = tokenizer.vocabById[id];
  if (raw === undefined) throw new Error('ACS returned an unknown Llama token ID');
  if (id >= 128000) return Buffer.from(raw, 'utf8');
  return Buffer.from([...raw].map(char => {
    const byte = byteMap.get(char);
    if (byte === undefined) throw new Error('Invalid Llama byte vocabulary');
    return byte;
  }));
}
export function decodeTokens(ids: number[]): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(ids.map(tokenBytes)));
}
const displayToken = (id: number): string => new TextDecoder().decode(tokenBytes(id));
export function validReplacement(bytes: Buffer, start: number, end: number, replacement: Buffer): boolean {
  // Include only the neighboring pieces of any split Unicode characters.
  let left=start, right=end;
  while (left>0 && left<bytes.length && (bytes[left]! & 0xc0) === 0x80) left--;
  while (right<bytes.length && (bytes[right]! & 0xc0) === 0x80) right++;
  try {
    new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat([bytes.subarray(left,start),replacement,bytes.subarray(end,right)]));
    return true;
  } catch { return false; }
}
export function sameWhitespaceEdges(original: string, replacement: string): boolean {
  return original.match(/^\s*/u)![0]===replacement.match(/^\s*/u)![0] &&
    original.match(/\s*$/u)![0]===replacement.match(/\s*$/u)![0];
}
const STRUCTURAL_WORDS=new Set(('a an the this that these those i we you he she it they me us him her them my our your his its their '+
  'is am are was were be been being do does did have has had can cannot could may might must shall should will would ought '+
  'no not never neither nor and or but if unless because although though while therefore however '+
  'all any every none only almost entirely '+
  'of to in for on with at by from into onto upon about over under before after through between among without within against during until since despite except per via as than').split(' '));
/** Only replace whole lexical tokens; punctuation is not a word-choice slot. */
export function isLexicalReplacement(original: string, replacement: string): boolean {
  const word = /^\s*\p{L}[\p{L}\p{M}]*(?:[-’']\p{L}[\p{L}\p{M}]*)*\s*$/u;
  return word.test(original) && word.test(replacement);
}

/** Byte ranges keep quotes and literal numbers immutable, including split tokens. */
export function protectedTextRanges(text: string): [number, number][] {
  return [...text.matchAll(/"[^"\r\n]*"|“[^”]*”|‘[^’]*’|\p{N}+/gu)].map(match => {
    const start = Buffer.byteLength(text.slice(0, match.index));
    return [start, start + Buffer.byteLength(match[0])];
  });
}

export function isProtectedFragment(bytes: Buffer, start: number, end: number): boolean {
  let token: string, before: string, after: string;
  try {
    const decoder=new TextDecoder('utf8',{fatal:true,ignoreBOM:true});
    token=decoder.decode(bytes.subarray(start,end));
    let left=Math.max(0,start-24),right=Math.min(bytes.length,end+24);
    while (left<start && (bytes[left]! & 0xc0)===0x80) left++;
    while (right<bytes.length && (bytes[right]! & 0xc0)===0x80) right++;
    before=decoder.decode(bytes.subarray(left,start));after=decoder.decode(bytes.subarray(end,right));
  } catch { return true; }
  const word=/[\p{L}\p{M}\p{N}_]/u;
  if (STRUCTURAL_WORDS.has(token.trim().toLowerCase())) return true;
  const first=[...token][0] ?? '', last=[...token].at(-1) ?? '';
  const previous=[...before].at(-1) ?? '', next=[...after][0] ?? '';
  if (word.test(previous) && (word.test(first) || /['’]/u.test(first))) return true;
  if (word.test(last) && (word.test(next) || /['’]/u.test(next))) return true;
  for (const match of (before+token+after).matchAll(/(?:[a-z]\.){2,}/giu)) {
    if (match.index<before.length+token.length && match.index+match[0].length>before.length) return true;
  }
  return /["'“”‘’]/u.test(token) && !word.test(token);
}
export function suffixCompatible(baseline:number[],alternative:number[]):boolean {
  if (baseline.length!==alternative.length || !baseline.every(Number.isFinite) || !alternative.every(Number.isFinite)) throw new Error('Invalid suffix score alignment');
  const drops=baseline.map((score,i)=>score-alternative[i]!);
  return Math.max(0,...drops)<=3 && drops.slice(0,4).reduce((sum,drop)=>sum+drop,0)/Math.max(1,Math.min(4,drops.length))<=1;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider response object');
  return value as Record<string, unknown>;
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function parseAcsResponse(raw: unknown, text: string, count: 0 | 100): TokenizedText {
  const response = record(raw);
  if (response.model !== BASE_MODEL) throw new Error('ACS llama-8b is not the expected Llama 3.1 8B base model');
  if (!Array.isArray(response.choices) || response.choices.length !== 1) throw new Error('ACS must return one completion');
  const choice = record(response.choices[0]);
  const positions = choice.prompt_logprobs;
  const echoed = record(choice.logprobs);
  // This local encoding only disambiguates the actual token from the top-k map;
  // every ID and logprob is verified against ACS's authoritative prompt response.
  const expected = tokenizer.encode(text, { bos: false, eos: false });
  if (!Array.isArray(positions) || positions.length !== expected.length+1 || positions[0] !== null ||
      !Array.isArray(echoed.tokens) || !Array.isArray(echoed.token_logprobs) || echoed.tokens[0] !== '<|begin_of_text|>') {
    throw new Error('ACS prompt tokenization does not match Llama 3.1 boundaries');
  }
  const scores = echoed.token_logprobs;
  const tokens = expected.map((id, index): ScoredToken => {
    const values = record(positions[index+1]);
    const candidates = Object.entries(values).map(([key, value]): Candidate => {
      const item = record(value), tokenId = Number(key);
      if (!Number.isSafeInteger(tokenId) || tokenId < 0 || !finite(item.logprob) || item.logprob > 0 ||
          !Number.isSafeInteger(item.rank) || (item.rank as number) < 1 || typeof item.decoded_token !== 'string') {
        throw new Error('Invalid ACS token candidate');
      }
      return { id: tokenId, token: displayToken(tokenId), logprob: item.logprob, rank: item.rank as number };
    });
    const actual = candidates.find(candidate => candidate.id === id);
    if (!actual || actual.logprob !== scores[index+1]) throw new Error('ACS actual token ID or echoed score is inconsistent');
    const top = candidates.filter(candidate => candidate.rank <= count)
      .sort((a,b)=>b.logprob-a.logprob || a.rank-b.rank || a.id-b.id).slice(0,count);
    if (count > 0 && top.length !== count) {
      throw new Error(`ACS did not return ${count} ranked candidates for every text token`);
    }
    return { ...actual, candidates: top };
  });
  if (decodeTokens(tokens.map(token=>token.id)) !== text) throw new Error('ACS token bytes do not reproduce the input exactly');
  return { model: response.model, tokens };
}

export function alignTokens(scaffold: ScoredToken[], text: ScoredToken[]): AlignmentSlot[] {
  const edits = diffArrays(scaffold.map(token=>token.id), text.map(token=>token.id), { timeout: 5000 });
  if (!edits) throw new Error('Token alignment exceeded five seconds; no text was changed');
  const slots: AlignmentSlot[] = [];
  let before=0, after=0;
  for (const edit of edits) for (let i=0;i<edit.value.length;i++) {
    if (edit.removed) slots.push({scaffold:before++,text:null,same:false});
    else if (edit.added) slots.push({scaffold:null,text:after++,same:false});
    else slots.push({scaffold:before++,text:after++,same:true});
  }
  return slots;
}

export async function detemplatize(scaffold: string, text: string, dependencies: DetemplatizeDependencies, signal?: AbortSignal): Promise<DetemplatizeResult> {
  const bytesFor=dependencies.codec?.tokenBytes ?? tokenBytes;
  const decode=dependencies.codec?.decodeTokens ?? decodeTokens;
  // Snapshot the editable prompt once: edits during a call apply to the next call.
  const prompt = await dependencies.prompt();
  if (!prompt.trim()) throw new Error('The Jev prompt is empty');
  const [before, after] = await Promise.all([dependencies.score(scaffold,0,signal), dependencies.score(text,100,signal)]);
  const slots = alignTokens(before.tokens, after.tokens);
  const tasks = slots.filter(slot=>slot.same);
  const originalBytes=Buffer.from(text,'utf8');
  const protectedRanges=protectedTextRanges(text);
  const offsets=[0];
  for (const token of after.tokens) offsets.push(offsets[offsets.length-1]! + bytesFor(token.id).length);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  let decisions: Decision[];
  try {
    // Every request sees the same immutable full texts. No selected token becomes
    // the context for another choice: this is parallel substitution, not decoding.
    decisions = await Promise.all(tasks.map(async (slot): Promise<Decision> => {
      const current = after.tokens[slot.text!]!;
      const protectedFragment=isProtectedFragment(originalBytes,offsets[slot.text!]!,offsets[slot.text!+1]!) ||
        protectedRanges.some(([start,end])=>start<offsets[slot.text!+1]! && end>offsets[slot.text!]!);
      const options=[...new Map([...current.candidates,current].map(candidate=>[candidate.id,candidate])).values()]
        .sort((a,b)=>b.logprob-a.logprob || a.rank-b.rank || a.id-b.id)
        .map(candidate=>({...candidate,valid_utf8:validReplacement(originalBytes,offsets[slot.text!]!,offsets[slot.text!+1]!,bytesFor(candidate.id))}));
      const criteria: Record<string,string> = Object.fromEntries(options.flatMap((candidate,i)=>candidate.valid_utf8 && sameWhitespaceEdges(current.token,candidate.token) &&
        (candidate.id===current.id || (!protectedFragment && isLexicalReplacement(current.token,candidate.token))) ? [[
        `candidate_${i}`, candidate.token,
      ]] : []));
      // Context fields remain valid complete Unicode strings even when a model
      // token is only a fragment of one character. The precise token bytes and
      // IDs and bytes stay internal; Jev receives only token text.
      let start=offsets[slot.text!]!, end=offsets[slot.text!+1]!;
      while (start>0 && start<originalBytes.length && (originalBytes[start]! & 0xc0) === 0x80) start--;
      while (end<originalBytes.length && (originalBytes[end]! & 0xc0) === 0x80) end++;
      const answer = await dependencies.choose({
        model:'jev-latest',
        state:{scaffold_exemplar:scaffold,before_text:originalBytes.subarray(0,start).toString('utf8'),
          current_token:originalBytes.subarray(start,end).toString('utf8'),after_text:originalBytes.subarray(end).toString('utf8'),
          alternate_tokens:options.map(candidate=>candidate.token)},
        questions:{token:{type:'choice',instructions:prompt,criteria}},
      },combined);
      if (!Object.hasOwn(criteria,answer.choice)) throw new Error('Jev returned a token outside the offered choices');
      const selected = options[Number(answer.choice.slice('candidate_'.length))]!;
      return {text_index:slot.text!,scaffold_index:slot.scaffold!,original:current.token,replacement:selected.token,token_id:selected.id,model:answer.model};
    }));
  } catch (error) { controller.abort(); throw error; }
  const proposed=decisions.filter(decision=>decision.token_id!==after.tokens[decision.text_index]!.id);
  let rejected=0;
  if (dependencies.validate && proposed.length) {
    let accepted:Set<number>;
    try { accepted=await dependencies.validate(after,proposed,combined); }
    catch(error) { controller.abort();throw error; }
    decisions=decisions.map(decision=>{
      const original=after.tokens[decision.text_index]!;
      if(decision.token_id===original.id || accepted.has(decision.text_index)) return decision;
      rejected++;
      return {...decision,proposed_token_id:decision.token_id,proposed_replacement:decision.replacement,token_id:original.id,replacement:original.token};
    });
  }
  const outputIds = after.tokens.map(token=>token.id);
  for (const decision of decisions) outputIds[decision.text_index] = decision.token_id;
  let rewritten: string;
  try { rewritten=decode(outputIds); } catch { throw new Error('Parallel Jev choices produced invalid UTF-8; no partial rewrite was returned'); }
  return { text:rewritten, matched_tokens:decisions.length,
    changed_tokens:decisions.filter(decision=>decision.token_id !== after.tokens[decision.text_index]!.id).length,
    rejected_tokens:rejected,decisions,acs_model:after.model,jev_models:[...new Set(decisions.map(decision=>decision.model).filter(model=>model!=='identity'))] };
}

async function post(url: string, key: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
  try { return await postProvider(url,key,payload,signal); }
  catch(error) {
    if(url===JEV_URL && error instanceof ProviderHttpError && error.status===400 && error.code==='max_tokens_exceeded') {
      throw new JevContextLimitError('Jev context limit exceeded; a single scaffold/token question may be too long');
    }
    throw error;
  }
}

export async function createDetemplatizeDependencies(options: {mapBatch?:(request:JevBatch['request'])=>JevBatch['request']} = {}): Promise<DetemplatizeDependencies> {
  let file: NodeJS.Dict<string> = {};
  try { if (!IS_STANDALONE_BUNDLE) file=parseEnv(await readFile(ENV_PATH,'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read the workspace .env file'); }
  const acs=process.env.ACS_API_KEY || file.ACS_API_KEY;
  const jev=process.env.TYPESAFE_API_KEY || file.TYPESAFE_API_KEY;
  if (!acs || !jev) throw new Error('Set ACS_API_KEY and TYPESAFE_API_KEY in ~/multiem/.env or the server environment');
  type Answer={choice:string;model:string};
  type Pending={request:JevRequest;signal:AbortSignal|undefined;resolve:(answer:Answer)=>void;reject:(error:unknown)=>void};
  let pending: Pending[]=[];
  const flush=async (items:Pending[]):Promise<void>=>{
    try {
      await Promise.all(batchJevRequests(items.map(item=>item.request)).map(async batch=>{
        try {
          const resolved=await evaluateJevBatch(batch,request=>post(JEV_URL,jev,options.mapBatch?.(request) ?? request,items[batch.indices[0]!]!.signal));
          for (const item of resolved) items[item.index]!.resolve(item.answer);
        } catch (error) { for (const index of batch.indices) items[index]!.reject(error); }
      }));
    } catch (error) { for (const item of items) item.reject(error); }
  };
  return {
    prompt:loadJevPrompt,
    async score(text,count,signal) {
      const raw=await post(ACS_URL,acs,{model:'llama-8b',prompt:text,max_tokens:1,temperature:0,echo:true,logprobs:count,prompt_logprobs:count},signal);
      return parseAcsResponse(raw,text,count);
    },
    async validate(text,changes,signal) {
      const aliases:Record<string,{model:string;bos:number}>={
        'meta-llama/Llama-3.1-8B':{model:'llama-8b',bos:128000},
        'meta-llama/Llama-3.1-405B':{model:'llama-405b',bos:128000},
        'arcee-ai/Trinity-Large-TrueBase':{model:'trinity-truebase',bos:0},
      };
      const model=aliases[text.model];
      if(!model)throw new Error('Cannot validate suffixes for an unknown candidate model');
      const accepted=new Set<number>();
      const groups:Decision[][]=[];
      for(let i=0;i<changes.length;i+=16)groups.push(changes.slice(i,i+16));
      await Promise.all(groups.map(async group=>{
        const prompts=group.map(change=>[model.bos,...text.tokens.slice(0,change.text_index).map(token=>token.id),change.token_id,
          ...text.tokens.slice(change.text_index+1,change.text_index+25).map(token=>token.id)]);
        const raw=record(await post(ACS_URL,acs,{model:model.model,prompt:prompts,max_tokens:1,temperature:0,logprobs:0,prompt_logprobs:0},signal));
        if(raw.model!==text.model || !Array.isArray(raw.choices) || raw.choices.length!==group.length)throw new Error('Invalid suffix validation response');
        const seen=new Set<number>();
        for(const value of raw.choices){
          const choice=record(value),index=choice.index;
          if(typeof index!=='number' || !Number.isInteger(index) || index<0 || index>=group.length || seen.has(index))throw new Error('Invalid suffix choice index');
          seen.add(index);
          const change=group[index]!,n=Math.min(24,text.tokens.length-change.text_index-1),positions=choice.prompt_logprobs;
          if(!Array.isArray(positions) || positions.length!==prompts[index]!.length)throw new Error('Suffix token boundaries changed');
          const baseline:number[]=[],alternative:number[]=[];
          for(let i=0;i<n;i++){
            const token=text.tokens[change.text_index+1+i]!;
            const score=record(record(positions[change.text_index+2+i])[String(token.id)]).logprob;
            if(!finite(score))throw new Error('Invalid suffix logprob');
            baseline.push(token.logprob);alternative.push(score);
          }
          if(suffixCompatible(baseline,alternative))accepted.add(change.text_index);
        }
      }));
      return accepted;
    },
    choose(request,signal) {
      const choices=Object.keys(request.questions.token.criteria);
      if (!choices.length) return Promise.reject(new Error('No valid token choices'));
      // Protected tokens have one legal answer; avoid paying to ask a model.
      if (choices.length===1) return Promise.resolve({choice:choices[0]!,model:'identity'});
      return new Promise<Answer>((resolve,reject)=>{
        pending.push({request,signal,resolve,reject});
        if (pending.length===1) queueMicrotask(()=>{
          const items=pending;pending=[];
          void flush(items);
        });
      });
    },
  };
}
