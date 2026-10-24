import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {canonicalJson,makePublicationManifest,sha256} from '../server/publication-model.mjs';
import {stagePublication,placePublication} from '../server/publication-files.mjs';
import {validatePublicationLocator,verifyReaderPublication} from '../server/reader-publication.mjs';

const text='😀 Начало. Один якорь. Дальше.';
function fixture(){
 const book={title:'Локатор тестовой публикации',author:'Тест',language:'ru',assets:{},chapters:[{title:'Первая',blocks:[{type:'text',text},{type:'text',text:'echo echo'}]},{title:'Вторая',blocks:[{type:'text',text:'Другой текст'}]}],structure:{schemaVersion:2,warnings:[],chapters:[{id:'first',revision:1,title:'Первая',blocks:[{id:'p1',type:'paragraph',text},{id:'repeat',type:'paragraph',text:'echo echo'}]},{id:'second',revision:1,title:'Вторая',blocks:[{id:'p2',type:'paragraph',text:'Другой текст'}]}]}};
 const row={id:randomUUID(),work_id:randomUUID(),expression_id:randomUUID(),edition_id:randomUUID(),chapter_count:2,security_state:'passed',serving_paused:false};
 row.publication_manifest=makePublicationManifest(row,book);row.publication_sha256=sha256(Buffer.from(canonicalJson(row.publication_manifest)));
 const locator={publicationId:row.id,publicationRevision:1,chapterId:'first',blockId:'p1'};
 return {book,row,locator};
}
const checked=(changes={})=>{const {book,row,locator}=fixture();return validatePublicationLocator(book,row,{...locator,...changes});};

test('canonical chapter and block anchors preserve their immutable identity',()=>{
 const {book,row,locator}=fixture();assert.deepEqual(validatePublicationLocator(book,row,locator),locator);
 const chapter={publicationId:row.id,publicationRevision:1,chapterId:'second'};assert.deepEqual(validatePublicationLocator(book,row,chapter),chapter);
});
test('UTF-16 offsets accept the start and end of the real block',()=>{
 assert.equal(checked({offset:0}).offset,0);assert.equal(checked({offset:text.length}).offset,text.length);assert.equal(checked({offset:2}).offset,2);
});
test('an offset cannot split a surrogate pair or exceed actual text',()=>{
 for(const offset of [1,text.length+1,-1,0.5,NaN,Infinity])assert.throws(()=>checked({offset}));
});
test('chapter progression remains independent of block offset',()=>{
 const result=checked({progression:1,offset:0});assert.equal(result.offset,0);assert.equal(result.progression,1);
 const noOffset=checked({progression:0.37});assert.equal(noOffset.offset,undefined);assert.equal(noOffset.progression,0.37);
});
test('unknown chapter IDs, cross-chapter block IDs and URLs are not anchors',()=>{
 for(const change of [{chapterId:'missing'},{blockId:'p2'},{chapterId:'https://evil.test/'},{blockId:'../../p1'}])assert.throws(()=>checked(change));
});
test('a canonical locator is rejected for another publication or revision',()=>{
 assert.throws(()=>checked({publicationId:randomUUID()}),{code:'READER_LOCATOR'});assert.throws(()=>checked({publicationRevision:2}));
});
test('exact quote and surrounding context match the real offset',()=>{
 const exact='Один якорь',offset=text.indexOf(exact),quote={exact,prefix:'Начало. ',suffix:'. Дальше.'};
 assert.deepEqual(checked({offset,quote}).quote,quote);
});
test('a quote cannot point at different text or past the end of a block',()=>{
 for(const change of [{offset:0,quote:{exact:'Один якорь'}},{offset:text.length,quote:{exact:'Один якорь'}},{quote:{exact:'Несуществующий текст'}}])assert.throws(()=>checked(change),{code:'READER_LOCATOR'});
});
test('without an explicit offset only a unique exact quote is accepted',()=>{
 const result=checked({quote:{exact:'Один якорь'}});assert.equal(result.offset,undefined);assert.equal(result.quote.exact,'Один якорь');
 assert.throws(()=>checked({blockId:'repeat',quote:{exact:'echo'}}),{code:'READER_LOCATOR'});
 // A context hint does not silently replace an explicit offset for repetition.
 assert.throws(()=>checked({blockId:'repeat',quote:{exact:'echo',prefix:'echo '}}),{code:'READER_LOCATOR'});
});
test('an explicit offset disambiguates repeated exact text with its proper context',()=>{
 const result=checked({blockId:'repeat',offset:5,quote:{exact:'echo',prefix:'echo ',suffix:''}});assert.equal(result.offset,5);
 assert.throws(()=>checked({blockId:'repeat',offset:0,quote:{exact:'echo',prefix:'echo '}}),{code:'READER_LOCATOR'});
});
test('overlapping occurrences are ambiguous without an offset',()=>{
 const {book,row,locator}=fixture();book.structure.chapters[0].blocks[0].text='aaaa';row.publication_manifest=makePublicationManifest(row,book);row.publication_sha256=sha256(Buffer.from(canonicalJson(row.publication_manifest)));
 assert.throws(()=>validatePublicationLocator(book,row,{...locator,quote:{exact:'aaa'}}),{code:'READER_LOCATOR'});
});
test('prefix and suffix are immediate context rather than arbitrary substrings',()=>{
 const offset=text.indexOf('Один якорь');
 for(const quote of [{exact:'Один якорь',prefix:'Начало'},{exact:'Один якорь',suffix:'Дальше'},{exact:'Один якорь',prefix:'x'.repeat(200)},{exact:'Один якорь',suffix:'. Дальше. лишнее'}])assert.throws(()=>checked({offset,quote}),{code:'READER_LOCATOR'});
});
test('Unicode quotes and empty context boundaries remain well formed',()=>{
 assert.equal(checked({offset:0,quote:{exact:'😀',prefix:'',suffix:' Начало.'}}).quote.exact,'😀');
 assert.throws(()=>checked({offset:1,quote:{exact:'😀'}}),{code:'READER_LOCATOR'});
});
test('legacy positions validate only the real chapter index and ratio',()=>{
 const {book,row}=fixture();for(const position of [0,0.37,1])assert.deepEqual(validatePublicationLocator(book,row,{type:'legacy',chapter:1,position}),{type:'legacy',chapter:1,position});
 for(const value of [{type:'legacy',chapter:2,position:0},{type:'legacy',chapter:-1,position:0},{type:'legacy',chapter:0,position:1.01}])assert.throws(()=>validatePublicationLocator(book,row,value));
});
test('the structured locator also supports immutable projections of old packages',()=>{
 const {book,row}=fixture();delete book.structure;row.publication_manifest=makePublicationManifest(row,book);row.publication_sha256=sha256(Buffer.from(canonicalJson(row.publication_manifest)));
 const result=validatePublicationLocator(book,row,{publicationId:row.id,publicationRevision:1,chapterId:'c-1',blockId:'c-1-b-0',offset:0});assert.equal(result.chapterId,'c-1');
});
test('a changed stored structure or manifest hash is an integrity failure',()=>{
 const {book,row,locator}=fixture();book.structure.chapters[0].blocks[0].text='Подменённый текст';assert.throws(()=>validatePublicationLocator(book,row,locator),{code:'PUBLICATION_STRUCTURE'});
 const fresh=fixture();fresh.row.publication_sha256='0'.repeat(64);assert.throws(()=>validatePublicationLocator(fresh.book,fresh.row,fresh.locator),{code:'PUBLICATION_STRUCTURE'});
});
test('an inconsistent stored chapter count fails closed',()=>{
 const {book,row,locator}=fixture();row.chapter_count=3;assert.throws(()=>validatePublicationLocator(book,row,locator),{code:'READER_PUBLICATION_INTEGRITY'});
});

