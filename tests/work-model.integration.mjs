// Real migrations/PG/files/route handlers, in a new owned schema and temp root.
// This is not an antivirus scan or a production migration/restore.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {assignBookModel} from '../server/work-model.mjs';
import {claimImport,markPrepared,publishImport,failImport,reconcileAttempts} from '../server/import-jobs.mjs';
import {stagePublication,placePublication,readPublication,removeAttemptFiles} from '../server/publication-files.mjs';
import {canonicalJson,checkedPublicationView,publicChapter,sha256} from '../server/publication-model.mjs';
import {publicationRoutes} from '../server/publication-api.mjs';

const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(url.pathname))throw new Error('Explicit isolated TEST_DATABASE_URL is required; refusing any production database');
const schema='work_model_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:10000,statement_timeout:10000});
const isolated=new URL(url);isolated.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:isolated.href,max:8,connectionTimeoutMillis:10000,statement_timeout:10000});
const owner=randomUUID(),friend=randomUUID(),legacyId=randomUUID(),legacyImport=randomUUID(),legacyMark=randomUUID();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6QkAAAAASUVORK5CYII=','base64');
const baseBook=(text='Synthetic body '+randomUUID(),language='en')=>({title:'Synthetic work',author:'Synthetic author',language,chapters:[{title:'Chapter 😀',blocks:[{type:'text',text}]}],assets:{}});
const legacyBook=baseBook('Legacy bytes and synthetic note remain unchanged.','ru'),legacyBytes=Buffer.from(JSON.stringify(legacyBook));
let root,owned=false,spec;
before(async()=>{
 await admin.query(`CREATE SCHEMA ${schema}`);owned=true;root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-work-model-'));
 spec=JSON.parse(await fs.readFile(process.env.TEST_API_SPEC_PATH||new URL('../docs/gargantua/api.openapi.json',import.meta.url),'utf8'));
 // Reconstruct a genuine pre-003 schema/ledger, then migrate its existing data.
 const client=await pool.connect();try{
  await client.query('BEGIN');await client.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of ['001-baseline.sql','002-durable-publication.sql']){const bytes=await fs.readFile(new URL('../server/migrations/'+name,import.meta.url));await client.query(bytes.toString('utf8'));await client.query('INSERT INTO schema_migrations(version,sha256) VALUES($1,$2)',[name,sha256(bytes)]);}
  await client.query("INSERT INTO profiles(id,login,password,role) VALUES($1,'synthetic-owner','no-login-fixture','owner'),($2,'synthetic-friend','no-login-fixture','trusted-import')",[owner,friend]);
  await client.query("INSERT INTO imports(id,requested_by,kind,filename,status,book_id) VALUES($1,$2,'upload','legacy.txt','completed',$3)",[legacyImport,owner,legacyId]);
  await client.query('INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by) VALUES($1,$2,$3,$4,1,$5,$6,$7)',[legacyId,legacyBook.title,legacyBook.author,legacyBook.language,sha256(legacyBytes),legacyImport,owner]);
  await client.query("INSERT INTO reading(profile_id,book_id,chapter,position,shelf) VALUES($1,$2,0,0.25,'reading')",[owner,legacyId]);
  await client.query("INSERT INTO bookmarks(id,profile_id,book_id,chapter,position,note) VALUES($1,$2,$3,0,0.5,'Synthetic private note')",[legacyMark,owner,legacyId]);
  await client.query('INSERT INTO profile_catalogs(profile_id,revision,catalogs) VALUES($1,7,$2)',[owner,JSON.stringify([{id:'synthetic-series',name:'Synthetic series',bookIds:[legacyId]}])]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 await fs.mkdir(path.join(root,'books',legacyId),{recursive:true});await fs.writeFile(path.join(root,'books',legacyId,'book.json'),legacyBytes);
 await applyMigrations(pool);
});
after(async()=>{
 await pool.end();
 try{if(owned){assert.match(schema,/^work_model_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}
 if(root){assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('gargantua-work-model-'));await fs.rm(root,{recursive:true,force:true});}
});
async function transaction(operation){const client=await pool.connect();try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}
async function prepare(book,{requestedBy=owner}={}){
 const id=randomUUID();await pool.query("INSERT INTO imports(id,requested_by,kind,filename,status,decision_reason) VALUES($1,$2,'upload','fixture.txt','queued','role-auto-approval')",[id,requestedBy]);
 const row=await claimImport(pool);assert.equal(row.id,id);const prepared=await stagePublication(root,row.attempt_token,row.resultBookId,book);
 await markPrepared(pool,row,prepared.manifest);await placePublication(root,prepared);await markPrepared(pool,row,prepared.manifest,'placed');return {row,prepared,book};
}
async function checked(row){const publication=await readPublication(root,row);checkedPublicationView(row,publication.content);return publication;}
async function publish(book,options={}){const fixture=await prepare(book,options);const id=await publishImport(pool,fixture.row,book,fixture.prepared,{sha256:sha256(Buffer.from('synthetic acquired bytes'))},{verifyExisting:checked,...options});return {...fixture,id,bookRow:(await pool.query('SELECT * FROM books WHERE id=$1',[id])).rows[0]};}
const source=(remoteId,variant,kind='human-translation')=>({provider:'ranobelib',remoteId,variant,kind,label:'Synthetic supported-adapter identity'});
const countBooks=async()=>Number((await pool.query('SELECT count(*) FROM books')).rows[0].count);

test('003 preserves legacy bytes, reading, bookmarks, catalogs and unverified identity without inventing a seal',async()=>{
 const row=(await pool.query('SELECT * FROM books WHERE id=$1',[legacyId])).rows[0];assert.equal(row.content_sha256,null);assert.equal(row.publication_manifest,null);assert.equal(row.sha256,sha256(legacyBytes));
 assert.ok((await fs.readFile(path.join(root,'books',legacyId,'book.json'))).equals(legacyBytes));
 const work=(await pool.query('SELECT * FROM works WHERE id=$1',[row.work_id])).rows[0],expression=(await pool.query('SELECT * FROM expressions WHERE id=$1',[row.expression_id])).rows[0];
 assert.equal(work.identity_state,'unverified');assert.deepEqual(work.authors,[legacyBook.author]);assert.equal(expression.kind,'unclassified');assert.equal(expression.variant_key,'legacy:'+legacyId);
 assert.equal(Number((await pool.query('SELECT position FROM reading WHERE book_id=$1',[legacyId])).rows[0].position),0.25);
 assert.equal((await pool.query('SELECT note FROM bookmarks WHERE id=$1',[legacyMark])).rows[0].note,'Synthetic private note');
 const catalogs=(await pool.query('SELECT revision,catalogs FROM profile_catalogs WHERE profile_id=$1',[owner])).rows[0];assert.equal(catalogs.revision,7);assert.equal(catalogs.catalogs[0].bookIds[0],legacyId);
 const ids=[row.work_id,row.expression_id,row.edition_id];await applyMigrations(pool);const again=(await pool.query('SELECT * FROM books WHERE id=$1',[legacyId])).rows[0];assert.deepEqual([again.work_id,again.expression_id,again.edition_id],ids);
});
test('one source work has separate expression variants and editions; title equality alone never merges uploads',async()=>{
 const remoteId='fixture-'+randomUUID(),a=await publish(baseBook('Variant A','en'),{source:source(remoteId,'english','original')}),b=await publish(baseBook('Вариант Б','ru'),{source:source(remoteId,'russian')});
 assert.equal(a.bookRow.work_id,b.bookRow.work_id);assert.notEqual(a.bookRow.expression_id,b.bookRow.expression_id);assert.notEqual(a.bookRow.edition_id,b.bookRow.edition_id);
 const c=await publish(baseBook('Revision A second edition','en'),{source:source(remoteId,'english','original')});assert.equal(c.bookRow.expression_id,a.bookRow.expression_id);assert.notEqual(c.bookRow.edition_id,a.bookRow.edition_id);
 const x=await publish(baseBook('Same title upload one')),y=await publish(baseBook('Same title upload two'));assert.notEqual(x.bookRow.work_id,y.bookRow.work_id);
});
test('source variant metadata conflict fails closed and rolls back newly attempted model rows',async()=>{
 const remoteId='conflict-'+randomUUID(),book=baseBook('Original','en'),first=await transaction(c=>assignBookModel(c,book,{source:source(remoteId,'same','original')}));
 for(const [language,kind] of [['ru','original'],['en','human-translation']])await assert.rejects(()=>transaction(c=>assignBookModel(c,{...book,language},{source:source(remoteId,'same',kind)})),{code:'EXPRESSION_CONFLICT'});
 const row=(await pool.query('SELECT language,kind FROM expressions WHERE id=$1',[first.expression_id])).rows[0];assert.deepEqual(row,{language:'en',kind:'original'});
 assert.equal(Number((await pool.query('SELECT count(*) FROM editions WHERE expression_id=$1',[first.expression_id])).rows[0].count),1);
});
test('translation source must belong to the same work and machine translation cannot omit its source',async()=>{
 const a=await transaction(c=>assignBookModel(c,baseBook('Work A'),{})),b=await transaction(c=>assignBookModel(c,baseBook('Work B'),{}));
 await assert.rejects(()=>pool.query("INSERT INTO expressions(id,work_id,language,kind,variant_key,source_expression_id) VALUES($1,$2,'ru','machine-translation','wrong-source',$3)",[randomUUID(),a.work_id,b.expression_id]),{code:'23503'});
 await assert.rejects(()=>pool.query("INSERT INTO expressions(id,work_id,language,kind,variant_key) VALUES($1,$2,'ru','machine-translation','missing-source')",[randomUUID(),a.work_id]),{code:'23514'});
 const translation=randomUUID();await pool.query("INSERT INTO expressions(id,work_id,language,kind,variant_key,source_expression_id) VALUES($1,$2,'ru','machine-translation','same-work',$3)",[translation,a.work_id,a.expression_id]);
 assert.equal((await pool.query('SELECT source_expression_id FROM expressions WHERE id=$1',[translation])).rows[0].source_expression_id,a.expression_id);
});
test('exact content reuse validates the existing package and cleans only the unreferenced duplicate result',async()=>{
 const book=baseBook('Exact content reuse '+randomUUID()),original=await publish(book),before=await countBooks(),second=await prepare(book,{requestedBy:friend});let verified=0;
 const id=await publishImport(pool,second.row,book,second.prepared,{sha256:sha256(Buffer.from('different synthetic source container'))},{verifyExisting:async row=>{verified++;await checked(row);}});
 assert.equal(id,original.id);assert.equal(verified,1);assert.equal(await countBooks(),before);
 const imported=(await pool.query('SELECT status,book_id,requested_by,report FROM imports WHERE id=$1',[second.row.id])).rows[0];assert.equal(imported.status,'completed');assert.equal(imported.book_id,original.id);assert.equal(imported.requested_by,friend);assert.equal(imported.report.deduplicatedTo,original.id);
 const attempt=(await pool.query('SELECT state,reused_book_id FROM import_attempts WHERE token=$1',[second.row.attempt_token])).rows[0];assert.equal(attempt.state,'reused');assert.equal(attempt.reused_book_id,original.id);
 await fs.stat(path.join(root,'books',second.prepared.id));
 await reconcileAttempts(pool,attempt=>removeAttemptFiles(root,attempt.token,attempt.book_id,{removePlaced:true}));
 await assert.rejects(()=>fs.stat(path.join(root,'books',second.prepared.id)),{code:'ENOENT'});await checked(original.bookRow);
 assert.equal((await pool.query('SELECT state FROM import_attempts WHERE token=$1',[second.row.attempt_token])).rows[0].state,'cleaned');
});
test('missing/failing reuse verifier never marks a duplicate as completed',async()=>{
 const book=baseBook('Verifier fail closed '+randomUUID()),original=await publish(book),before=await countBooks();
 for(const verifyExisting of [undefined,async()=>{throw Object.assign(new Error('synthetic existing package corruption'),{code:'PUBLICATION_INTEGRITY'});}]){
  const second=await prepare(book);let failure;try{await publishImport(pool,second.row,book,second.prepared,{sha256:sha256(Buffer.from('fixture'))},{verifyExisting});}catch(error){failure=error;}
  assert.ok(failure);await failImport(pool,second.row,failure,{});assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[second.row.id])).rows[0].status,'error');assert.equal(await countBooks(),before);
 }await checked(original.bookRow);
});
test('blocked exact duplicate cannot be resurrected through another import',async()=>{
 const book=baseBook('Blocked duplicate '+randomUUID()),original=await publish(book),before=await countBooks();await pool.query("UPDATE books SET security_state='blocked',blocked_reason='synthetic owner test block' WHERE id=$1",[original.id]);
 const second=await prepare(book);let verified=0,error;
 try{await publishImport(pool,second.row,book,second.prepared,{sha256:sha256(Buffer.from('fixture'))},{verifyExisting:async()=>{verified++;}});}catch(failure){error=failure;}
 assert.equal(error?.blocked,true);assert.equal(verified,0);await failImport(pool,second.row,error,{});assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[second.row.id])).rows[0].status,'blocked');assert.equal(await countBooks(),before);
 assert.equal((await pool.query('SELECT security_state FROM books WHERE id=$1',[original.id])).rows[0].security_state,'blocked');
});
test('sealed publication metadata is immutable while an owner security block remains possible',async()=>{
 const {bookRow:row}=await publish(baseBook('Immutable publication '+randomUUID()));
 const changes=[['title','Edited title'],['content_sha256','f'.repeat(64)],['publication_sha256','a'.repeat(64)],['work_id',randomUUID()],['expression_id',randomUUID()],['edition_id',randomUUID()],['publication_manifest',JSON.stringify({...row.publication_manifest,title:'Edited'})]];
 for(const [column,value] of changes)await assert.rejects(()=>pool.query(`UPDATE books SET ${column}=$1 WHERE id=$2`,[value,row.id]),error=>error.code==='P0001'&&/immutable/.test(error.message));
 const after=(await pool.query('SELECT * FROM books WHERE id=$1',[row.id])).rows[0];assert.equal(after.title,row.title);assert.deepEqual(after.publication_manifest,row.publication_manifest);await checked(after);
 await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[row.id]);assert.equal((await pool.query('SELECT security_state FROM books WHERE id=$1',[row.id])).rows[0].security_state,'blocked');
});

