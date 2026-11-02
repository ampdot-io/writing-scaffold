import assert from 'node:assert/strict';
import {test} from 'node:test';
import tokenizer from 'llama3-tokenizer-js';
import {hybrid,suffixCheck,sentencePrompt,extractPhrase,type Dependencies} from '../src/hybrid-detemplatize.js';
import {discoverSpans,type Span} from '../src/hybrid-spans.js';
import {tokenBytes,type TokenizedText} from '../src/detemplatize.js';

const text='We walked in order to reach town.';
const span=discoverSpans(text,text,1)[0]!;
const replacement=span.original.replace('in order to','to');
const changed=text.slice(0,span.start)+replacement+text.slice(span.end);
const scored=(value:string,logprob=-1):TokenizedText=>({
  model:'meta-llama/Llama-3.1-8B',
  tokens:tokenizer.encode(value,{bos:false,eos:false}).map((id:number)=>({id,token:tokenBytes(id).toString('utf8'),rank:1,logprob,candidates:[]})),
});
const isSelection=(alternatives:Record<string,string>)=>Object.keys(alternatives).some(key=>key.startsWith('sample_'));
const revisedChoice=(alternatives:Record<string,string>)=>Object.entries(alternatives).find(([key,value])=>key.startsWith('sample_')&&!value.includes('in order to'))![0];
const originalChoice=(alternatives:Record<string,string>)=>Object.entries(alternatives).find(([key,value])=>key.startsWith('sample_')&&value.includes('in order to'))![0];
const spanFor=(value:string,original:string,occurrence=0):Span=>{
 let start=-1;for(let i=0;i<=occurrence;i++)start=value.indexOf(original,start+1);
 assert.ok(start>=0);
 const bound=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(value)].find(s=>s.index<=start&&start+original.length<=s.index+s.segment.length)!;
 return {start,end:start+original.length,original,sentenceStart:bound.index,sentenceEnd:bound.index+bound.segment.length};
};
function dependencies(overrides:Partial<Dependencies>={}):Dependencies {
  return {
    generate:async prompts=>prompts.map(()=>replacement),
    choose:async (prompt,_original,alternatives)=>({choice:isSelection(alternatives)?revisedChoice(alternatives):'accept',model:'offline-jev'}),
    score:async texts=>texts.map(value=>scored(value)),
    ...overrides,
  };
}

test('a contextual phrase passes semantic, selection, suffix and combined gates in order',async()=>{
  const phases:string[]=[];
  let generated=0;
  const result=await hybrid(text,text,dependencies({
    generate:async(prompts,temperature,maxTokens)=>{
      generated++;assert.equal(prompts.length,3);assert.equal(temperature,.9);assert.equal(maxTokens,24);
      assert.ok(prompts.every(prompt=>prompt.includes('['+span.original+']')));
      return [replacement,replacement,'<invalid>'];
    },
    choose:async(prompt,original,alternatives)=>{
      assert.equal(original,text);
      if(isSelection(alternatives)){
        phases.push('select');assert.deepEqual(new Set(Object.values(alternatives)),new Set([text,changed]));
        return {choice:revisedChoice(alternatives),model:'offline-jev'};
      }
      if(prompt.includes('COMPLETE combined')){
        phases.push('combined');assert.ok(prompt.includes(JSON.stringify({revision:changed})));
      }else{
        phases.push('semantic');assert.ok(prompt.includes(JSON.stringify({original_sentence:text,revised_sentence:changed})));
      }
      return {choice:'accept',model:'offline-jev'};
    },
    score:async values=>{
      phases.push('score');assert.deepEqual(values,[text,changed]);return values.map(value=>scored(value));
    },
  }),{limit:1,draws:3,generator:'phrase'});
  assert.equal(generated,1);
  assert.deepEqual(phases,['semantic','select','score','combined']);
  assert.equal(result.text,changed);assert.equal(result.edits.length,1);
  assert.deepEqual(result.counts,{slots:1,raw:3,eligible:1,faithful:1,selected:1,suffix_pass:1,applied:1});
});

test('semantic rejection keeps the original and does not call selection or suffix providers',async()=>{
  let decisions=0;
  const result=await hybrid(text,text,dependencies({
    choose:async(_prompt,_original,alternatives)=>{decisions++;assert.ok(!isSelection(alternatives));return {choice:'reject',model:'offline'};},
    score:async()=>{throw Error('must not score rejected alternatives');},
  }),{limit:1,proposals:[[replacement]]});
  assert.equal(decisions,1);assert.equal(result.text,text);assert.equal(result.unvalidated_text,text);
  assert.equal(result.counts.faithful,0);assert.equal(result.counts.applied,0);
});

