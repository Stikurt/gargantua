import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {CATALOG_ENTITY_ID,normalizeReaderMutation,normalizeReaderPayload,validateReaderLocator,validateReaderEntity,canonicalReaderJson,readerMutationIdV2} from '../server/reader-data-model.mjs';
import {readerCursor,parseReaderCursor} from '../server/reader-data.mjs';
const book=randomUUID(),device=randomUUID(),catalog=randomUUID();
const locator=(extra={})=>({publicationId:book,publicationRevision:1,chapterId:'chapter-1',blockId:'paragraph-1',offset:0,quote:{exact:'Текст',prefix:'',suffix:''},progression:0,...extra});
const payload=(extra={})=>({publicationId:book,publicationRevision:1,locator:locator(),...extra});
const mutation=(extra={})=>({mutationId:randomUUID(),deviceId:device,counter:1,entityType:'reading',entityId:book,baseRevision:0,operation:'upsert',payload:payload(),...extra});

test('v2 mutation IDs bind the normalized profile device and safe counter',()=>{
 const profile='00000000-0000-4000-8000-000000000001',deviceId='00000000-0000-4000-8000-000000000002';
 const one=readerMutationIdV2(profile,deviceId,1);assert.match(one,/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 assert.equal(readerMutationIdV2(profile.toUpperCase(),deviceId.toUpperCase(),1),one);
 for(const other of [readerMutationIdV2(profile,deviceId,2),readerMutationIdV2(deviceId,deviceId,1),readerMutationIdV2(profile,profile,1)])assert.notEqual(other,one);
 assert.throws(()=>readerMutationIdV2(profile,deviceId,Number.MAX_SAFE_INTEGER+1),{code:'READER_VALIDATION'});
 const legacy=normalizeReaderMutation(mutation()),modern=normalizeReaderMutation(mutation({protocolVersion:2}));assert.equal('protocolVersion' in legacy,false);assert.equal(modern.protocolVersion,2);
 for(const protocolVersion of [1,3,'2',null])assert.throws(()=>normalizeReaderMutation(mutation({protocolVersion})),{code:'READER_VALIDATION'});
});

test('documented locator fixture passes strict syntax without changing its anchor',async()=>{
 const example=JSON.parse(await readFile(new URL('../docs/gargantua/examples/locator-v2.json',import.meta.url),'utf8'));
 assert.deepEqual(validateReaderLocator(example),example);
 assert.equal(validateReaderLocator({publicationId:book,publicationRevision:1,chapterId:'chapter-1'}).chapterId,'chapter-1');
});
test('reader mutation normalizes UUIDs/defaults without mutating client input',()=>{
 const input=mutation({entityId:book.toUpperCase(),payload:payload({publicationId:book.toUpperCase()})}),original=JSON.stringify(input),normalized=normalizeReaderMutation(input);
 assert.equal(normalized.entityId,book);assert.equal(normalized.payload.shelf,'reading');assert.equal(JSON.stringify(input),original);
 assert.equal(normalizeReaderPayload('bookmark',payload()).note,'');
});
test('canonical and explicit legacy locators are separate contracts',()=>{
 assert.deepEqual(validateReaderLocator({type:'legacy',chapter:2,position:.25}),{type:'legacy',chapter:2,position:.25});
 for(const value of [{chapter:0,position:0},{type:'legacy',chapter:0,position:0,blockId:'fake'},{type:'legacy',chapter:20000,position:0},{type:'legacy',chapter:0,position:NaN},{type:'legacy',chapter:0,position:1.01}])assert.throws(()=>validateReaderLocator(value),{code:'READER_VALIDATION'});
});
test('locator forbids unbound offsets, foreign revisions and arbitrary fields',()=>{
 for(const value of [locator({publicationRevision:2}),locator({offset:1.5}),locator({offset:-1}),locator({offset:100001}),locator({chapterId:'../chapter'}),locator({blockId:'https://host/path'}),locator({href:'file:///private'}),locator({progression:Infinity}),{publicationId:book,publicationRevision:1,chapterId:'c',offset:0}])assert.throws(()=>validateReaderLocator(value),{code:'READER_VALIDATION'});
});
test('quotes have bounded exact text and reject unsupported or invisible fields',()=>{
 for(const quote of [{exact:''},{exact:'x'.repeat(1001)},{exact:'text',prefix:'x'.repeat(201)},{exact:'text',suffix:'\u202e'},{exact:'text',html:'<script>'}])assert.throws(()=>validateReaderLocator(locator({quote})),{code:'READER_VALIDATION'});
 assert.equal(validateReaderLocator(locator({quote:{exact:'First\nsecond'}})).quote.exact,'First\nsecond');
});
test('payload binds canonical locator to its publication and fixed reading key',()=>{
 assert.throws(()=>normalizeReaderPayload('bookmark',payload({publicationId:randomUUID()})),{code:'READER_VALIDATION'});
 assert.throws(()=>normalizeReaderMutation(mutation({entityId:randomUUID()})),{code:'READER_VALIDATION'});
 assert.throws(()=>normalizeReaderPayload('reading',payload({shelf:'administrator'})),{code:'READER_VALIDATION'});
});
test('notes remain inert text, support multiline and reject malformed/control strings',()=>{
 const note='<script>alert("text only")</script>\nsecond';assert.equal(normalizeReaderPayload('bookmark',payload({note})).note,note);
 for(const note of ['x'.repeat(501),'\uD800','line\u0000break','\u200bhidden'])assert.throws(()=>normalizeReaderPayload('bookmark',payload({note})),{code:'READER_VALIDATION'});
 assert.throws(()=>normalizeReaderPayload('reading',payload({note:'not reading payload'})),{code:'READER_VALIDATION'});
});
test('deletion takes an ID/base revision, never a replacement payload',()=>{
 const deletion=normalizeReaderMutation(mutation({operation:'delete',payload:undefined}));assert.equal(deletion.operation,'delete');assert.ok(!Object.hasOwn(deletion,'payload'));
 assert.throws(()=>normalizeReaderMutation(mutation({operation:'delete',payload:null})),{code:'READER_VALIDATION'});
 for(const extra of [{baseRevision:-1},{baseRevision:2147483647},{counter:0},{counter:1.1},{counter:Number.MAX_SAFE_INTEGER+1},{deviceId:'fake'},{profileId:randomUUID()},{role:'owner'}])assert.throws(()=>normalizeReaderMutation(mutation(extra)),{code:'READER_VALIDATION'});
});
test('catalog aggregate preserves local metadata without accepting file bytes',()=>{
 const value={catalogs:[{id:catalog,title:'  Серия  ',parent:null,items:[{id:book,scope:'device',title:'Book',author:'Writer'}]}]},normalized=normalizeReaderPayload('catalog',value);
 assert.equal(normalized.catalogs[0].title,'Серия');assert.equal(normalized.catalogs[0].items[0].scope,'device');
 assert.throws(()=>normalizeReaderMutation(mutation({entityType:'catalog',entityId:randomUUID(),payload:value})),{code:'READER_VALIDATION'});
 const file=structuredClone(value);file.catalogs[0].items[0].content='raw book';assert.throws(()=>normalizeReaderPayload('catalog',file),{code:'READER_VALIDATION'});
 assert.equal(normalizeReaderMutation(mutation({entityType:'catalog',entityId:CATALOG_ENTITY_ID,payload:value})).entityId,CATALOG_ENTITY_ID);
});
test('catalog cycles, missing parents, duplicate items and total quota are refused',()=>{
 const root={id:catalog,title:'Series',parent:null,items:[]};
 for(const catalogs of [[{...root,parent:catalog}],[{...root,parent:randomUUID()}],[root,root],[{...root,items:[{id:book,scope:'server',title:'Book',author:''},{id:book,scope:'server',title:'Book',author:''}]}],Array.from({length:101},()=>({...root,id:randomUUID()}))])assert.throws(()=>normalizeReaderPayload('catalog',{catalogs}),{code:'READER_VALIDATION'});
 const chain=Array.from({length:9},(_,index)=>({id:randomUUID(),title:String(index),items:[],parent:null}));chain.forEach((item,index)=>{if(index)item.parent=chain[index-1].id;});assert.throws(()=>normalizeReaderPayload('catalog',{catalogs:chain}),{code:'READER_VALIDATION'});
});
test('catalog byte limit is measured in UTF8 rather than character count',()=>{
 const catalogs=Array.from({length:90},()=>({id:randomUUID(),title:'Я'.repeat(120),parent:null,items:[]}));
 assert.throws(()=>normalizeReaderPayload('catalog',{catalogs}),{code:'READER_PAYLOAD_LIMIT'});
});
test('entity records allow explicit tombstones and require valid live payloads',()=>{
 const entity={entityType:'bookmark',entityId:randomUUID(),revision:1,deleted:true,payload:null};assert.deepEqual(validateReaderEntity(entity),entity);
 assert.throws(()=>validateReaderEntity({...entity,deleted:false}),{code:'READER_VALIDATION'});
 assert.throws(()=>validateReaderEntity({...entity,revision:0}),{code:'READER_VALIDATION'});
 assert.throws(()=>validateReaderEntity({...entity,password:'secret'}),{code:'READER_VALIDATION'});
 assert.throws(()=>validateReaderEntity({...entity,entityType:'catalog',entityId:CATALOG_ENTITY_ID,revision:0}),{code:'READER_VALIDATION'});
 assert.equal(validateReaderEntity({...entity,payload:payload(),updatedAt:'2026-10-23T12:00:00.000Z'}).payload.note,'');
});
test('profile bound cursors reject another profile, noncanonical/base64 and future schema',()=>{
 const profile=randomUUID(),cursor=readerCursor(profile,15);assert.equal(parseReaderCursor(profile,cursor),15);
 for(const value of [cursor+'=',Buffer.from(JSON.stringify({schemaVersion:2,profileId:profile,revision:15})).toString('base64url'),'bad!','x'.repeat(201)])assert.throws(()=>parseReaderCursor(profile,value),{code:'READER_CURSOR'});
 assert.throws(()=>parseReaderCursor(randomUUID(),cursor),{code:'READER_CURSOR'});
});
test('canonical serialization is stable for semantically identical normalized operations',()=>{
 const value=normalizeReaderMutation(mutation()),reordered=Object.fromEntries(Object.entries(value).reverse());assert.equal(canonicalReaderJson(value),canonicalReaderJson(reordered));
});
