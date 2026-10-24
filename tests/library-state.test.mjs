import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DEVICE} from '../src/catalogs.mjs';
import {LOCAL_LIBRARY_INDEX,LOCAL_LIBRARY_LIMITS,commitLocalBook,listLocalBooks,recoverLocalLibrary,refKey,removeLocalBook} from '../src/library-state.mjs';
import {DOWNLOAD_LIMITS,validateBookContent,validateDownloadedBook,readDownloadedResponse,boundedJsonBytes} from '../src/book-download.mjs';

class MemoryStorage{
 constructor(values={}){this.values=new Map(Object.entries(structuredClone(values)));this.reads=[];this.scans=0;this.applies=0;this.failBefore=false;this.loseAck=false;}
 async get(key){this.reads.push(key);return structuredClone(this.values.get(key));}
 async keys(prefix){this.scans++;return [...this.values.keys()].filter(key=>key.startsWith(prefix));}
 async entries(prefix){return structuredClone([...this.values].filter(([key])=>key.startsWith(prefix)));}
 async apply(operations){this.applies++;const staged=new Map(this.values);for(const op of operations){if(op.type==='put')staged.set(op.key,structuredClone(op.value));else if(op.type==='remove')staged.delete(op.key);else throw Error('unsupported');}await new Promise(resolve=>setTimeout(resolve,1));if(this.failBefore)throw Error('disk full before commit');this.values=staged;if(this.loseAck){this.loseAck=false;throw Error('lost commit acknowledgement');}}
}
const content=(title='История')=>({title,author:'Автор',language:'ru',chapters:[{title:'Начало',blocks:[{type:'text',text:'<script>Это только текст</script>'}]}],assets:{}});
const book=(extra={})=>({id:randomUUID(),title:'История',author:'Автор',chapter_count:1,created_at:'2026-10-23T00:00:00.000Z',...extra});
const packet=(value=book(),body=content())=>({book:value,content:body,savedAt:1});
const raw=value=>new TextEncoder().encode(JSON.stringify(value));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const localInput=(extra={})=>({owner:DEVICE,scope:'device',book:book(),content:content(),...extra});