// Verify only JSON Schema keywords used by these concrete contracts. Fail on
// new validation keywords instead of silently pretending to validate them.
function schemaCheck(rule,value,location='$'){
 if(rule.$ref){assert.match(rule.$ref,/^#\/components\/schemas\//);return schemaCheck(spec.components.schemas[rule.$ref.split('/').at(-1)],value,location);}
 const supported=new Set(['type','additionalProperties','properties','required','items','minItems','maxItems','maxLength','minLength','minimum','maximum','pattern','enum','const','format','description','title','example','default']);
 for(const key of Object.keys(rule))assert.ok(supported.has(key),`Unsupported schema keyword ${key} at ${location}`);
 if('const'in rule)assert.deepEqual(value,rule.const,location);if(rule.enum)assert.ok(rule.enum.includes(value),location);
 if(rule.type==='object'){
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value),location);for(const key of rule.required||[])assert.ok(Object.hasOwn(value,key),`${location}.${key} required`);
  for(const [key,item]of Object.entries(value)){if(rule.additionalProperties===false)assert.ok(Object.hasOwn(rule.properties||{},key),`${location}.${key} forbidden`);if(rule.properties?.[key])schemaCheck(rule.properties[key],item,`${location}.${key}`);}
 }else if(rule.type==='array'){
  assert.ok(Array.isArray(value),location);if(rule.minItems!==undefined)assert.ok(value.length>=rule.minItems,location);if(rule.maxItems!==undefined)assert.ok(value.length<=rule.maxItems,location);for(const item of value)schemaCheck(rule.items,item,location+'[]');
 }else if(rule.type==='string'){
  assert.equal(typeof value,'string',location);const length=[...value].length;if(rule.minLength!==undefined)assert.ok(length>=rule.minLength,location);if(rule.maxLength!==undefined)assert.ok(length<=rule.maxLength,location);if(rule.pattern)assert.match(value,new RegExp(rule.pattern),location);if(rule.format==='uuid')assert.match(value,/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,location);
 }else if(rule.type==='integer'||rule.type==='number'){
  assert.equal(typeof value,'number',location);assert.ok(Number.isFinite(value),location);if(rule.type==='integer')assert.ok(Number.isSafeInteger(value),location);if(rule.minimum!==undefined)assert.ok(value>=rule.minimum,location);if(rule.maximum!==undefined)assert.ok(value<=rule.maximum,location);
 }
}
function routesFor(){
 const routes=new Map(),app={get:(route,...handlers)=>routes.set(route,handlers.at(-1))};
 publicationRoutes(app,{auth:()=>{},wrap:fn=>fn,error:(message,status)=>Object.assign(new Error(message),{status}),readable:async id=>{const row=(await pool.query('SELECT * FROM books WHERE id=$1',[id])).rows[0];if(!row||row.security_state!=='passed')throw Object.assign(new Error('not readable'),{status:423});return row;},verifiedPublication:row=>readPublication(root,row)});
 return async function call(route,params,revision='1',etag){
  const result={headers:{},status:200},res={set(name,value){result.headers[name]=value;return this;},type(value){result.type=value;return this;},status(value){result.status=value;return this;},send(value){result.bytes=value;return this;},end(){return this;}};
  await routes.get(route)({params,query:{revision},get:name=>name==='If-None-Match'?etag:undefined},res);return result;
 };
}
test('v2 rich chapters and resources satisfy the published schema and exact route bytes/hashes',async()=>{
 const book=baseBook('😀 Rich chapter fixture '+randomUUID(),'ru');book.assets={'image-1.png':png.toString('base64')};
 book.structure={schemaVersion:2,warnings:[],chapters:[{id:'c-rich',revision:1,title:'Д'.repeat(280),blocks:[
  {id:'b-heading',type:'heading',level:2,text:'Заголовок'},
  {id:'b-text',type:'paragraph',text:'😀 Пример',spans:[{start:0,end:2,kind:'strong'},{start:3,end:9,kind:'link',target:'b-note'}]},
  {id:'b-table',type:'table',text:'Таблица',rows:[['Колонка A','Колонка Б'],['1','2']]},
  {id:'b-image',type:'image',text:'Карта',resource:'image-1.png'},
  {id:'b-note',type:'footnote',text:'Сноска',referenceId:'b-text'}
 ]}]};
 const {id,bookRow}=await publish(book),call=routesFor(),view=checkedPublicationView(bookRow,book);
 const manifest=await call('/api/v2/publications/:id',{id});assert.equal(sha256(manifest.bytes),bookRow.publication_sha256);assert.ok(manifest.bytes.equals(view.bytes));schemaCheck(spec.components.schemas.Publication,JSON.parse(manifest.bytes));
 const chapter=await call('/api/v2/publications/:id/chapters/:chapterId',{id,chapterId:'c-rich'}),entry=view.manifest.readingOrder[0];assert.equal(sha256(chapter.bytes),entry.sha256);assert.equal(chapter.bytes.length,entry.bytes);assert.ok(chapter.bytes.equals(Buffer.from(canonicalJson(publicChapter(book.structure.chapters[0])))));
 const decoded=JSON.parse(chapter.bytes);schemaCheck(spec.components.schemas.Chapter,decoded);assert.equal([...decoded.title].length,250);assert.equal(decoded.blocks.find(b=>b.type==='image').resource,view.manifest.resources[0].path);
 const image=await call('/api/v2/publications/:id/resources/:name',{id,name:'image-1.png'});assert.ok(image.bytes.equals(png));assert.equal(sha256(image.bytes),view.manifest.resources[0].sha256);
 const cached=await call('/api/v2/publications/:id',{id},'1',manifest.headers.ETag);assert.equal(cached.status,304);assert.equal(cached.bytes,undefined);
 await assert.rejects(()=>call('/api/v2/publications/:id',{id},'2'),{status:409});await assert.rejects(()=>call('/api/v2/publications/:id/chapters/:chapterId',{id,chapterId:'missing'}),{status:404});
});
