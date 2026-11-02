import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Corpus} from '../src/corpus.js';
import {Library} from '../src/library.js';
import type {ImportedRecord} from '../src/library.js';
import {callLocalScaffoldTool as callScaffoldTool,SCAFFOLD_TOOLS,SCAFFOLD_SOURCES} from '../src/scaffold-tools.js';
import {parseCatalog} from './content.js';
import type {ScaffoldStore} from '../src/scaffold-store.js';

const original=new Corpus(Buffer.from(JSON.stringify({id:41,type:'post',title:'Legacy',text:'A legacy example',url:'https://example.test/legacy',copy_blocks:[],nsfw:false})));
const row=(source:string,sequential_id:number,nsfw=false):ImportedRecord=>{
 const text=`${source} example ${sequential_id}`;
 return {id:randomUUID(),sequential_id,type:'scaffold',source,title:text,text,text_sha256:createHash('sha256').update(text).digest('hex'),url:'https://example.test/',author:'Example author',content_kind:'full_text',license:{name:'Test'},nsfw};
};
const records=[row('sec_s1',2),row('sec_s1',3,true),row('gutenberg',4),row('sec_s1',5),row('gutenberg',6,true)];
const library=new Library(original,Buffer.from(records.map(r=>JSON.stringify(r)).join('\n')));
function listed(store:ScaffoldStore,args:Record<string,unknown>){
 const content=callScaffoldTool('list_scaffolds',args,store).content[0]!;
 assert.equal(content.type,'text');assert.ok('text' in content);return parseCatalog(content.text);
}

test('source filtering counts the selected source before applying NSFW exclusion',()=>{
 const page=listed(library,{source:'sec_s1'});
 assert.equal(page.total,3);assert.equal(page.eligible,2);
 assert.deepEqual(new Set(page.scaffolds.map(r=>r.sequential_id)),new Set([2,5]));
 assert.ok(page.scaffolds.every(r=>r.source==='sec_s1'));
 const all=listed(library,{source:'sec_s1',nsfw:true});
 assert.equal(all.total,3);assert.equal(all.listed,3);
 assert.deepEqual(new Set(all.scaffolds.map(r=>r.sequential_id)),new Set([2,3,5]));
 assert.equal(listed(library,{}).total,6);
 assert.equal(listed(library,{source:'wikisource'}).total,0);
 assert.equal(listed(original,{source:'copypastatext'}).scaffolds[0]!.sequential_id,1);
});

test('source is inherited from a cursor and cannot change mid-listing',()=>{
 const first=listed(library,{source:'sec_s1',nsfw:true,limit:1});
 const cursor=first.nextCursor!;assert.ok(cursor);
 const second=listed(library,{cursor,limit:1});
 assert.equal(second.total,3);assert.equal(second.offset,1);assert.equal(second.scaffolds[0]!.source,'sec_s1');
 assert.deepEqual(listed(library,{cursor,source:'sec_s1',limit:1}).scaffolds,second.scaffolds);
 assert.throws(()=>listed(library,{cursor,source:'gutenberg'}),/source must match/);
 const global=listed(library,{nsfw:true,limit:1});
 assert.throws(()=>listed(library,{cursor:global.nextCursor!,source:'sec_s1'}),/source must match/);
 const ids=new Set(first.scaffolds.map(r=>r.sequential_id));let next=cursor;
 while(next){const p=listed(library,{cursor:next,limit:1});for(const r of p.scaffolds){assert.ok(!ids.has(r.sequential_id));ids.add(r.sequential_id);}next=p.nextCursor??'';}
 assert.deepEqual(ids,new Set(records.filter(r=>r.source==='sec_s1').map(r=>r.sequential_id)));
 for(const r of records)assert.equal(library.getScaffoldBySequentialId(r.sequential_id),r.text);
});

test('source arguments are validated and advertised in the tool schema',()=>{
 for(const source of ['',null,1,[],['sec_s1'],'SEC_S1','missing'])assert.throws(()=>listed(library,{source}),/source must be one of/);
 const schema=SCAFFOLD_TOOLS.find(t=>t.name==='list_scaffolds')!.inputSchema.properties!;
 assert.ok(schema.source);
});

