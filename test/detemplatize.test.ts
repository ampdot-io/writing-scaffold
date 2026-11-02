import assert from 'node:assert/strict';
import { test } from 'node:test';
import tokenizer from 'llama3-tokenizer-js';
import { ProtocolError } from '@modelcontextprotocol/server';
import { Corpus } from '../src/corpus.js';
import { alignTokens, createDetemplatizeDependencies, batchJevRequests, decodeTokens, detemplatize, evaluateJevBatch, isProtectedFragment, isLexicalReplacement, protectedTextRanges, JevContextLimitError, parseAcsResponse, providerFailure, sameWhitespaceEdges, suffixCompatible, tokenBytes, validReplacement } from '../src/detemplatize.js';
import type { Candidate, DetemplatizeDependencies, JevRequest, ScoredToken } from '../src/detemplatize.js';
import { callDetemplatizeTool } from '../src/detemplatize-tool.js';

const ids=(text:string)=>tokenizer.encode(text,{bos:false,eos:false});
const token=(id:number):Candidate=>({id,token:new TextDecoder().decode(tokenBytes(id)),logprob:-1,rank:1});
const scored=(text:string):ScoredToken[]=>ids(text).map(id=>({...token(id),candidates:[...new Set([id,...ids(' slept and on at more')])].slice(0,5).map((id,i)=>({...token(id),rank:i+1,logprob:-i-1}))}));
const makeDependencies=(choose:DetemplatizeDependencies['choose']):DetemplatizeDependencies=>({
  prompt:async()=> 'Editable test instructions',
  score:async(text)=>({model:'meta-llama/Llama-3.1-8B',tokens:scored(text)}),
  choose,
});
const corpus=new Corpus(Buffer.from(JSON.stringify({id:700,type:'post',title:'Example',url:'https://example.test',text:'The cat sat on the mat.',copy_blocks:[],nsfw:false})));

test('provider errors distinguish client cancellation, provider deadlines and transport timeouts',()=>{
  const active=new AbortController().signal;
  const url='https://api.typesafe.ai/v1/systemone',started=Date.now()-60000;
  assert.match(providerFailure(url,started,active,AbortSignal.abort(),Error()).message,/after 60\.\ds: cancelled by the caller/);
  assert.match(providerFailure(url,started,AbortSignal.abort(),active,Error()).message,/15-minute provider deadline expired/);
  assert.match(providerFailure(url,started,active,active,new TypeError('fetch failed',{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}})).message,/network transport failure \(UND_ERR_CONNECT_TIMEOUT\)/);
  assert.doesNotMatch(providerFailure(url,started,active,active,Error('private request data')).message,/private request data/);
});

test('alignment masks insertions and deletions while keeping repeated token matches ordered',()=>{
  const before=scored('a b a c d'),after=scored('a x b a d e');
  const slots=alignTokens(before,after);
  assert.deepEqual(slots.flatMap(s=>s.scaffold===null?[]:[s.scaffold]),before.map((_,i)=>i));
  assert.deepEqual(slots.flatMap(s=>s.text===null?[]:[s.text]),after.map((_,i)=>i));
  assert.ok(slots.some(s=>s.scaffold===null));assert.ok(slots.some(s=>s.text===null));
  for(const s of slots)if(s.same)assert.equal(before[s.scaffold!]!.id,after[s.text!]!.id);
});