test('a suffix likelihood collapse vetoes an otherwise selected phrase',async()=>{
  let combined=0;
  const result=await hybrid(text,text,dependencies({
    choose:async(prompt,_original,alternatives)=>{
      if(prompt.includes('COMPLETE combined'))combined++;
      return {choice:isSelection(alternatives)?revisedChoice(alternatives):'accept',model:'offline'};
    },
    score:async values=>values.map((value,i)=>scored(value,i===0?-1:-10)),
  }),{limit:1,proposals:[[replacement]]});
  assert.equal(result.unvalidated_text,changed);assert.equal(result.text,text);
  assert.equal(result.counts.selected,1);assert.equal(result.counts.suffix_pass,0);assert.equal(combined,0);
});

test('Jev can explicitly retain the original even when an alternative passes semantic review',async()=>{
  const result=await hybrid(text,text,dependencies({
    choose:async(_prompt,_original,alternatives)=>({choice:isSelection(alternatives)?originalChoice(alternatives):'accept',model:'offline'}),
    score:async()=>{throw Error('unchanged text must not be rescored');},
  }),{limit:1,proposals:[[replacement]]});
  assert.equal(result.text,text);assert.equal(result.counts.faithful,1);assert.equal(result.counts.selected,0);
});

test('rejecting the combined document and every repair trial retains only an auditable proposal',async()=>{
  const value='We walked in order to reach town. We waited in order to meet her.';
  const spans=discoverSpans(value,value,2);
  assert.equal(spans.length,2);
  const proposals=spans.map(s=>[s.original.replace('in order to','to')]);
  const result=await hybrid(value,value,dependencies({
    choose:async(prompt,_original,alternatives)=>({choice:prompt.includes('COMPLETE combined')?'reject':isSelection(alternatives)?revisedChoice(alternatives):'accept',model:'offline'}),
  }),{limit:2,proposals});
  assert.equal(result.text,value);assert.deepEqual(result.edits,[]);
  assert.equal(result.counts.suffix_pass,2);assert.equal(result.counts.applied,0);
  assert.notEqual(result.proposed_text,value);assert.equal(result.combined.choice,'reject');
  assert.deepEqual(result.repairs.map(r=>r.choice),['reject','reject']);
});

test('unoffered Jev answers fail closed at semantic, selection and combined review stages',async()=>{
  for(const stage of ['semantic','selection','combined']){
    await assert.rejects(hybrid(text,text,dependencies({
      choose:async(prompt,_original,alternatives)=>{
        const current=prompt.includes('COMPLETE combined')?'combined':isSelection(alternatives)?'selection':'semantic';
        return {choice:current===stage?'invented':current==='selection'?revisedChoice(alternatives):'accept',model:'offline'};
      },
    }),{limit:1,proposals:[[replacement]]}),/Invalid .* choice/);
  }
});

test('frozen proposals can be reused across ranking modes without generation or mutation',async()=>{
  const proposals=[[replacement]];
  const frozen=JSON.stringify(proposals);
  let generation=0;
  const deps=dependencies({generate:async()=>{generation++;throw Error('must reuse frozen proposals');}});
  const natural=await hybrid(text,text,deps,{limit:1,proposals,mode:'natural'});
  const distinctive=await hybrid(text,text,deps,{limit:1,proposals,mode:'distinctive'});
  assert.equal(generation,0);assert.equal(JSON.stringify(proposals),frozen);
  assert.equal(natural.text,changed);assert.equal(distinctive.text,changed);
  await assert.rejects(hybrid(text,text,deps,{limit:1,proposals:[]}),/Proposal\/span mismatch/);
});

test('suffix validation anchors UTF-8 bytes after retokenizing a shorter Unicode-prefixed edit',()=>{
  const original='🦥 We walked in order to reach town. The river was quiet.';
  const revised=original.replace('in order to','to');
  const oldEnd=Buffer.byteLength(original.slice(0,original.indexOf(' reach')));
  const newEnd=Buffer.byteLength(revised.slice(0,revised.indexOf(' reach')));
  assert.equal(suffixCheck(scored(original),scored(revised),oldEnd,newEnd),true);
  assert.equal(suffixCheck(scored(original),scored(revised.replace('reach town','leave town')),oldEnd,newEnd),false);
  assert.equal(suffixCheck(scored(original),scored(revised,-10),oldEnd,newEnd),false);
});