test('migration recovers all owners and partial legacy cards without relying on lastProfile',async()=>{
 const owner=randomUUID(),other=randomUUID(),id=randomUUID(),local=book(),one=book({id,title:'Short legacy title'}),two=book({id,title:'Другой профиль'});
 const values={lastProfile:{id:owner,login:'owner'},[`${owner}:catalog`]:[one],[`${other}:catalog`]:[two],[`${DEVICE}:catalog`]:[local],
  [`${owner}:book:${id}`]:packet(one),[`${other}:book:${id}`]:{content:content('Другая история')},[`${DEVICE}:book:${local.id}`]:packet(local),[`${other}:position:${id}`]:{chapter:0,position:.5,shelf:'paused',lastRead:50}};
 const storage=new MemoryStorage(values),report=await recoverLocalLibrary(storage);assert.equal(report.recovered,3);assert.deepEqual(report.skipped,[]);assert.equal(report.books.find(b=>b.owner===other).position,.5);assert.equal(report.books.find(b=>b.owner===owner).recoveredLocalOnly,true);assert.equal(report.books.find(b=>b.owner===owner).title,'Short legacy title');
 for(const [key,value]of Object.entries(values))assert.deepEqual(storage.values.get(key),value);
 await storage.apply([{type:'remove',key:'lastProfile'}]);assert.equal((await listLocalBooks(storage)).length,3);assert.equal(storage.scans,1);
});
test('normal refresh reads only the metadata index and owner positions, never whole books',async()=>{
 const storage=new MemoryStorage(),input=localInput();await commitLocalBook(storage,input);storage.reads=[];storage.scans=0;
 const [result]=await listLocalBooks(storage);assert.equal(result.id,input.book.id);assert.equal(storage.scans,0);assert.deepEqual(storage.reads,[LOCAL_LIBRARY_INDEX]);
});
test('global index distinguishes equal publication IDs in different profiles and preserves notes on removal',async()=>{
 const a=randomUUID(),b=randomUUID(),shared=book(),storage=new MemoryStorage();
 await Promise.all([commitLocalBook(storage,{owner:a,scope:'server',book:shared,content:content()}),commitLocalBook(storage,{owner:b,scope:'server',book:shared,content:content()})]);
 await storage.apply([{type:'put',key:`${a}:position:${shared.id}`,value:{chapter:0,position:.2}},{type:'put',key:`${b}:position:${shared.id}`,value:{chapter:0,position:.8}},{type:'put',key:`${a}:mark:${shared.id}:${randomUUID()}`,value:{note:'Моя заметка'}}]);
 const books=await listLocalBooks(storage);assert.equal(books.length,2);assert.notEqual(refKey(books[0]),refKey(books[1]));assert.deepEqual(books.map(x=>x.position).sort(),[.2,.8]);
 await removeLocalBook(storage,{owner:a,id:shared.id});assert.equal((await listLocalBooks(storage))[0].owner,b);assert.ok(storage.values.has(`${a}:position:${shared.id}`));assert.ok([...storage.values.keys()].some(k=>k.startsWith(`${a}:mark:`)));assert.equal(storage.values.has(`${b}:book:${shared.id}`),true);
});
test('first import is one atomic transaction and failure never publishes a partial book',async()=>{
 const storage=new MemoryStorage({lastProfile:{id:randomUUID()}}),before=structuredClone(storage.values);storage.failBefore=true;
 await assert.rejects(()=>commitLocalBook(storage,localInput()),/disk full/);assert.equal(storage.applies,1);assert.deepEqual(storage.values,before);
});
test('lost acknowledgement retry deduplicates the committed package and keeps its original savedAt',async()=>{
 const storage=new MemoryStorage(),input=localInput();storage.loseAck=true;await assert.rejects(()=>commitLocalBook(storage,input),/acknowledgement/);
 const saved=storage.values.get(`${DEVICE}:book:${input.book.id}`),again=await commitLocalBook(storage,input);assert.equal(again.duplicate,true);assert.equal(storage.applies,1);assert.deepEqual(storage.values.get(`${DEVICE}:book:${input.book.id}`),saved);assert.equal((await listLocalBooks(storage)).length,1);
});
test('parallel successful commits cannot overwrite each other in the shared index',async()=>{
 const storage=new MemoryStorage(),inputs=Array.from({length:6},()=>localInput());await Promise.all(inputs.map(input=>commitLocalBook(storage,input)));assert.equal((await listLocalBooks(storage)).length,6);assert.equal(storage.applies,6);
});
test('concurrent remove and commit have deterministic transaction order without losing other books',async()=>{
 const storage=new MemoryStorage(),one=localInput(),two=localInput();await commitLocalBook(storage,one);await commitLocalBook(storage,two);
 await Promise.all([removeLocalBook(storage,{owner:DEVICE,id:one.book.id}),commitLocalBook(storage,one)]);assert.equal((await listLocalBooks(storage)).length,2);
 await Promise.all([commitLocalBook(storage,one),removeLocalBook(storage,{owner:DEVICE,id:one.book.id})]);const remaining=await listLocalBooks(storage);assert.deepEqual(remaining.map(b=>b.id),[two.book.id]);assert.equal(storage.values.has(`${DEVICE}:book:${one.book.id}`),false);
});
test('failed remove and lost remove acknowledgement preserve notes and remain retry safe',async()=>{
 const storage=new MemoryStorage(),input=localInput();await commitLocalBook(storage,input);const position=`${DEVICE}:position:${input.book.id}`;await storage.apply([{type:'put',key:position,value:{chapter:0,position:.7}}]);const before=structuredClone(storage.values);storage.failBefore=true;
 await assert.rejects(()=>removeLocalBook(storage,{owner:DEVICE,id:input.book.id}),/disk full/);assert.deepEqual(storage.values,before);storage.failBefore=false;storage.loseAck=true;
 await assert.rejects(()=>removeLocalBook(storage,{owner:DEVICE,id:input.book.id}),/acknowledgement/);await removeLocalBook(storage,{owner:DEVICE,id:input.book.id});assert.equal((await listLocalBooks(storage)).length,0);assert.ok(storage.values.has(position));
});
test('source file dedup is local-owner scoped and immutable IDs cannot replace another body',async()=>{
 const storage=new MemoryStorage(),one=localInput({book:book({sha256:'a'.repeat(64)})});await commitLocalBook(storage,one);
 const duplicate=await commitLocalBook(storage,localInput({book:book({sha256:'a'.repeat(64)})}));assert.equal(duplicate.duplicate,true);assert.equal(duplicate.book.id,one.book.id);
 await assert.rejects(()=>commitLocalBook(storage,{...one,content:content('Подменённая')}),{code:'LOCAL_BOOK_COLLISION'});
 const other=randomUUID();await commitLocalBook(storage,{...one,owner:other,scope:'server'});assert.equal((await listLocalBooks(storage)).length,2);
});
test('recovery skips dangerous or mismatched packets without deleting originals or indexing cache-only cards',async()=>{
 const owner=randomUUID(),good=book(),bad=book(),mismatch=book(),notDownloaded=book(),unsafe=content();unsafe.chapters[0].blocks=[{type:'image',asset:'https://evil.test/payload.svg',text:''}];
 const values={[`${owner}:catalog`]:[good,bad,notDownloaded],[`${owner}:book:${good.id}`]:packet(good),[`${owner}:book:${bad.id}`]:packet(bad,unsafe),[`${owner}:book:${mismatch.id}`]:packet(book())},storage=new MemoryStorage(values),report=await recoverLocalLibrary(storage);
 assert.equal(report.recovered,1);assert.equal(report.skipped.length,2);assert.equal(report.books[0].id,good.id);for(const [key,value]of Object.entries(values))assert.deepEqual(storage.values.get(key),value);
});
test('bad global index and unsupported non-atomic backend fail without rewriting source data',async()=>{
 const storage=new MemoryStorage({[LOCAL_LIBRARY_INDEX]:{schemaVersion:99,books:[]}}),before=structuredClone(storage.values);
 await assert.rejects(()=>recoverLocalLibrary(storage),{code:'LOCAL_INDEX_INVALID'});assert.deepEqual(storage.values,before);assert.equal(storage.applies,0);
 await assert.rejects(async()=>commitLocalBook({get:async()=>null,put:async()=>{}},localInput()),{code:'LOCAL_ATOMIC_REQUIRED'});
});
test('bounded migration refuses excessive key inventories before reading packets',async()=>{
 const storage=new MemoryStorage();storage.keys=async()=>Array(LOCAL_LIBRARY_LIMITS.keys+1).fill('ignored');await assert.rejects(()=>recoverLocalLibrary(storage),{code:'LOCAL_LIBRARY_INVALID'});assert.deepEqual(storage.reads,[LOCAL_LIBRARY_INDEX]);assert.equal(storage.applies,0);
 const repeated={...book(),owner:DEVICE,scope:'device'};storage.values.set(LOCAL_LIBRARY_INDEX,{schemaVersion:1,books:[repeated,repeated]});await assert.rejects(()=>listLocalBooks(storage),{code:'LOCAL_INDEX_INVALID'});assert.equal(storage.applies,0);
});
test('book quota applies globally while a same-ID retry remains possible at the limit',async()=>{
 const books=Array.from({length:LOCAL_LIBRARY_LIMITS.books},()=>({...book(),owner:DEVICE,scope:'device',shelf:'planned'})),storage=new MemoryStorage({[LOCAL_LIBRARY_INDEX]:{schemaVersion:1,books}});
 await assert.rejects(()=>commitLocalBook(storage,localInput()),{code:'LOCAL_LIBRARY_QUOTA'});assert.equal(storage.applies,0);assert.equal(storage.values.get(LOCAL_LIBRARY_INDEX).books.length,2000);
});
test('safe metadata keeps source identities but discards unrelated credentials and position field injection',async()=>{
 const work=randomUUID(),owner=randomUUID(),value=book({work_id:work,expression_id:randomUUID(),edition_id:randomUUID(),password:'private',role:'owner'}),storage=new MemoryStorage();
 await commitLocalBook(storage,{owner,scope:'server',book:value,content:content()});await storage.apply([{type:'put',key:`${owner}:position:${value.id}`,value:{title:'Injected',owner:DEVICE,chapter:999,position:4,shelf:'admin',lastRead:100}}]);
 const [result]=await listLocalBooks(storage);assert.equal(result.work_id,work);assert.equal(result.title,value.title);assert.equal(result.owner,owner);assert.equal(result.lastRead,100);assert.equal(result.chapter,undefined);assert.equal(result.password,undefined);assert.equal(result.role,undefined);
});

