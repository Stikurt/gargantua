import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {CATALOG_ENTITY_ID,canonicalReaderJson} from '../server/reader-data-model.mjs';
import {createReaderExport,serializeReaderExport,parseReaderExport,MAX_READER_EXPORT_BYTES,MAX_READER_EXPORT_ENTITIES} from '../server/reader-export.mjs';

const createdAt='2026-10-23T12:00:00.000Z',publicationId=randomUUID(),bookmarkId=randomUUID();
const locator={publicationId,publicationRevision:1,chapterId:'first',blockId:'p1',offset:0,quote:{exact:'Проверочный текст',prefix:'',suffix:' для контракта.'},progression:0};
const reading=()=>({entityType:'reading',entityId:publicationId,revision:7,deleted:false,payload:{publicationId,publicationRevision:1,locator,shelf:'reading'},updatedAt:createdAt});
const bookmark=()=>({entityType:'bookmark',entityId:bookmarkId,revision:3,deleted:false,payload:{publicationId,publicationRevision:1,locator,note:'Научная фантастика\nПродолжить здесь.'},updatedAt:createdAt});
const catalog=()=>({entityType:'catalog',entityId:CATALOG_ENTITY_ID,revision:4,deleted:false,payload:{catalogs:[{id:randomUUID(),title:'Первый цикл',parent:null,items:[{id:publicationId,scope:'server',title:'Книга',author:'Автор'},{id:randomUUID(),scope:'device',title:'Локальная книга',author:''}]}]},updatedAt:createdAt});
const bytes=envelope=>Buffer.from(JSON.stringify(envelope));
const rehash=envelope=>{envelope.sha256=createHash('sha256').update(canonicalReaderJson(envelope.payload)).digest('hex');return bytes(envelope);};
const mutate=(change,{hash=true}={})=>{const envelope=createReaderExport([reading()],{createdAt});change(envelope);return hash?rehash(envelope):bytes(envelope);};