test('parallel substitutions see full immutable texts and never feed choices into subsequent requests',{timeout:2000},async()=>{
  const scaffold='The cat sat on the mat.',text='The dog sat on the rug.';
  const count=alignTokens(scored(scaffold),scored(text)).filter(s=>s.same).length;
  const requests:JevRequest[]=[];
  let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
  const counts:number[]=[];
  const deps=makeDependencies(async request=>{
    requests.push(request);
    if(requests.length===count)release();
    await barrier;
    return {choice:request.state.current_token===' sat'?'candidate_1':'candidate_0',model:'test-jev'};
  });
  const score=deps.score;deps.score=(text,count,signal)=>{counts.push(count);return score(text,count,signal);};
  const result=await detemplatize(scaffold,text,deps);
  assert.deepEqual(counts,[0,100]);
  assert.equal(result.text,'The dog slept on the rug.');
  assert.equal(result.changed_tokens,1);assert.equal(requests.length,count);
  for(const request of requests){
    assert.deepEqual(Object.keys(request.state),['scaffold_exemplar','before_text','current_token','after_text','alternate_tokens']);
    assert.equal(request.state.scaffold_exemplar,scaffold);assert.equal(request.state.before_text+request.state.current_token+request.state.after_text,text);
    assert.equal(request.questions.token.instructions,'Editable test instructions');
    assert.equal(request.state.alternate_tokens.length,5);
    for (const candidate of request.state.alternate_tokens) assert.equal(typeof candidate,'string');
    for (const description of Object.values(request.questions.token.criteria)) assert.equal(typeof description,'string');
    assert.equal(request.state.alternate_tokens[0],request.questions.token.criteria.candidate_0);
    assert.ok(!Object.hasOwn(request.questions.token.criteria,'original'));
    for (const [key,value] of Object.entries(request.questions.token.criteria)) {
      assert.match(key,/^candidate_\d+$/);
      assert.equal(value,request.state.alternate_tokens[Number(key.slice('candidate_'.length))]);
    }
  }
  const [batch,...rest]=batchJevRequests(requests);
  assert.equal(rest.length,0);assert.equal(Object.keys(batch!.request.questions).length,count);
  assert.deepEqual(batch!.request.state,{scaffold_exemplar:scaffold});
  requests.forEach((request,i)=>{
    const question=batch!.request.questions[`token_${i}`]!;
    assert.equal(question.instructions.prompt,request.questions.token.instructions);
    assert.equal(question.instructions.before_text+question.instructions.current_token+question.instructions.after_text,text);
    assert.deepEqual(question.instructions.alternate_tokens,request.state.alternate_tokens);
    assert.deepEqual(question.criteria,request.questions.token.criteria);
  });
  const oneSize=Math.max(...requests.map(request=>Buffer.byteLength(JSON.stringify(batchJevRequests([request])[0]!.request))));
  const chunks=batchJevRequests(requests,oneSize+20);
  assert.ok(chunks.length>1);
  assert.ok(chunks.every(chunk=>Buffer.byteLength(JSON.stringify(chunk.request))<=oneSize+20));
  assert.deepEqual(chunks.flatMap(chunk=>chunk.indices),requests.map((_,i)=>i));
  assert.throws(()=>batchJevRequests(requests,20),/body limit/);
  const attempts:number[]=[];
  const answers=await evaluateJevBatch(batch!,async request=>{
    const keys=Object.keys(request.questions);attempts.push(keys.length);
    if(keys.length>2)throw new JevContextLimitError('explicit rejection');
    assert.deepEqual(request.state,{scaffold_exemplar:scaffold});
    return {model:'test',answers:Object.fromEntries(keys.reverse().map(key=>[key,{type:'choice',choice:'candidate_0'}]))};
  });
  assert.equal(attempts[0],count);assert.ok(attempts.filter(size=>size<=2).length>1);
  assert.deepEqual(answers.map(answer=>answer.index),requests.map((_,i)=>i));
  await assert.rejects(evaluateJevBatch(batch!,async()=>{throw Error('network error');}),/network error/);
  await assert.rejects(evaluateJevBatch(batchJevRequests([requests[0]!])[0]!,async()=>{throw new JevContextLimitError('single too large');}),/single too large/);
});

test('UTF-8 byte fragments, combining characters, BOM and whitespace round-trip exactly',async()=>{
  const text='\ufeff  👩🏽‍💻\r\ne\u0301 🦥\t𐍈';
  assert.equal(decodeTokens(ids(text)),text);
  assert.ok(ids(text).some(id=>token(id).token.includes('\ufffd')),'fixture includes split Unicode tokens');
  const result=await detemplatize(text,text,makeDependencies(async request=>{
    assert.equal(request.state.before_text+request.state.current_token+request.state.after_text,text);
    return {choice:'candidate_0',model:'test-jev'};
  }));
  assert.equal(result.text,text);assert.equal(result.changed_tokens,0);
});

