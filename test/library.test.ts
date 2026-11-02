import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ResourceNotFoundError } from '@modelcontextprotocol/server';
import { Corpus } from '../src/corpus.js';
import { Library, type ImportedRecord } from '../src/library.js';
import { callLocalScaffoldTool as callScaffoldTool } from '../src/scaffold-tools.js';
import { textOf } from './content.js';

const legacyRow = {id: 700, type:'post', title:'Original', url:'https://example.test/original', text:'original', copy_blocks:[], nsfw:false};
const original = () => new Corpus(Buffer.from(JSON.stringify(legacyRow)));
const entry = (sequential_id:number, overrides:Partial<ImportedRecord> = {}):ImportedRecord => {
  const text='A letter\n👩‍👩‍👧‍👦 e\u0301';
  return {id:randomUUID(),sequential_id,type:'scaffold',source:'gutenberg',title:'A letter',text,
    text_sha256:createHash('sha256').update(text).digest('hex'),url:'https://example.test/letter',author:'Writer',
    content_kind:'full_text',nsfw:false,license:{name:'Public domain'},...overrides};
};
const bytes=(rows:ImportedRecord[])=>Buffer.from(rows.map(r=>JSON.stringify(r)).join('\n'));
const toolText=(library:Library,name:string,args:unknown)=>{
  const content=callScaffoldTool(name,args,library).content[0]!;
  assert.equal(content.type,'text'); assert.ok('text' in content); return content.text;
};

test('persistent canonical and sequential IDs retrieve the same entry across shuffled calls and reloads',()=>{
  const rows=[entry(2),entry(3,{source:'wikisource',nsfw:true}),entry(4,{source:'wikisource',content_kind:'reference'})];
  const library=new Library(original(),bytes(rows));
  const again=new Library(original(),bytes(rows));
  for(const store of [library,again]){
    for(const r of rows){
      assert.equal(store.getScaffold(r.id),r.text);
      assert.equal(store.getScaffoldBySequentialId(r.sequential_id),r.text);
      assert.equal(toolText(store,'get_scaffold',{sequential_id:r.sequential_id}),r.text);
      assert.equal(toolText(store,'get_scaffold',{id:r.id}),r.text);
      assert.equal(textOf(store.read(`scaffold://entries/${r.id}`)),r.text);
      assert.deepEqual(JSON.parse(textOf(store.read(`scaffold://entries/${r.id}/record`))),r);
    }
    assert.equal(store.getScaffold(700),'original');
    assert.equal(store.getScaffoldBySequentialId(1),'original');
    assert.throws(()=>store.getScaffold(1),ResourceNotFoundError);
    assert.throws(()=>store.getScaffoldBySequentialId(700),ResourceNotFoundError);
    for(let i=0;i<3;i++){
      const list=store.listScaffolds(false,5);
      assert.equal(list.total,3);
      assert.deepEqual(new Set(list.scaffolds.map(r=>r.id)),new Set([700,rows[0]!.id]));
      assert.equal(list.scaffolds.find(r=>r.id===rows[0]!.id)?.sequential_id,2);
      assert.equal(list.scaffolds.find(r=>r.id===rows[0]!.id)?.preview,'A let');
    }
    assert.equal(store.listScaffolds(true).scaffolds.length,3);
    assert.deepEqual(store.listReferences().references.map(r=>r.id),[rows[2]!.id]);
    assert.match(toolText(store,'list_references',{}),/External reference metadata only/);
    for (const nsfw of [false, true]) {
      const lines=toolText(store,'list_references',{nsfw}).split('\n');
      assert.deepEqual(lines[1]!.split('\t'), ['sequential_id','author','title','url', ...(nsfw ? ['nsfw'] : [])]);
      assert.equal(lines[2]!.split('\t')[0], String(rows[2]!.sequential_id));
      assert.ok(!lines.slice(1).some(line=>line.includes(rows[2]!.id)));
    }
    assert.deepEqual(JSON.parse(textOf(store.read('copypasta://posts/700/record'))),legacyRow);
  }
});

test('NSFW reference discovery is filtered while direct retrieval preserves the record',()=>{
  const r=entry(2,{content_kind:'reference',source:'wikisource',nsfw:true});
  const library=new Library(original(),bytes([r]));
  assert.equal(library.listReferences().references.length,0);
  assert.equal(library.listReferences().total,1);
  assert.equal(library.listReferences(true).references.length,1);
  assert.equal(library.getScaffold(r.id),r.text);
});

test('invalid imported identities, collisions and text hashes fail rather than serving a partial library',()=>{
  const first=entry(2);
  for(const rows of [[first,first],[first,{...entry(3),sequential_id:2}],[entry(1)],
    [{...first,id:'not-a-uuid'}],[{...first,text:'changed'}],[{...first,nsfw:undefined}]]){
    assert.throws(()=>new Library(original(),bytes(rows as ImportedRecord[])));
  }
});

test('native resources cover all providers, preserve order, and reject stale cursors',()=>{
  const rows=Array.from({length:210},(_,i)=>entry(i+2));
  const library=new Library(original(),bytes(rows));
  const page=library.list(); const next=page.nextCursor!;
  assert.ok(next);
  assert.equal(page.resources[0]!.uri,'copypasta://posts/700');
  assert.equal(page.resources.length+library.list(next).resources.length,211);
  assert.equal(new Set([...page.resources,...library.list(next).resources].map(r=>r.uri)).size,211);
  assert.throws(()=>library.list('invalid'));
  const changed=new Library(original(),bytes([...rows,entry(212)]));
  assert.throws(()=>changed.list(next));
  assert.throws(()=>library.read('file:///etc/passwd'),ResourceNotFoundError);
  assert.throws(()=>library.read(`scaffold://entries/${randomUUID()}`),ResourceNotFoundError);
});

test('McSweeney’s entries are disabled across discovery and direct reads',()=>{
  const r=entry(2,{source:'mcsweeneys',content_kind:'reference'});
  const library=new Library(original(),bytes([r]));
  assert.equal(library.listReferences(true).total,0);
  assert.equal(library.list().resources.length,1);
  assert.throws(()=>library.getScaffold(r.id),ResourceNotFoundError);
  assert.throws(()=>library.getScaffoldBySequentialId(r.sequential_id),ResourceNotFoundError);
  assert.throws(()=>library.read(`scaffold://entries/${r.id}`),ResourceNotFoundError);
});
