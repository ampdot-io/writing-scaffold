import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderPost, ProviderHttpError, retryAfterMs } from '../src/provider-http.js';

const url='https://provider.example/v1/completions';
const reply=(status:number,body:unknown,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers});
test('Retry-After supports seconds and HTTP dates without a 30-second cap',()=>{
  const now=Date.parse('2026-10-31T20:00:00Z');
  assert.equal(retryAfterMs('120',now),120000);
  assert.equal(retryAfterMs('Sat, 31 Oct 2026 20:02:00 GMT',now),120000);
  assert.equal(retryAfterMs('garbage',now),undefined);
});
test('rate limits can recover beyond the old four attempts and honor the full server delay',async()=>{
  let now=0,calls=0;const waits:number[]=[];
  const post=createProviderPost({now:()=>now,random:()=>0,sleep:async ms=>{waits.push(ms);now+=ms;},
    fetch:async()=>++calls<6 ? reply(429,{error:{code:'rate_limited'}},{'retry-after':'120'}) : reply(200,{ok:true})});
  assert.deepEqual(await post(url,'key',{}),{ok:true});
  assert.equal(calls,6);assert.deepEqual(waits,[120000,120000,120000,120000,120000]);
});
test('parallel calls share a bounded provider queue',async()=>{
  let active=0,peak=0;
  const post=createProviderPost({fetch:async()=>{
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,3));active--;return reply(200,{});
  }});
  await Promise.all(Array.from({length:25},()=>post(url,'same-key',{})));
  assert.equal(peak,2);
});
test('a 429 delays queued work as well as the rejected request',async()=>{
  let now=0,calls=0;let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const times:number[]=[];
  const post=createProviderPost({now:()=>now,random:()=>0,sleep:async ms=>{await blocked;now+=ms;},fetch:async()=>{
    times.push(now);calls++;
    return calls===1 ? reply(429,{error:{code:'queue_full'}},{'retry-after':'60'}) : reply(200,{});
  }});
  const first=post(url,'key',{});
  await new Promise(resolve=>setImmediate(resolve));
  const second=post(url,'key',{});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);release();await Promise.all([first,second]);
  assert.ok(times.slice(1).every(time=>time>=60000));
});
test('billing/quota and explicit no-retry responses fail accurately without pointless retries or private body text',async()=>{
  for(const [code,headers] of [['budget_exceeded',{}],['rate_limited',{'x-should-retry':'false'}]] as const){
    let calls=0;
    const post=createProviderPost({fetch:async()=>{calls++;return reply(429,{error:{code,message:'private contents'}},headers);}});
    await assert.rejects(post(url,'secret',{}),error=>error instanceof ProviderHttpError && error.code===code && !error.message.includes('private'));
    assert.equal(calls,1);
  }
});
test('cancellation interrupts rate-limit backoff promptly',async()=>{
  const controller=new AbortController();
  const post=createProviderPost({fetch:async()=>reply(429,{}, {'retry-after':'120'}),onRetry:()=>controller.abort()});
  await assert.rejects(post(url,'key',{},controller.signal),/cancelled by the caller/);
});
test('cancelling a queued call never sends it and does not strand later work',async()=>{
  let release!:()=>void,calls=0;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const post=createProviderPost({fetch:async()=>{calls++;await barrier;return reply(200,{});}});
  const first=post(url,'key',{}),second=post(url,'key',{});
  const controller=new AbortController(),queued=post(url,'key',{},controller.signal);
  controller.abort();await assert.rejects(queued,/cancelled by the caller/);
  release();await Promise.all([first,second]);await post(url,'key',{});assert.equal(calls,3);
});
test('context-limit codes survive for adaptive Jev splitting',async()=>{
  const post=createProviderPost({fetch:async()=>reply(400,{detail:{error_type:'max_tokens_exceeded'}})});
  await assert.rejects(post(url,'key',{}),error=>error instanceof ProviderHttpError && error.code==='max_tokens_exceeded');
});