test('inclusion and exclusion select source sets before the independent NSFW filter',()=>{
 const selected={include_sources:['sec_s1','gutenberg']};
 const page=listed(library,selected);
 assert.equal(page.total,5);assert.equal(page.eligible,3);
 assert.deepEqual(new Set(page.scaffolds.map(r=>r.sequential_id)),new Set([2,4,5]));
 const excluded=listed(library,{...selected,exclude_sources:['sec_s1'],nsfw:true});
 assert.equal(excluded.total,2);assert.equal(excluded.eligible,2);
 assert.deepEqual(new Set(excluded.scaffolds.map(r=>r.sequential_id)),new Set([4,6]));
 const onlyExclude=listed(library,{exclude_sources:['sec_s1']});
 assert.equal(onlyExclude.total,3);assert.equal(onlyExclude.eligible,2);
 assert.deepEqual(new Set(onlyExclude.scaffolds.map(r=>r.sequential_id)),new Set([1,4]));
 assert.equal(listed(library,{include_sources:[]}).total,0);
 assert.equal(listed(library,{include_sources:[]}).nextCursor,undefined);
 assert.equal(listed(library,{exclude_sources:[]}).total,6);
 assert.equal(listed(library,{exclude_sources:[...SCAFFOLD_SOURCES]}).total,0);
 assert.equal(listed(library,{source:'sec_s1',exclude_sources:['sec_s1']}).total,0);
 assert.equal(listed(library,{include_sources:['wikisource']}).total,0);
 assert.deepEqual(listed(original,{exclude_sources:['gutenberg']}).scaffolds.map(r=>r.sequential_id),[1]);
 assert.equal(listed(original,{exclude_sources:['copypastatext']}).listed,0);
});

test('both source lists survive pagination, treat order as immaterial, and reject changes',()=>{
 const first=listed(library,{include_sources:['sec_s1','gutenberg','wikisource'],exclude_sources:['wikisource','queneau'],nsfw:true,limit:1});
 let cursor=first.nextCursor!;assert.ok(cursor);
 const ids=new Set(first.scaffolds.map(r=>r.sequential_id));
 const second=listed(library,{cursor,limit:1});
 assert.deepEqual(listed(library,{cursor,limit:1,include_sources:['wikisource','gutenberg','sec_s1'],exclude_sources:['queneau','wikisource']}).scaffolds,second.scaffolds);
 for(const args of [{include_sources:['sec_s1']},{include_sources:[]},{exclude_sources:[]},{exclude_sources:['sec_s1']},{nsfw:false}]){
  assert.throws(()=>listed(library,{cursor,...args}),/must match/);
 }
 while(cursor){const page=listed(library,{cursor,limit:1});assert.equal(page.total,5);for(const row of page.scaffolds){assert.ok(!ids.has(row.sequential_id));ids.add(row.sequential_id);}cursor=page.nextCursor??'';}
 assert.deepEqual(ids,new Set([2,3,4,5,6]));
 const longest=listed(library,{include_sources:[...SCAFFOLD_SOURCES],exclude_sources:SCAFFOLD_SOURCES.filter(s=>s!=='sec_s1'),limit:1,nsfw:true});
 assert.ok(longest.nextCursor);assert.equal(listed(library,{cursor:longest.nextCursor}).listed,2);
});

test('legacy single-source cursors and the source shorthand interoperate with inclusion lists',()=>{
 const first=listed(library,{source:'sec_s1',nsfw:true,limit:1});
 const current=first.nextCursor!;
 const decoded=JSON.parse(Buffer.from(current,'base64url').toString('utf8'));
 delete decoded.include_sources;decoded.source='sec_s1';
 const legacy=Buffer.from(JSON.stringify(decoded)).toString('base64url');
 const next=listed(library,{cursor:legacy,limit:1});
 assert.deepEqual(next.scaffolds,listed(library,{cursor:current,include_sources:['sec_s1'],limit:1}).scaffolds);
 assert.ok(next.nextCursor);
 assert.deepEqual(listed(library,{cursor:next.nextCursor,source:'sec_s1'}).scaffolds,listed(library,{cursor:next.nextCursor}).scaffolds);
});

test('source lists reject invalid entries and ambiguous shorthand',()=>{
 for(const name of ['include_sources','exclude_sources']){
  for(const value of [null,'sec_s1',1,{},['missing'],['SEC_S1'],[null],['sec_s1',1],['sec_s1','sec_s1'],Array(7).fill('sec_s1')]){
   assert.throws(()=>listed(library,{[name]:value}),new RegExp(name+' must be an array'));
  }
 }
 assert.throws(()=>listed(library,{source:'sec_s1',include_sources:['sec_s1']}),/only one/);
 const schema=SCAFFOLD_TOOLS.find(t=>t.name==='list_scaffolds')!.inputSchema.properties!;
 for(const name of ['include_sources','exclude_sources'])assert.deepEqual((schema[name] as {items:{enum:unknown}}).items.enum,[...SCAFFOLD_SOURCES]);
});
