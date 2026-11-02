import assert from 'node:assert/strict';
import {test} from 'node:test';
import tokenizer from 'llama3-tokenizer-js';
import {moveClauses,hybridWithMoves} from '../src/hybrid-movement.js';
import {discoverMoves,applyMoves} from '../src/clause-moves.js';
import type {Dependencies} from '../src/hybrid-detemplatize.js';
import {tokenBytes,type TokenizedText} from '../src/detemplatize.js';

const value='At the station, she waited for the next train. After the meeting, they went straight back home.';
const moves=discoverMoves(value);
const isSelection=(alternatives:Record<string,string>)=>Object.keys(alternatives).some(k=>k.startsWith('sample_'));
const choiceFor=(alternatives:Record<string,string>,texts:Set<string>)=>Object.entries(alternatives).find(([,text])=>texts.has(text))![0];
const movedTexts=new Set(moves.map(m=>m.replacement));
const originalTexts=new Set(moves.map(m=>m.original));
function pureDependencies(choose:Dependencies['choose']):Dependencies {
  return {
    generate:async()=>{throw Error('mechanical movements must not call a generator');},
    score:async()=>{throw Error('mechanical movements must not call a scoring provider');},
    choose,
  };
}
const scored=(text:string):TokenizedText=>({model:'meta-llama/Llama-3.1-8B',tokens:tokenizer.encode(text,{bos:false,eos:false}).map((id:number)=>({id,token:tokenBytes(id).toString('utf8'),rank:1,logprob:-1,candidates:[]}))});

test('local movement rejection preserves text and avoids ordering and document reviews',async()=>{
  let calls=0;
  const result=await moveClauses(value,pureDependencies(async(prompt,original,alternatives)=>{
    calls++;assert.equal(original,value);assert.ok(prompt.includes('rearranged_sentence'));
    assert.equal(isSelection(alternatives),false);
    return {choice:'reject',model:'offline'};
  }));
  assert.equal(calls,2);assert.equal(result.text,value);assert.deepEqual(result.moves,[]);assert.deepEqual(result.repairs,[]);
  assert.ok(result.decisions.every(d=>!d.selected&&d.selection.model==='identity'));
  assert.deepEqual(result.counts,{slots:2,raw:0,eligible:2,faithful:0,selected:0,applied:0});
});

test('choosing original ordering is a no-op even after local approval',async()=>{
  let local=0,selections=0;
  const result=await moveClauses(value,pureDependencies(async(prompt,original,alternatives)=>{
    assert.equal(original,value);assert.ok(!prompt.includes('Assess the entire revision'));
    if(isSelection(alternatives)){
      selections++;return {choice:choiceFor(alternatives,originalTexts),model:'offline'};
    }
    local++;return {choice:'accept',model:'offline'};
  }));
  assert.equal(local,2);assert.equal(selections,2);assert.equal(result.text,value);
  assert.equal(result.counts.faithful,2);assert.equal(result.counts.selected,0);assert.deepEqual(result.repairs,[]);
});

test('combined rejection transactionally retains an approved movement and rejects the other',async()=>{
  assert.equal(moves.length,2);
  const both=applyMoves(value,moves),firstOnly=applyMoves(value,[moves[0]!]);
  const revisions:string[]=[];
  const result=await moveClauses(value,pureDependencies(async(prompt,reference,alternatives)=>{
    assert.equal(reference,value);
    if(isSelection(alternatives))return {choice:choiceFor(alternatives,movedTexts),model:'offline'};
    if(prompt.includes('Assess the entire revision')){
      const revision=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1)).revision as string;
      revisions.push(revision);
      return {choice:revision.includes(moves[1]!.replacement)?'reject':'accept',model:'offline'};
    }
    return {choice:'accept',model:'offline'};
  }));
  assert.deepEqual(revisions,[both,firstOnly,both]);
  assert.deepEqual(result.repairs.map(({indices,choice})=>({indices,choice})),[
    {indices:[0,1],choice:'reject'},{indices:[0],choice:'accept'},{indices:[0,1],choice:'reject'},
  ]);
  assert.equal(result.text,firstOnly);assert.deepEqual(result.moves,[moves[0]]);
  assert.deepEqual(result.counts,{slots:2,raw:0,eligible:2,faithful:2,selected:2,applied:1});
});