test('portable roundtrip preserves positions, notes, nested catalog membership and revisions',()=>{
 const records=[reading(),bookmark(),catalog()],exported=createReaderExport(records,{createdAt}),parsed=parseReaderExport(serializeReaderExport(records,{createdAt}));
 assert.deepEqual(parsed.entities,exported.payload.entities);assert.equal(parsed.createdAt,createdAt);assert.equal(parsed.sha256,exported.sha256);
 assert.equal(parsed.entities.find(row=>row.entityType==='reading').revision,7);assert.equal(parsed.entities.find(row=>row.entityType==='bookmark').payload.note,bookmark().payload.note);
 assert.equal(parsed.entities.find(row=>row.entityType==='catalog').payload.catalogs[0].items[1].scope,'device');
});
test('documented canonical locator roundtrips without claiming Readium conformance',async()=>{
 const documented=JSON.parse(await readFile(new URL('../docs/gargantua/examples/locator-v2.json',import.meta.url),'utf8'));
 const record={...reading(),entityId:documented.publicationId,payload:{...reading().payload,publicationId:documented.publicationId,locator:documented}};
 assert.deepEqual(parseReaderExport(serializeReaderExport([record],{createdAt})).entities[0].payload.locator,documented);
});
test('explicit legacy chapter and ratio are preserved without invented block offsets',()=>{
 const row=reading();row.payload.locator={type:'legacy',chapter:3,position:0.37};
 const imported=parseReaderExport(serializeReaderExport([row],{createdAt})).entities[0];assert.deepEqual(imported.payload.locator,row.payload.locator);assert.equal(imported.payload.locator.blockId,undefined);
});
test('deletions roundtrip as tombstones and do not carry old private notes',()=>{
 const row={...bookmark(),deleted:true},exported=createReaderExport([row],{createdAt});
 assert.equal(exported.payload.entities[0].payload,null);assert.equal(parseReaderExport(bytes(exported)).entities[0].deleted,true);assert.ok(!JSON.stringify(exported).includes('Научная'));
});
test('export deliberately projects public fields and excludes store identity and secrets',()=>{
 const row={...reading(),profileId:randomUUID(),deviceId:randomUUID(),password:'secret',cookie:'session-cookie',role:'owner',path:'C:/private/books'};
 const output=serializeReaderExport([row],{createdAt}).toString('utf8');
 for(const field of ['profileId','deviceId','password','cookie','role','path','secret','session-cookie','C:/private/books'])assert.ok(!output.includes(field));
});
test('same metadata produces deterministic bytes regardless of input record/property order',()=>{
 const a=reading(),b=bookmark(),reversed=Object.fromEntries(Object.entries(a).reverse());
 assert.deepEqual(serializeReaderExport([a,b],{createdAt}),serializeReaderExport([b,reversed],{createdAt}));
});
test('empty metadata export is valid and does not imply deleting destination records',()=>{
 const result=parseReaderExport(serializeReaderExport([],{createdAt}));assert.deepEqual(result.entities,[]);
 assert.deepEqual(Object.keys(result).sort(),['createdAt','entities','sha256']);assert.equal(result.mutations,undefined);assert.equal(result.replace,undefined);
});
test('text and Uint8Array inputs are supported with the same checksum',()=>{
 const data=serializeReaderExport([reading()],{createdAt});assert.deepEqual(parseReaderExport(data.toString('utf8')),parseReaderExport(new Uint8Array(data)));
 for(const value of [null,{},123,[],new ArrayBuffer(5)])assert.throws(()=>parseReaderExport(value),{code:'READER_EXPORT_INVALID'});
});
test('metadata integrity is checked rather than trusted from the file',()=>{
 assert.throws(()=>parseReaderExport(mutate(value=>{value.payload.entities[0].payload.shelf='finished';},{hash:false})),/сумма/);
 assert.throws(()=>parseReaderExport(mutate(value=>{value.sha256='0'.repeat(64);},{hash:false})),/сумма/);
});
test('JSON indentation or object property order does not change canonical payload integrity',()=>{
 const envelope=createReaderExport([reading()],{createdAt});envelope.payload.entities[0]=Object.fromEntries(Object.entries(envelope.payload.entities[0]).reverse());
 assert.equal(parseReaderExport(JSON.stringify(envelope,null,2)).sha256,envelope.sha256);
});
test('unknown format, version, fields and malformed hash are rejected',()=>{
 for(const change of [value=>{value.format='other';},value=>{value.version=2;},value=>{value.profileId=randomUUID();},value=>{value.payload.files=[];},value=>{value.sha256='A'.repeat(64);},value=>{value.sha256=['a'.repeat(64)];},value=>{value.sha256=null;}])assert.throws(()=>parseReaderExport(mutate(change,{hash:false})),{code:'READER_EXPORT_INVALID'});
});
test('timestamp must identify an actual UTC calendar instant',()=>{
 for(const value of ['2026-02-30T12:00:00.000Z','2026-10-23','2026-10-23T12:00:00+05:00','yesterday',null]){
  assert.throws(()=>createReaderExport([],{createdAt:value}),{code:'READER_EXPORT_INVALID'});
  assert.throws(()=>parseReaderExport(mutate(envelope=>{envelope.createdAt=value;})),{code:'READER_EXPORT_INVALID'});
 }
});
test('invalid UTF-8, BOM, truncated JSON and non-JSON input never enter the data model',()=>{
 for(const value of [Buffer.from([0xff,0xfe]),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),serializeReaderExport([],{createdAt})]),'{','<html>error</html>','null','[]'])assert.throws(()=>parseReaderExport(value),{code:'READER_EXPORT_INVALID'});
});
test('size and entity count limits are enforced before exporting or parsing',()=>{
 assert.throws(()=>parseReaderExport(Buffer.alloc(MAX_READER_EXPORT_BYTES+1)),/8 МБ/);
 assert.throws(()=>parseReaderExport(' '.repeat(MAX_READER_EXPORT_BYTES+1)),/слишком большой/);
 assert.throws(()=>createReaderExport(Array(MAX_READER_EXPORT_ENTITIES+1).fill(reading()),{createdAt}),/Слишком много/);
 const value=createReaderExport([],{createdAt});value.payload.entities=Array(MAX_READER_EXPORT_ENTITIES+1).fill(null);assert.throws(()=>parseReaderExport(bytes(value)),/Слишком много/);
});
test('large aggregate output is refused rather than truncated',()=>{
 const records=Array.from({length:16000},()=>({...bookmark(),entityId:randomUUID(),payload:{...bookmark().payload,note:'я'.repeat(500)}}));
 assert.throws(()=>serializeReaderExport(records,{createdAt}),/слишком большой|8 МБ/);
});
test('duplicate entity IDs are refused after UUID case normalization',()=>{
 const a=reading(),b={...a,entityId:a.entityId.toUpperCase()};
 assert.throws(()=>createReaderExport([a,b],{createdAt}),/Повторяющийся/);
 assert.throws(()=>parseReaderExport(mutate(value=>{value.payload.entities.push(structuredClone(value.payload.entities[0]));})),/Повторяющийся/);
});
test('IDs are isolated by entity type',()=>{
 const a=reading(),b={...bookmark(),entityId:a.entityId};assert.equal(parseReaderExport(serializeReaderExport([a,b],{createdAt})).entities.length,2);
});
test('unknown per-record fields and missing required fields are rejected on import',()=>{
 for(const change of [row=>{row.profileId=randomUUID();},row=>{row.sourceUrl='https://example.test/book';},row=>{delete row.payload;row.deleted=true;},row=>{delete row.revision;},row=>{row.entityType='session';}])assert.throws(()=>parseReaderExport(mutate(value=>change(value.payload.entities[0]))));
});
test('import tombstones accept only null payload, not hidden active data',()=>{
 assert.throws(()=>parseReaderExport(mutate(value=>{value.payload.entities[0].deleted=true;})),{code:'READER_EXPORT_INVALID'});
 assert.doesNotThrow(()=>parseReaderExport(mutate(value=>{value.payload.entities[0].deleted=true;value.payload.entities[0].payload=null;})));
});
test('prototype and constructor keys at any depth are refused without modifying prototypes',()=>{
 const clean=serializeReaderExport([reading()],{createdAt}).toString('utf8');
 for(const key of ['__proto__','prototype','constructor']){
  const tampered=clean.replace('"format":','"'+key+'":{"polluted":true},"format":');
  assert.throws(()=>parseReaderExport(tampered),{code:'READER_EXPORT_INVALID'});
 }
 assert.equal({}.polluted,undefined);
});
test('recomputed hash cannot make unknown executable or download fields valid',()=>{
 for(const key of ['script','html','url','downloadUrl','path','role'])assert.throws(()=>parseReaderExport(mutate(value=>{value.payload.entities[0].payload[key]='https://evil.test/a.js';})));
});
test('quoted markup is inert note text, not an executable module or fetched URL',()=>{
 const row=bookmark();row.payload.note='<script>alert(1)</script> https://example.test/notes';
 assert.equal(parseReaderExport(serializeReaderExport([row],{createdAt})).entities[0].payload.note,row.payload.note);
});
test('text, locator, revision and catalog bounds still apply when checksum is correct',()=>{
 for(const change of [row=>{row.payload.locator.offset=-1;},row=>{row.payload.locator.publicationRevision=2;},row=>{row.payload.locator.publicationId=randomUUID();},row=>{row.payload.locator.progression=2;},row=>{row.revision=0;},row=>{row.entityId=randomUUID();},row=>{row.payload.shelf='secret';},row=>{row.payload.locator.chapterId='../../outside';}])assert.throws(()=>parseReaderExport(mutate(value=>change(value.payload.entities[0]))));
 const row=catalog();row.payload.catalogs[0].parent=row.payload.catalogs[0].id;assert.throws(()=>createReaderExport([row],{createdAt}));
});
test('control characters and malformed Unicode are rejected rather than normalized away',()=>{
 for(const note of ['before\u0000after','before\u202eafter','\ud800']){const row=bookmark();row.payload.note=note;assert.throws(()=>createReaderExport([row],{createdAt}));}
 assert.throws(()=>parseReaderExport('\ud800'),{code:'READER_EXPORT_INVALID'});
});
