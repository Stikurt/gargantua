import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {discoveryPublications,downloadDiscoveryBook} from '../src/discovery-delivery.mjs';
import {LOCAL_LIBRARY_INDEX,listLocalBooks} from '../src/library-state.mjs';

const profile={id:randomUUID(),role:'owner'};
const clone=value=>value===undefined?undefined:structuredClone(value);
class Storage {
 constructor(){this.map=new Map([[LOCAL_LIBRARY_INDEX,{schemaVersion:1,books:[]}]]);this.applies=0;this.fail=false;}
 async get(key){return clone(this.map.get(key));}
 async entries(prefix){return clone([...this.map].filter(([key])=>key.startsWith(prefix)));}
 async keys(prefix=''){return [...this.map.keys()].filter(key=>key.startsWith(prefix));}
 async apply(operations){if(this.fail)throw Error('disk full');const next=new Map(this.map);for(const op of operations)op.type==='put'?next.set(op.key,clone(op.value)):next.delete(op.key);this.map=next;this.applies++;}
}
function publication(title='Книга'){
 const id=randomUUID(),content={title,author:'Автор',language:'ru',chapters:[{title:'Глава',blocks:[{type:'text',text:'Безопасный текст для проверки скачивания.'}]}],assets:{}},bytes=new TextEncoder().encode(JSON.stringify(content)),sha=createHash('sha256').update(bytes).digest('hex');
 return {id,content,bytes,sha,book:{id,title,author:content.author,language:'ru',chapter_count:1,security_state:'passed',content_sha256:sha,content_bytes:bytes.byteLength}};
}
const discovery=(ids,translation)=>({outputs:{book:{status:'ready',...(ids.length===1?{publicationId:ids[0]}:{multipart:true,publicationIds:ids})},translation:translation||{status:'not-required'}}});
function environment(parts){
 const storage=new Storage(),calls=[],byId=new Map(parts.map(part=>[part.id,part]));
 const api=async(path,options)=>{calls.push({path,options});const match=path.match(/^\/books\/([^/]+)(\/download)?$/),part=byId.get(match?.[1]);assert.ok(part,'unknown publication');return match[2]?new Response(part.bytes,{headers:{'X-Content-SHA256':part.sha,'Content-Length':String(part.bytes.length)}}):{book:clone(part.book)};};
 return {storage,calls,api,connect:async()=>profile,profile,row:discovery(parts.map(part=>part.id))};
}

test('delivery resolves exact single, multipart and translated publication IDs without expanding a series',()=>{
 const first=randomUUID(),second=randomUUID(),translated=randomUUID();assert.deepEqual(discoveryPublications(discovery([first])),[first]);
 assert.deepEqual(discoveryPublications(discovery([first,second],{status:'ready',publicationIds:[translated,first]})),[first,second,translated]);
 assert.deepEqual(discoveryPublications(discovery([first],{status:'processing',publicationIds:[translated]})),[first]);
 for(const row of [{},{outputs:{book:{status:'pending',publicationId:first}}},discovery(['bad']),discovery([])])assert.throws(()=>discoveryPublications(row));
});

test('single verified download becomes an offline book and a retry reuses the same immutable packet',async()=>{
 const part=publication(),env=environment([part]),progress=[];
 assert.deepEqual(await downloadDiscoveryBook({...env,onProgress:value=>progress.push(value)}),{saved:1,reused:0,total:1});
 assert.equal((await listLocalBooks(env.storage))[0].id,part.id);const packet=clone(env.storage.map.get(`${profile.id}:book:${part.id}`));
 const again=await downloadDiscoveryBook(env);assert.deepEqual(again,{saved:0,reused:1,total:1});assert.deepEqual(env.storage.map.get(`${profile.id}:book:${part.id}`),packet);
 assert.equal(env.calls.filter(call=>call.path.endsWith('/download')).length,1);assert.deepEqual(progress,[{saved:1,reused:0,completed:1,total:1}]);
});

test('multipart connection failure preserves verified first parts and resumes only the missing part',async()=>{
 const parts=[publication('Первая часть'),publication('Вторая часть')],env=environment(parts),api=env.api;let fail=true;
 env.api=async(path,options)=>{if(fail&&path===`/books/${parts[1].id}/download`)throw Error('Connection lost');return api(path,options);};
 await assert.rejects(()=>downloadDiscoveryBook(env),error=>error.saved===1&&error.reused===0&&error.total===2&&/Сохранено 1 из 2/.test(error.message));
 assert.equal((await listLocalBooks(env.storage)).length,1);fail=false;
 assert.deepEqual(await downloadDiscoveryBook(env),{saved:1,reused:1,total:2});assert.equal((await listLocalBooks(env.storage)).length,2);
 assert.equal(env.calls.filter(call=>call.path===`/books/${parts[0].id}/download`).length,1);
});

