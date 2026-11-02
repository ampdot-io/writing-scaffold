import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { serveHttp } from '../src/http.js';
import { createServer } from '../src/server.js';
import { Corpus } from '../src/corpus.js';

const corpus = new Corpus(Buffer.from(JSON.stringify({id:1,type:'post',title:'fixture',url:'https://example.test',text:'A cat sat.',copy_blocks:[],nsfw:false})+'\n'));
test('HTML app is self-contained and its browser adapter validates input, errors and origin', async()=>{
  const calls: Array<[string,string]>=[];
  const handle=await serveHttp(()=>createServer(corpus),{host:'127.0.0.1',port:0,rewrite:async(scaffold,text)=>{
    calls.push([scaffold,text]);if(text==='failure')throw new Error('Provider unavailable');return text.replace('sat','rested');
  }});
  try{
    const address=handle.server.address();assert.ok(address&&typeof address!=='string');
    const base=`http://127.0.0.1:${address.port}`;
    const html=await (await fetch(base+'/app')).text();
    assert.equal(html,await readFile(new URL('../dist/detemplatize.html',import.meta.url),'utf8'));
    assert.ok(!html.includes('__SOURCES__'));
    assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+href=/i);
    const send=(body:unknown,headers:Record<string,string>={})=>fetch(base+'/api/detemplatize',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    const result=await send({scaffold:'A cat sat.',text:'A dog sat.'});
    assert.equal(result.status,200);assert.deepEqual(await result.json(),{text:'A dog rested.'});
    assert.deepEqual(calls,[['A cat sat.','A dog sat.']]);
    assert.equal((await send({scaffold:0,text:'x'})).status,400);
    assert.equal((await send({scaffold:'x',text:''})).status,400);
    assert.equal((await send({scaffold:'x',text:'failure'})).status,502);
    assert.equal((await send({scaffold:'x',text:'x'.repeat(1024*1024)})).status,413);
    assert.equal((await send({scaffold:'x',text:'x'},{Origin:'https://evil.example'})).status,403);
    assert.equal((await send({scaffold:'x',text:'x'},{Origin:'null'})).status,403);
  }finally{await handle.close();}
});