test('replacement eligibility checks Unicode fragments against their actual neighboring bytes',()=>{
  const bytes=Buffer.from('a🦥z');
  assert.equal(validReplacement(bytes,1,3,bytes.subarray(1,3)),true);
  assert.equal(validReplacement(bytes,1,3,Buffer.from('x')),false);
  assert.equal(validReplacement(bytes,3,5,Buffer.from('x')),false);
  assert.equal(validReplacement(bytes,1,5,Buffer.from('🐈')),true);
  assert.equal(validReplacement(bytes,5,6,Buffer.from('word')),true);
});

test('no shared tokens makes no Jev calls and preserves newly written content',async()=>{
  let calls=0;
  const result=await detemplatize('apple','banana',makeDependencies(async()=>{calls++;throw Error('unreachable');}));
  assert.equal(result.text,'banana');assert.equal(calls,0);assert.equal(result.matched_tokens,0);
});

test('original and five alternatives are uniquely ranked and selection uses their sorted indices',async()=>{
  const deps=makeDependencies(async request=>{
    assert.equal(request.state.alternate_tokens.length,6);
    assert.equal(request.questions.token.criteria.candidate_3,'hello');
    assert.deepEqual(Object.keys(request.questions.token.criteria),Array.from({length:6},(_,i)=>`candidate_${i}`));
    assert.ok(!Object.hasOwn(request.questions.token.criteria,'original'));
    return {choice:'candidate_3',model:'test-jev'};
  });
  deps.score=async text=>({model:'test',tokens:scored(text).map(t=>({...t,logprob:-3.5,rank:4,candidates:['world','sleep','and','on','at'].map((word,i)=>({...token(ids(word)[0]!),rank:i+1,logprob:-i-1}))}))});
  assert.equal((await detemplatize('hello','hello',deps)).text,'hello');
  deps.choose=async request=>({choice:'candidate_4',model:'test-jev'});
  const changed=await detemplatize('hello','hello',deps);
  assert.equal(changed.text,'on');
  assert.equal(changed.changed_tokens,1);
});

test('formatting and word-fragment safeguards preserve layout while allowing whole-word style changes',()=>{
  assert.equal(sameWhitespaceEdges('.\n\n','.'),false);
  assert.equal(sameWhitespaceEdges(':\n\n',',\n\n'),true);
  assert.equal(sameWhitespaceEdges('Dear','Hi'),true);
  assert.equal(sameWhitespaceEdges("'s",' our'),false);
  const protectedPart=(text:string,part:string)=>{const bytes=Buffer.from(text);const start=bytes.indexOf(Buffer.from(part));return isProtectedFragment(bytes,start,start+Buffer.byteLength(part));};
  assert.equal(protectedPart('very aptly',' apt'),true);
  assert.equal(protectedPart('it exerts influence',' ex'),true);
  assert.equal(protectedPart("today's volunteers",'today'),true);
  assert.equal(protectedPart("today's volunteers","'s"),true);
  assert.equal(protectedPart('study, i.e., politics',' i'),true);
  assert.equal(protectedPart('study, i.e., politics','.e'),true);
  assert.equal(protectedPart('the "founders"',' "'),true);
  assert.equal(protectedPart('Dear Holly:','Dear'),false);
  assert.equal(protectedPart('a useful book',' useful'),false);
  assert.equal(protectedPart('we cannot go',' cannot'),true);
  assert.equal(protectedPart('a thing and another',' and'),true);
  assert.equal(protectedPart('they could leave',' could'),true);
});