async function temporary(operation){
 const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'gargantua-reader-locator-')),previous=process.env.LIBRARY_DIR;
 process.env.LIBRARY_DIR=root;
 try{return await operation(root);}finally{
  if(previous===undefined)delete process.env.LIBRARY_DIR;else process.env.LIBRARY_DIR=previous;
  assert.ok(path.resolve(root).startsWith(parent+path.sep));assert.match(path.basename(root),/^gargantua-reader-locator-[A-Za-z0-9]+$/);await fs.rm(root,{recursive:true,force:true});
 }
}
async function persisted(root){
 const {book,row,locator}=fixture(),prepared=await stagePublication(root,randomUUID(),row.id,book);await placePublication(root,prepared);
 Object.assign(row,{artifact_manifest:prepared.manifest,content_sha256:prepared.contentSha256,content_bytes:prepared.contentBytes,package_sha256:prepared.packageSha256,expression_kind:'original'});return {book,row,locator};
}
function database(row,{paused=false,missing=false,origins=[],source=null,parts=[]}={}){
 const calls=[],client={query:async(sql,args=[])=>{
  calls.push({sql,args});let rows;
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))rows=[];
  else if(sql.includes('CROSS JOIN settings'))rows=missing?[]:[{...row,serving_paused:paused}];
  else if(sql.includes('SELECT serving_paused FROM settings'))rows=[{serving_paused:paused}];
  else if(sql.includes('e.kind AS expression_kind'))rows=missing?[]:[row];
  else if(sql.includes('FROM derived_results'))rows=origins;
  else if(sql.includes('FROM derived_sources'))rows=source?[source]:[];
  else if(sql.includes('FROM derived_source_parts'))rows=parts;
  else if(sql.includes('SELECT kind FROM expressions'))rows=[{kind:'original'}];
  else throw Error('Unexpected fixture query: '+sql);
  return {rows,rowCount:rows.length};
 },release(){calls.push({sql:'RELEASE'});}};
 const pool={query:client.query,connect:async()=>{calls.push({sql:'CONNECT'});return client;}};return {pool,client,calls};
}
test('verification reads actual staged immutable files and checks their manifests',()=>temporary(async root=>{
 const {row,locator}=await persisted(root),{pool}=database(row);assert.deepEqual(await verifyReaderPublication(pool,row.id,locator),locator);
}));
test('a caller transaction is reused for all safety and source queries',()=>temporary(async root=>{
 const {row,locator}=await persisted(root),{client,calls}=database(row),pool={connect:()=>{throw Error('must not open a separate transaction');},query:()=>{throw Error('must use the caller client');}};
 await verifyReaderPublication(pool,row.id,locator,{client});assert.ok(calls.some(call=>call.sql.includes('e.kind AS expression_kind')));assert.ok(calls.every(call=>!['BEGIN','COMMIT','ROLLBACK','CONNECT','RELEASE'].includes(call.sql)));
}));
test('missing and blocked publications fail before reading files',async()=>{
 const {row,locator}=fixture();row.artifact_manifest={};
 await assert.rejects(()=>verifyReaderPublication(database(row,{missing:true}).pool,row.id,locator),{code:'READER_PUBLICATION',status:404});
 row.security_state='blocked';await assert.rejects(()=>verifyReaderPublication(database(row).pool,row.id,locator),{code:'READER_PUBLICATION_BLOCKED',status:423});
});
test('emergency serving pause blocks locator writes',async()=>{
 const {row,locator}=fixture();await assert.rejects(()=>verifyReaderPublication(database(row,{paused:true}).pool,row.id,locator),{code:'READER_PUBLICATION_BLOCKED',status:423});
});
test('corrupted file bytes are refused without leaking a local path',()=>temporary(async root=>{
 const {row,locator}=await persisted(root),{pool}=database(row),file=path.join(root,'books',row.id,'book.json');await fs.appendFile(file,' ');
 await assert.rejects(()=>verifyReaderPublication(pool,row.id,locator),error=>{assert.equal(error.code,'READER_PUBLICATION_INTEGRITY');assert.equal(error.status,423);assert.ok(!error.message.includes(root));return true;});
}));
test('a missing file and a mismatched immutable projection both fail closed',()=>temporary(async root=>{
 const first=await persisted(root);await fs.unlink(path.join(root,'books',first.row.id,'book.json'));await assert.rejects(()=>verifyReaderPublication(database(first.row).pool,first.row.id,first.locator),{code:'READER_PUBLICATION_INTEGRITY'});
 const second=await persisted(root);second.row.publication_sha256='0'.repeat(64);await assert.rejects(()=>verifyReaderPublication(database(second.row).pool,second.row.id,second.locator),{code:'READER_PUBLICATION_INTEGRITY'});
}));
test('a translation without a unique accepted origin cannot acquire new annotations',()=>temporary(async root=>{
 const {row,locator}=await persisted(root);row.expression_kind='machine-translation';
 await assert.rejects(()=>verifyReaderPublication(database(row).pool,row.id,locator),{code:'DERIVED_SOURCE_BLOCKED',status:423});
 const origin={source_sha256:'a'.repeat(64),manifest:{publicationIds:[row.id]}};await assert.rejects(()=>verifyReaderPublication(database(row,{origins:[origin,origin]}).pool,row.id,locator),{code:'DERIVED_SOURCE_BLOCKED'});
}));
test('an otherwise ready translation remains blocked by its original source',()=>temporary(async root=>{
 const {row,locator}=await persisted(root);row.expression_kind='machine-translation';const sourceId=randomUUID(),source={sha256:'a'.repeat(64),work_id:row.work_id,expression_id:randomUUID(),manifest:{parts:[{publicationId:sourceId}]}};
 const part={...row,id:sourceId,ordinal:0,expression_id:source.expression_id,security_state:'blocked',pinned_publication_sha256:row.publication_sha256,pinned_package_sha256:row.package_sha256};
 const origin={source_sha256:source.sha256,manifest:{publicationIds:[row.id]}};
 await assert.rejects(()=>verifyReaderPublication(database(row,{origins:[origin],source,parts:[part]}).pool,row.id,locator),{code:'DERIVED_SOURCE_BLOCKED',status:423});
}));
test('wrong revision or publication is rejected before any database call',async()=>{
 const {row,locator}=fixture(),pool={query:()=>{throw Error('unexpected query');}};
 await assert.rejects(()=>verifyReaderPublication(pool,row.id,locator,{publicationRevision:2}),{code:'READER_LOCATOR'});
 await assert.rejects(()=>verifyReaderPublication(pool,row.id,{...locator,publicationId:randomUUID()}),{code:'READER_LOCATOR'});
});