test('SHA mismatch, blocked source and mismatched publication identity never commit a local book',async()=>{
 for(const kind of ['sha','blocked','identity']){
  const part=publication(),env=environment([part]),api=env.api;
  env.api=async(path,options)=>{if(kind==='sha'&&path.endsWith('/download'))return new Response(part.bytes,{headers:{'X-Content-SHA256':'0'.repeat(64)}});if(!path.endsWith('/download')&&kind==='blocked')return {book:{...part.book,security_state:'blocked'}};if(!path.endsWith('/download')&&kind==='identity')return {book:{...part.book,id:randomUUID()}};return api(path,options);};
  await assert.rejects(()=>downloadDiscoveryBook(env));assert.equal(env.storage.applies,0);assert.equal((await listLocalBooks(env.storage)).length,0);
 }
});

test('disk failure leaves both packet and shared index unchanged',async()=>{
 const env=environment([publication()]),before=clone(env.storage.map);env.storage.fail=true;
 await assert.rejects(()=>downloadDiscoveryBook(env),/disk full/);assert.deepEqual(env.storage.map,before);
});

test('profile mismatch before the download prevents any book API call',async()=>{
 const env=environment([publication()]);env.connect=async()=>({id:randomUUID()});
 await assert.rejects(()=>downloadDiscoveryBook(env),/Профиль сменился/);assert.equal(env.calls.length,0);assert.equal(env.storage.applies,0);
});

test('profile change while bytes are in flight stops the old-profile commit',async()=>{
 const env=environment([publication()]),api=env.api;let current=profile;
 env.connect=async()=>current;env.api=async(path,options)=>{const result=await api(path,options);if(path.endsWith('/download'))current={id:randomUUID()};return result;};
 await assert.rejects(()=>downloadDiscoveryBook(env),/Профиль сменился/);assert.equal(env.storage.applies,0);
});

test('a malformed cached packet is not counted as an already verified download',async()=>{
 const part=publication(),env=environment([part]);env.storage.map.set(`${profile.id}:book:${part.id}`,{book:{...part.book,owner:profile.id,scope:'server'},content:{active:'not a book'}});
 await assert.rejects(()=>downloadDiscoveryBook(env));assert.equal(env.storage.map.get(`${profile.id}:book:${part.id}`).content.active,'not a book');
});

test('a valid orphaned packet is repaired into the shared offline index before reporting success',async()=>{
 const part=publication(),env=environment([part]);env.storage.map.set(`${profile.id}:book:${part.id}`,{book:{...part.book,owner:profile.id,scope:'server'},content:part.content,savedAt:1});
 assert.deepEqual(await downloadDiscoveryBook(env),{saved:0,reused:1,total:1});assert.equal((await listLocalBooks(env.storage)).length,1);assert.equal(env.calls.filter(call=>call.path.endsWith('/download')).length,0);
});

test('UUID casing cannot create extra downloads of the same original or translated publication',()=>{
 const id=randomUUID();assert.deepEqual(discoveryPublications(discovery([id,id.toUpperCase()],{status:'ready',publicationIds:[id.toUpperCase(),id]})),[id]);
});

test('a ready translation without exact publication IDs is rejected rather than omitted silently',()=>{
 for(const publicationIds of [undefined,[],null,'not-an-array'])assert.throws(()=>discoveryPublications(discovery([randomUUID()],{status:'ready',publicationIds})),/публикации готового перевода/);
});

test('cached blocked, pending and unconfirmed books cannot be reused as verified downloads',async()=>{
 for(const status of ['blocked','pending',undefined]){
  const part=publication(),env=environment([part]),book={...part.book,owner:profile.id,scope:'server'};if(status===undefined)delete book.security_state;else book.security_state=status;
  const packet={book,content:part.content,savedAt:1};env.storage.map.set(`${profile.id}:book:${part.id}`,clone(packet));
  await assert.rejects(()=>downloadDiscoveryBook(env),/статуса проверки/);assert.equal(env.storage.applies,0);assert.deepEqual(env.storage.map.get(`${profile.id}:book:${part.id}`),packet);
 }
});