test('malformed generation and missing scoring records never yield a partial rewrite',async()=>{
  await assert.rejects(hybrid(text,text,dependencies({generate:async()=>[]}),{limit:1,draws:2}),/Missing base proposals/);
  await assert.rejects(hybrid(text,text,dependencies({score:async()=>[scored(text)]}),{limit:1,proposals:[[replacement]]}),/Missing suffix-validation scores/);
});


test('sentence extraction requires exact surrounding words and punctuation',()=>{
  const source='We waited in order to reach town.';
  const slot=spanFor(source,'in order to');
  assert.equal(extractPhrase(source,slot,'We waited to reach town.'),'to');
  for(const generated of ['They waited to reach town.','We waited to reach home.','We waited to reach town!','We waited to reach town. Extra commentary.','waited to reach town.']){
    assert.equal(extractPhrase(source,slot,generated),'',generated);
  }
});

test('repeated source phrases stay anchored to the selected occurrence',()=>{
  const source='We waited by the gate, then waited by the gate.';
  const first=spanFor(source,'by the gate',0),second=spanFor(source,'by the gate',1);
  const firstChanged='We waited near the gate, then waited by the gate.';
  const secondChanged='We waited by the gate, then waited near the gate.';
  assert.equal(extractPhrase(source,first,firstChanged),'near the gate');
  assert.equal(extractPhrase(source,second,secondChanged),'near the gate');
  assert.equal(extractPhrase(source,first,secondChanged),'');
  assert.equal(extractPhrase(source,second,firstChanged),'');
  assert.equal(extractPhrase(source,first,'We waited near the gate.'),'');
});

test('sentence extraction handles Unicode and normalizes only context whitespace',()=>{
  const source='🦥 We waited near the café at dusk.';
  const slot=spanFor(source,'near the café');
  assert.equal(extractPhrase(source,slot,'🦥 We waited beside the café at dusk.'),'beside the café');
  assert.equal(extractPhrase(source,slot,'🐈 We waited beside the café at dusk.'),'');
  const whitespace='\tWe waited  in order to\treach town.  ';
  const wsSlot=spanFor(whitespace,'in order to');
  assert.equal(extractPhrase(whitespace,wsSlot,'  We waited to  reach town. '),'to');
  assert.ok(sentencePrompt(whitespace,wsSlot).endsWith('Original: We waited [in order to] reach town.\nRewrite:'));
});

test('sentence generation extracts only a legal local edit and rejects changed context',async()=>{
  let generated=0,semantics=0;
  const result=await hybrid(text,text,dependencies({
    generate:async(prompts,temperature,maxTokens)=>{
      generated++;assert.equal(prompts.length,3);assert.equal(temperature,.9);assert.equal(maxTokens,384);
      assert.ok(prompts.every(prompt=>prompt.endsWith(sentencePrompt(text,span).split('Original: ').at(-1)!)));
      return [changed,changed.replace('We','They'),changed.replace('town','home')];
    },
    choose:async(prompt,original,alternatives)=>{
      if(!isSelection(alternatives)&&!prompt.includes('COMPLETE combined'))semantics++;
      assert.equal(original,text);
      return {choice:isSelection(alternatives)?revisedChoice(alternatives):'accept',model:'offline'};
    },
  }),{limit:1,draws:3,generator:'sentence'});
  assert.equal(generated,1);assert.equal(semantics,1);
  assert.deepEqual(result.proposals,[[replacement,'','']]);
  assert.equal(result.text,changed);assert.equal(result.counts.eligible,1);assert.equal(result.counts.applied,1);
});