test('download validates actual raw bytes and immutable metadata instead of original-source hash',async()=>{
 const body=raw(content()),hash=sha(body),value=book({content_sha256:hash,content_bytes:body.length,sha256:'0'.repeat(64)}),result=await validateDownloadedBook(body,hash,{book:value});assert.equal(result.sha256,hash);assert.equal(result.bytes,body.length);assert.equal(result.content.chapters.length,1);
 const changed=body.slice();changed[10]^=1;await assert.rejects(()=>validateDownloadedBook(changed,hash,{book:value}),{code:'DOWNLOAD_HASH_MISMATCH'});
 await assert.rejects(()=>validateDownloadedBook(body,'f'.repeat(64),{book:value}),{code:'DOWNLOAD_HASH_MISSING'});
 await assert.rejects(()=>validateDownloadedBook(body,null,{book:{...value,content_sha256:undefined}}),{code:'DOWNLOAD_HASH_MISSING'});
 await assert.rejects(()=>validateDownloadedBook(body,hash,{book:{...value,chapter_count:2}}),{code:'DOWNLOAD_IDENTITY'});
});
test('invalid UTF8 and active package fields fail even when their raw SHA256 is correct',async()=>{
 const invalid=Uint8Array.from([0x7b,0x22,0xff,0x22,0x3a,0x31,0x7d]);await assert.rejects(()=>validateDownloadedBook(invalid,sha(invalid)),{code:'DOWNLOAD_INVALID'});
 for(const change of [b=>({...b,script:'evil'}),b=>({...b,chapters:[{title:'X',blocks:[{type:'html',text:'<script/>'}]}]}),b=>({...b,assets:{'https://bad.test/a.png':'AAAA'}})]){const bytes=raw(change(content()));await assert.rejects(()=>validateDownloadedBook(bytes,sha(bytes)),{code:'DOWNLOAD_INVALID'});}
 const prototype=new TextEncoder().encode('{"__proto__":{},"title":"X"}');await assert.rejects(()=>validateDownloadedBook(prototype,sha(prototype)),{code:'DOWNLOAD_INVALID'});
});
test('structured links stay internal and UTF16 accents cannot split a surrogate pair',()=>{
 const value=content();value.structure={schemaVersion:2,warnings:[],chapters:[{id:'c1',revision:1,title:'One',blocks:[{id:'p1',type:'paragraph',text:'A😀B',spans:[{start:1,end:3,kind:'strong'}]}]}]};assert.equal(validateBookContent(value),value);
 value.structure.chapters[0].blocks[0].spans[0].end=2;assert.throws(()=>validateBookContent(value),{code:'DOWNLOAD_INVALID'});value.structure.chapters[0].blocks[0].spans=[{start:0,end:1,kind:'link',target:'https://evil.test'}];assert.throws(()=>validateBookContent(value),{code:'DOWNLOAD_INVALID'});
});
test('prepared PNG is bounded by image dimensions and cannot reference remote content',()=>{
 const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6QkAAAAASUVORK5CYII='),c=>c.charCodeAt(0)),value=content();value.assets={'image-1.png':btoa(String.fromCharCode(...png))};value.chapters[0].blocks.push({type:'image',asset:'image-1.png',text:'Карта'});assert.equal(validateBookContent(value),value);
 new DataView(png.buffer).setUint32(16,100000);value.assets['image-1.png']=btoa(String.fromCharCode(...png));assert.throws(()=>validateBookContent(value),{code:'DOWNLOAD_INVALID'});
});
test('stream reader enforces actual byte budget before collecting an oversized body',async()=>{
 const body=raw(content()),value=book({content_sha256:sha(body)}),response=new Response(body,{headers:{'X-Content-SHA256':sha(body),'Content-Length':String(body.length)}});assert.equal((await readDownloadedResponse(response,value)).bytes,body.length);
 await assert.rejects(()=>readDownloadedResponse(new Response(body,{headers:{'Content-Length':String(DOWNLOAD_LIMITS.bytes+1)}}),value),{code:'DOWNLOAD_SIZE'});
 let cancelled=false;const big=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(DOWNLOAD_LIMITS.bytes));controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}});
 await assert.rejects(()=>readDownloadedResponse(new Response(big),value),{code:'DOWNLOAD_SIZE'});assert.equal(cancelled,true);
 await assert.rejects(()=>readDownloadedResponse(new Response(body,{headers:{'Content-Length':String(body.length+1)}}),value),{code:'DOWNLOAD_SIZE'});
});
test('fragmented byte streams use bounded accumulation and reader errors cannot publish a package',async()=>{
 const body=raw(content()),value=book({content_sha256:sha(body)});let offset=0;
 const tiny=new ReadableStream({pull(controller){if(offset===body.length)controller.close();else controller.enqueue(body.subarray(offset,++offset));}});assert.equal((await readDownloadedResponse(new Response(tiny),value)).sha256,sha(body));
 const broken=new ReadableStream({start(controller){controller.enqueue(body.subarray(0,10));controller.error(new Error('connection lost'));}});await assert.rejects(()=>readDownloadedResponse(new Response(broken),value),/connection lost/);
});
test('JSON budgeting counts repeated references without serializing huge values or invoking getters',()=>{
 const repeated=content();repeated.chapters[0].blocks=Array(30000).fill({type:'text',text:'T'.repeat(100000)});assert.throws(()=>validateBookContent(repeated),{code:'DOWNLOAD_SIZE'});
 const cycle=content();cycle.assets.loop=cycle;assert.throws(()=>validateBookContent(cycle),{code:'DOWNLOAD_INVALID'});
 let invoked=false;const active=content();Object.defineProperty(active,'title',{enumerable:true,get(){invoked=true;return 'X';}});assert.throws(()=>validateBookContent(active),{code:'DOWNLOAD_INVALID'});assert.equal(invoked,false);
 const sparse=content();sparse.chapters=new Array(1000);assert.throws(()=>validateBookContent(sparse),{code:'DOWNLOAD_INVALID'});
 const sample={text:'A😀\n\\"',values:[-0,1e-7,true,false,null]};assert.equal(boundedJsonBytes(sample),raw(sample).length);
});
