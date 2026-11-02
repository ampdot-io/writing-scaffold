import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Corpus} from '../src/corpus.js';
import {Library} from '../src/library.js';
import {loadBundledLibrary,OPTIONAL_COLLECTION_PATHS} from '../src/bundled-library.js';
import {callLocalScaffoldTool as callScaffoldTool} from '../src/scaffold-tools.js';
import {PRUNED_CORPUS_SHA256,PRUNED_SCAFFOLD_IDS} from '../src/pruned-scaffolds.js';
import {parseCatalog} from './content.js';

test('approved pruning invalidates old discovery cursors and paginates every retained scaffold exactly once',async()=>{
 const corpus=await Corpus.load(fileURLToPath(new URL('../artifacts/copypastatext/copypastas.jsonl',import.meta.url)));
 assert.equal(corpus.fingerprint,PRUNED_CORPUS_SHA256);
 const store=await loadBundledLibrary(corpus);
 const sources=await Promise.all(['../artifacts/library/imports.jsonl',...OPTIONAL_COLLECTION_PATHS]
  .map(async path=>{try{return await readFile(new URL(path,import.meta.url));}
   catch(error){if(path!=='../artifacts/library/imports.jsonl'&&(error as NodeJS.ErrnoException).code==='ENOENT')return Buffer.alloc(0);throw error;}}));
 const activeImports=sources.flatMap(bytes=>bytes.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line) as {source:string;content_kind:string;discoverable?:boolean}))
  .filter(r=>r.source!=='mcsweeneys'&&r.content_kind!=='reference'&&r.discoverable!==false);
 const expectedTotal=corpus.size-PRUNED_SCAFFOLD_IDS.size+activeImports.length;
 const oldFingerprint=createHash('sha256').update(corpus.fingerprint)
  .update(Buffer.concat(sources.flatMap(bytes=>[bytes,Buffer.from('\n')]))).digest('hex');
 assert.notEqual(store.fingerprint,oldFingerprint);
 const oldResourceCursor=Buffer.from(JSON.stringify({v:1,library:oldFingerprint,offset:201})).toString('base64url');
 assert.throws(()=>store.list(oldResourceCursor),/Invalid or stale/);
 const oldToolCursor=Buffer.from(JSON.stringify({v:2,store:oldFingerprint.slice(0,16),nsfw:true,seed:1,offset:1,eligible:7905})).toString('base64url');
 assert.throws(()=>callScaffoldTool('list_scaffolds',{cursor:oldToolCursor},store),/Invalid or stale/);
 const legacyIds=corpus.listScaffolds(true,1).scaffolds.map(r=>r.id).sort((a,b)=>a-b);
 const ids=new Set<number>();
 let cursor:string|undefined;
 do {
  const result=callScaffoldTool('list_scaffolds',{nsfw:true,preview_length:1,limit:173,...(cursor?{cursor}:{})},store);
  const block=result.content[0]!;
  assert.ok(block.type==='text');
  const page=parseCatalog(block.text);
  assert.equal(page.total,expectedTotal);
  assert.equal(page.eligible,expectedTotal);
  for(const entry of page.scaffolds){
   assert.ok(!ids.has(entry.sequential_id),'no duplicates across pages');
   if(entry.source==='copypastatext')assert.ok(!PRUNED_SCAFFOLD_IDS.has(legacyIds[entry.sequential_id-1]!));
   ids.add(entry.sequential_id);
  }
  cursor=page.nextCursor;
 }while(cursor);
 assert.equal(ids.size,expectedTotal);
 assert.deepEqual(ids,new Set(store.listScaffolds(true).scaffolds.map(r=>r.sequential_id)));
 // Standalone Corpus remains a complete source archive, rather than silently losing data.
 assert.equal(corpus.listScaffolds(true).scaffolds.length,6466);
});

test('unreviewed custom corpora do not inherit pruning from colliding numeric IDs',()=>{
 const id=[...PRUNED_SCAFFOLD_IDS][0]!;
 const row={id,type:'post',title:'A custom writing example',url:'https://example.test/custom',text:'A useful custom sentence.',nsfw:false,copy_blocks:[]};
 const corpus=new Corpus(Buffer.from(JSON.stringify(row)));
 const store=new Library(corpus,Buffer.alloc(0));
 assert.notEqual(corpus.fingerprint,PRUNED_CORPUS_SHA256);
 assert.equal(store.listScaffolds().scaffolds[0]!.id,id);
 assert.equal(store.list().resources[0]!.uri,`copypasta://posts/${id}`);
 assert.equal(store.getScaffoldBySequentialId(1),row.text);
});