test('injected model codec reconstructs its own token IDs rather than assuming Llama vocabulary',async()=>{
  const vocab=new Map([[1,'old'],[2,'new']]);
  const deps:DetemplatizeDependencies={
    codec:{tokenBytes:id=>Buffer.from(vocab.get(id)!),decodeTokens:ids=>ids.map(id=>vocab.get(id)!).join('')},
    prompt:async()=> 'Choose new',
    score:async()=>({model:'custom',tokens:[{id:1,token:'old',rank:2,logprob:-2,candidates:[{id:2,token:'new',rank:1,logprob:-1}]}]}),
    choose:async()=>({choice:'candidate_0',model:'test'}),
  };
  assert.equal((await detemplatize('old','old',deps)).text,'new');
  deps.validate=async()=>new Set();
  const rejected=await detemplatize('old','old',deps);
  assert.equal(rejected.text,'old');assert.equal(rejected.changed_tokens,0);assert.equal(rejected.rejected_tokens,1);
  assert.equal(rejected.decisions[0]!.proposed_replacement,'new');
  deps.validate=async()=>{throw Error('suffix scoring failed');};
  await assert.rejects(detemplatize('old','old',deps),/suffix scoring failed/);
});

test('suffix gate accepts plausible substitutions and rejects observed broken continuations',()=>{
  assert.equal(suffixCompatible([-1,-2,-3,-2],[-1.1,-2.3,-3.2,-2.2]),true);
  assert.equal(suffixCompatible([-1,-2,-3,-2],[-5.2,-2.7,-3.6,-2.8]),false);
  assert.equal(suffixCompatible([-1,-2,-3,-2],[-2.5,-3.5,-4.5,-3.5]),false);
  assert.equal(suffixCompatible([],[]),true);
  assert.throws(()=>suffixCompatible([-1],[]),/alignment/);
});

test('failed or invalid Jev choices never return a partial rewrite',async()=>{
  await assert.rejects(detemplatize('hello','hello',makeDependencies(async()=>({choice:'unoffered',model:'test'}))),/outside the offered choices/);
  await assert.rejects(detemplatize('hello','hello',makeDependencies(async()=>{throw Error('provider failure');})),/provider failure/);
});

function acsFixture(text:string,count:0|100){
  const tokens=ids(text);
  const positions=tokens.map(id=>{
    const options=new Map<number,Record<string,unknown>>();
    if(count===100)for(let i=0;i<100;i++)options.set(100+i,{decoded_token:token(100+i).token,rank:i+1,logprob:-i-1});
    options.set(id,{decoded_token:token(id).token,rank:1000,logprob:-10});
    return Object.fromEntries(options);
  });
  return {model:'meta-llama/Llama-3.1-8B',choices:[{prompt_logprobs:[null,...positions],logprobs:{tokens:['<|begin_of_text|>',...tokens.map(id=>token(id).token)],token_logprobs:[null,...tokens.map(()=>-10)]}}]};
}

test('ACS parser verifies all 100 candidates and the actual token outside them',()=>{
  const text='Hi 🦥';
  const fixture=acsFixture(text,100);
  const parsed=parseAcsResponse(fixture,text,100);
  assert.deepEqual(parsed.tokens.map(t=>t.id),ids(text));
  assert.ok(parsed.tokens.every(t=>t.candidates.length===100 && t.rank===1000));
  assert.deepEqual(parseAcsResponse(acsFixture(text,0),text,0).tokens.map(t=>t.id),ids(text));
  fixture.choices[0]!.prompt_logprobs.pop();
  assert.throws(()=>parseAcsResponse(fixture,text,100),/boundaries/);
  assert.throws(()=>parseAcsResponse({...acsFixture(text,100),model:'instruct-model'},text,100),/base model/);
  const missing=acsFixture(text,100);delete missing.choices[0]!.prompt_logprobs[1]!['100'];
  assert.throws(()=>parseAcsResponse(missing,text,100),/100 ranked candidates/);
});