test('transactional repair preserves an unrelated safe edit while rejecting a bad second edit',async()=>{
  const value='We walked in order to reach town. We waited in order to meet her.';
  const spans=discoverSpans(value,value,2);
  assert.equal(spans.length,2);
  const first=spans[0]!.original.replace('in order to','to');
  const second=spans[1]!.original.replace('waited in order to','hurried to');
  assert.notEqual(second,spans[1]!.original);
  const firstOnly=value.slice(0,spans[0]!.start)+first+value.slice(spans[0]!.end);
  const both=value.slice(0,spans[0]!.start)+first+value.slice(spans[0]!.end,spans[1]!.start)+second+value.slice(spans[1]!.end);
  assert.notEqual(first.length,spans[0]!.original.length,'first edit shifts subsequent output positions');
  const revisions:string[]=[];
  const result=await hybrid(value,value,dependencies({
    choose:async(prompt,original,alternatives)=>{
      assert.equal(original,value,'every trial is judged against the immutable original document');
      if(prompt.includes('COMPLETE combined')){
        const revision=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1)).revision as string;
        revisions.push(revision);
        return {choice:revision.includes('hurried to meet her')?'reject':'accept',model:'offline'};
      }
      return {choice:isSelection(alternatives)?revisedChoice(alternatives):'accept',model:'offline'};
    },
  }),{limit:2,proposals:[[first],[second]]});
  assert.deepEqual(revisions,[both,firstOnly,both]);
  assert.equal(result.combined.choice,'reject');
  assert.deepEqual(result.repairs.map(({edit,choice})=>({edit,choice})),[{edit:0,choice:'accept'},{edit:1,choice:'reject'}]);
  assert.equal(result.text,firstOnly);assert.equal(result.proposed_text,both);
  assert.equal(result.counts.suffix_pass,2);assert.equal(result.counts.applied,1);
  assert.deepEqual(result.edits,[{span:spans[0],replacement:first}]);
  assert.equal(result.trace[1]!.span.start,spans[1]!.start);
  assert.equal(value.slice(result.trace[1]!.span.start,result.trace[1]!.span.end),spans[1]!.original);
});

test('an invalid repair answer fails closed even after an earlier repair was accepted',async()=>{
  const value='We walked in order to reach town. We waited in order to meet her.';
  const spans=discoverSpans(value,value,2);
  let reviews=0;
  await assert.rejects(hybrid(value,value,dependencies({
    choose:async(prompt,_original,alternatives)=>{
      if(prompt.includes('COMPLETE combined')){
        reviews++;
        return {choice:reviews===1?'reject':reviews===2?'accept':'unoffered-repair',model:'offline'};
      }
      return {choice:isSelection(alternatives)?revisedChoice(alternatives):'accept',model:'offline'};
    },
  }),{limit:2,proposals:spans.map(s=>[s.original.replace('in order to','to')])}),/Invalid repair-review choice/);
  assert.equal(reviews,3);
});


test('invalid budgets and unsupported strategies fail before any dependency call',async()=>{
  let calls=0;
  const deps:Dependencies={
    generate:async()=>{calls++;throw Error('unexpected generation');},
    choose:async()=>{calls++;throw Error('unexpected choice');},
    score:async()=>{calls++;throw Error('unexpected scoring');},
  };
  for(const options of [{limit:-1},{limit:25},{limit:.5},{limit:NaN},{limit:Infinity},{draws:0},{draws:9},{draws:1.5},{draws:NaN},{draws:Infinity}]){
    await assert.rejects(hybrid(text,text,deps,options),/Invalid hybrid edit budget/);
  }
  for(const options of [{mode:'unsupported'},{generator:'unsupported'}]){
    await assert.rejects(hybrid(text,text,deps,options as Parameters<typeof hybrid>[3]),/Invalid hybrid strategy/);
  }
  assert.equal(calls,0);
  const noEdits=await hybrid(text,text,deps,{limit:0,draws:8,proposals:[]});
  assert.equal(noEdits.text,text);assert.equal(noEdits.counts.slots,0);assert.equal(calls,0);
});

test('the default path generates contextual sentences and uses fresh phrasing selection',async()=>{
  let generated=0,selected=0;
  const result=await hybrid(text,text,dependencies({
    generate:async(prompts,temperature,maxTokens)=>{
      generated++;assert.equal(prompts.length,4);assert.equal(temperature,.9);assert.equal(maxTokens,384);
      assert.ok(prompts.every(prompt=>prompt===sentencePrompt(text,span)));
      return prompts.map(()=>changed);
    },
    choose:async(prompt,original,alternatives)=>{
      assert.equal(original,text);
      if(isSelection(alternatives)){
        selected++;assert.ok(prompt.includes('Prefer a DIFFERENT yet equally faithful and grammatical'));
        assert.deepEqual(new Set(Object.values(alternatives)),new Set([text,changed]));
        return {choice:revisedChoice(alternatives),model:'offline'};
      }
      return {choice:'accept',model:'offline'};
    },
  }));
  assert.equal(generated,1);assert.equal(selected,1);assert.equal(result.text,changed);
  assert.equal(result.counts.raw,4);assert.equal(result.counts.eligible,1);assert.equal(result.counts.applied,1);
});