test('unoffered movement review, selection and combined answers fail closed',async()=>{
  for(const failure of ['local','selection','combined','repair']){
    let combinedCalls=0;
    await assert.rejects(moveClauses(value,pureDependencies(async(prompt,_original,alternatives)=>{
      const current=isSelection(alternatives)?'selection':prompt.includes('Assess the entire revision')?(++combinedCalls===1?'combined':'repair'):'local';
      if(current===failure)return {choice:'invented',model:'offline'};
      if(current==='selection')return {choice:choiceFor(alternatives,movedTexts),model:'offline'};
      return {choice:failure==='repair'&&current==='combined'?'reject':'accept',model:'offline'};
    })),/Invalid .*movement|Invalid movement/);
  }
});

test('movement budgets reject invalid values before provider calls and honor zero and one',async()=>{
  let calls=0;
  const deps=pureDependencies(async(_prompt,_original,alternatives)=>{
    calls++;return {choice:isSelection(alternatives)?choiceFor(alternatives,movedTexts):'accept',model:'offline'};
  });
  for(const limit of [-1,25,NaN,Infinity,.5])await assert.rejects(moveClauses(value,deps,{limit}),/Invalid movement budget/);
  assert.equal(calls,0);
  const none=await moveClauses(value,deps,{limit:0});assert.equal(none.text,value);assert.equal(none.counts.slots,0);assert.equal(calls,0);
  const one=await moveClauses(value,deps,{limit:1});assert.equal(one.counts.slots,1);assert.equal(one.counts.applied,1);
  assert.equal(one.text,applyMoves(value,[moves[0]!]));assert.equal(calls,3);
});

test('hybridWithMoves reviews the final moved text against the original pre-phrase document',async()=>{
  const original='At the station, we waited in order to meet her.';
  const phraseText=original.replace('in order to','to');
  const moved=applyMoves(phraseText,discoverMoves(phraseText));
  assert.notEqual(moved,phraseText);
  const observed:{stage:string;reference:string}[]=[];
  const deps:Dependencies={
    generate:async(prompts,_temperature,maxTokens)=>{
      assert.equal(maxTokens,384);return prompts.map(()=>phraseText);
    },
    score:async texts=>texts.map(scored),
    choose:async(prompt,reference,alternatives)=>{
      if(isSelection(alternatives)){
        if(Object.values(alternatives).includes(moved)){
          observed.push({stage:'movement-selection',reference});
          return {choice:choiceFor(alternatives,new Set([moved])),model:'offline'};
        }
        observed.push({stage:'phrase-selection',reference});
        return {choice:choiceFor(alternatives,new Set([phraseText])),model:'offline'};
      }
      if(prompt.includes('Assess the entire revision')){
        observed.push({stage:'movement-document-review',reference});
        assert.equal(JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1)).revision,moved);
      }else if(prompt.includes('rearranged_sentence')){
        observed.push({stage:'movement-local-review',reference});
      }else if(prompt.includes('COMPLETE combined')){
        observed.push({stage:'phrase-document-review',reference});
      }else observed.push({stage:'phrase-local-review',reference});
      return {choice:'accept',model:'offline'};
    },
  };
  const result=await hybridWithMoves(original,original,deps,{limit:1,draws:2});
  assert.equal(result.phrases.text,phraseText);assert.equal(result.movement.text,moved);assert.equal(result.text,moved);
  assert.equal(observed.find(o=>o.stage==='movement-local-review')!.reference,phraseText);
  assert.equal(observed.find(o=>o.stage==='movement-selection')!.reference,phraseText);
  assert.equal(observed.find(o=>o.stage==='movement-document-review')!.reference,original);
  assert.equal(observed.find(o=>o.stage==='phrase-document-review')!.reference,original);
  assert.deepEqual(result.counts,{slots:2,raw:2,eligible:2,faithful:2,selected:2,applied:2});
});