test('tool requires explicit scaffold ID and new text, uses sequential aliases and reports provider failures',async()=>{
  for(const args of [undefined,{},[],null,{scaffold_id:1},{scaffold_id:1,text:4},{scaffold_id:0,text:'a'},
    {scaffold_id:'not-an-id',text:'a'},{scaffold_id:'9007199254740992',text:'a'},
    {scaffold_id:'1.5',text:'a'},{scaffold_id:1,text:'a',extra:true}]){
    await assert.rejects(callDetemplatizeTool(args,corpus),ProtocolError);
  }
  const deps=makeDependencies(async()=>({choice:'candidate_0',model:'test'}));
  const result=await callDetemplatizeTool({scaffold_id:1,text:'The dog sat on the rug.'},corpus,deps);
  assert.deepEqual(result,{content:[{type:'text',text:'The dog sat on the rug.'}]});
  assert.deepEqual(await callDetemplatizeTool({scaffold_id:'1',text:'The dog sat on the rug.'},corpus,deps),result);
  await assert.rejects(callDetemplatizeTool({scaffold_id:1,text:42},corpus,deps),/text must be a string; received number/);
  await assert.rejects(callDetemplatizeTool({scaffold_id:1,text:'a',extra:true},corpus,deps),/Unexpected detemplatize argument\(s\): extra/);
  const failed=await callDetemplatizeTool({scaffold_id:1,text:'The dog sat on the rug.'},corpus,
    makeDependencies(async()=>{throw Error('provider unavailable');}));
  assert.equal(failed.isError,true);
});

test('lexical alternatives cannot inject punctuation, digits, phrases or word fragments',()=>{
  assert.equal(isLexicalReplacement(' useful',' helpful'),true);
  assert.equal(isLexicalReplacement(' café',' bistro'),true);
  for(const [original,replacement] of [[',','—and'],['-','-end'],[' word',' words,'],[' 42',' forty'],[' word',' two words']]) {
    assert.equal(isLexicalReplacement(original!,replacement!),false);
  }
});

test('quoted wording and numbers remain immutable with Unicode byte offsets',async()=>{
  const text='🦥 A useful note says “very useful” and "useful" in 2026.';
  const ranges=protectedTextRanges(text),bytes=Buffer.from(text);
  assert.deepEqual(ranges.map(([start,end])=>bytes.subarray(start,end).toString('utf8')),['“very useful”','"useful"','2026']);
  const helpful=token(ids(' helpful')[0]!);
  const deps=makeDependencies(async request=>({choice:Object.entries(request.questions.token.criteria).find(([,value])=>value===' helpful')?.[0]??'candidate_0',model:'test'}));
  deps.score=async value=>({model:'test',tokens:ids(value).map(id=>({...token(id),candidates:[token(id),{...helpful,logprob:-2,rank:2}]}))});
  // Restrict the fake chooser to useful tokens; all other words retain themselves.
  deps.choose=async request=>({choice:request.state.current_token===' useful'?(Object.entries(request.questions.token.criteria).find(([,value])=>value===' helpful')?.[0]??'candidate_0'):'candidate_0',model:'test'});
  assert.equal((await detemplatize(text,text,deps)).text,'🦥 A helpful note says “very useful” and "useful" in 2026.');
});


test('production chooser resolves forced choices locally without a provider request',async()=>{
  const acs=process.env.ACS_API_KEY,jev=process.env.TYPESAFE_API_KEY;
  process.env.ACS_API_KEY='offline-test';process.env.TYPESAFE_API_KEY='offline-test';
  try {
    const deps=await createDetemplatizeDependencies();
    const request:JevRequest={model:'jev-latest',state:{scaffold_exemplar:'the',before_text:'',current_token:'the',after_text:'',alternate_tokens:['the']},questions:{token:{type:'choice',instructions:'Keep protected text',criteria:{candidate_0:'the'}}}};
    assert.deepEqual(await deps.choose(request),{choice:'candidate_0',model:'identity'});
    request.questions.token.criteria={};
    await assert.rejects(deps.choose(request),/No valid token choices/);
  } finally {
    if(acs===undefined)delete process.env.ACS_API_KEY;else process.env.ACS_API_KEY=acs;
    if(jev===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=jev;
  }
});
