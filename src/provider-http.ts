import { createHash } from 'node:crypto';
import { Agent, fetch as providerFetch } from 'undici';

export const PROVIDER_TIMEOUT_MS = 15 * 60_000;
const agent = new Agent({ connections: 2, connect: { timeout: 60_000 },
  headersTimeout: PROVIDER_TIMEOUT_MS, bodyTimeout: PROVIDER_TIMEOUT_MS });
interface Reply {
  status: number; ok: boolean; headers: { get(name: string): string | null };
  body: { cancel(): Promise<unknown> } | null;
  json(): Promise<unknown>;
}
interface Options {
  fetch?: (url: string, init: { method: string; headers: Record<string,string>; body: string; signal: AbortSignal }) => Promise<Reply>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  onRetry?: (message: string) => void;
  timeoutMs?: number;
}
export class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, host: string, suffix = '') {
    super(`${host}: HTTP ${status}${code ? ` (${code})` : ''}${suffix}`);
  }
}
export function providerFailure(url: string, started: number, deadline: AbortSignal, caller: AbortSignal | undefined, error: unknown): Error {
  const prefix=`${new URL(url).hostname} after ${((Date.now()-started)/1000).toFixed(1)}s`;
  if (caller?.aborted) return new Error(`${prefix}: cancelled by the caller before the provider deadline`);
  if (deadline.aborted) return new Error(`${prefix}: the 15-minute provider deadline expired`);
  let cause=error;
  for (let depth=0;depth<4 && cause && typeof cause==='object';depth++) {
    const item=cause as {code?:unknown;cause?:unknown};
    if (typeof item.code==='string' && /^[A-Z0-9_]{1,80}$/.test(item.code)) return new Error(`${prefix}: network transport failure (${item.code})`);
    cause=item.cause;
  }
  return new Error(`${prefix}: network transport failure before the provider deadline`);
}
export function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds=Number(value);
  if (Number.isFinite(seconds) && seconds>=0) return seconds*1000;
  const date=Date.parse(value);
  return Number.isFinite(date) ? Math.max(0,date-now) : undefined;
}
function errorCode(body: unknown): string | undefined {
  if (!body || typeof body!=='object') return undefined;
  const row=body as Record<string,unknown>;
  const nested=(value:unknown):Record<string,unknown>=>value && typeof value==='object' ? value as Record<string,unknown> : {};
  const error=nested(row.error),detail=nested(row.detail);
  const value=error.code ?? row.code ?? detail.error_type ?? error.type;
  return typeof value==='string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : undefined;
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const onAbort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},ms);
    signal.addEventListener('abort',onAbort,{once:true});
  });
}

/** Shared across calls and dependency instances; a provider's 429 pauses its whole queue. */
export function createProviderPost(options: Options = {}) {
  const send=options.fetch ?? ((url,init)=>providerFetch(url,{...init,dispatcher:agent}));
  const now=options.now ?? Date.now, sleep=options.sleep ?? pause, random=options.random ?? Math.random;
  const lanes=new Map<string,{active:number;cooldown:number;waiters:Set<()=>void>}>();
  return async function post(url:string,key:string,payload:unknown,signal?:AbortSignal):Promise<unknown> {
    const started=now(),timeout=AbortSignal.timeout(options.timeoutMs ?? PROVIDER_TIMEOUT_MS);
    const abort=signal ? AbortSignal.any([signal,timeout]) : timeout;
    const host=new URL(url).hostname;
    const laneKey=new URL(url).origin+':'+createHash('sha256').update(key).digest('hex');
    let lane=lanes.get(laneKey);
    if(!lane){lane={active:0,cooldown:0,waiters:new Set()};lanes.set(laneKey,lane);}
    const queue=lane;
    let acquired=false;
    try {
      while(queue.active>=2){
        await new Promise<void>((resolve,reject)=>{
          abort.throwIfAborted();
          const wake=()=>{abort.removeEventListener('abort',cancel);queue.waiters.delete(wake);resolve();};
          const cancel=()=>{queue.waiters.delete(wake);reject(abort.reason);};
          queue.waiters.add(wake);abort.addEventListener('abort',cancel,{once:true});
        });
      }
      abort.throwIfAborted();queue.active++;acquired=true;
      for(let attempt=0;attempt<12;attempt++){
        while(queue.cooldown>now()) await sleep(Math.min(queue.cooldown-now(),PROVIDER_TIMEOUT_MS),abort);
        abort.throwIfAborted();
        const response=await send(url,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(payload),signal:abort});
        if(response.ok){
          try{return await response.json();}
          catch(error){if(error instanceof SyntaxError && !abort.aborted)throw new Error(`${host}: invalid JSON response`);throw error;}
        }
        let body:unknown;
        try{body=await response.json();}catch{await response.body?.cancel().catch(()=>{});}
        const code=errorCode(body);
        const retryable=[429,529].includes(response.status) && response.headers.get('x-should-retry')!=='false' &&
          !['budget_exceeded','activation_quota_exceeded','spend_cap','insufficient_quota','billing_hard_limit_reached'].includes(code ?? '');
        if(!retryable || attempt===11)throw new ProviderHttpError(response.status,code,host,
          retryable ? '; rate limit persisted after 12 attempts' : '');
        const delay=Math.max(retryAfterMs(response.headers.get('retry-after'),now()) ?? 0,
          Math.min(60_000,1000*2**attempt)) + Math.floor(random()*500);
        queue.cooldown=Math.max(queue.cooldown,now()+delay);
        options.onRetry?.(`${host}: HTTP ${response.status}${code ? ` (${code})` : ''}; retrying after ${Math.ceil(delay/1000)}s`);
      }
      throw new Error(`${host}: retries exhausted`);
    }catch(error){
      if(abort.aborted)throw providerFailure(url,started,timeout,signal,error);
      if(error instanceof ProviderHttpError || error instanceof Error && error.message===`${host}: invalid JSON response`)throw error;
      throw providerFailure(url,started,timeout,signal,error);
    }finally{
      if(acquired){queue.active--;for(const wake of queue.waiters)wake();}
    }
  };
}
export const postProvider = createProviderPost({onRetry:message=>console.error(`writing-scaffold: ${message}`)});
