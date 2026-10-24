// Authenticated release smoke check. Does not create or edit reader metadata.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {parseReaderExport} from '../server/reader-export.mjs';
const root=new URL('../',import.meta.url),destination=new URL('.local/test-results/c2-release/http.json',root);
const login=JSON.parse((await fs.readFile(new URL('.local/login.txt',root),'utf8')).replace(/^\uFEFF/,''));
const response=await fetch('http://localhost:3080/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Cotology':'1'},body:JSON.stringify({login:login.login,password:login.password}),signal:AbortSignal.timeout(10000)});
assert.equal(response.status,200,'Release login failed');
const cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
const headers={Cookie:cookie};let csrf;
try{
 const get=async route=>{const result=await fetch('http://localhost:3080'+route,{headers,signal:AbortSignal.timeout(10000)});assert.equal(result.status,200,route);return result.json();};
 const me=await get('/api/me');csrf=me.csrf;
 const status=await get('/api/status');assert.equal(status.version,'0.2.0-core.9');assert.equal(status.storageVersion,10);
 const capacity=await get('/api/v2/reader/storage');assert.equal(capacity.maxBytes,96*1024*1024);assert.deepEqual(capacity.protocolVersions,[1,2]);
 const snapshot=await get('/api/v2/reader/snapshot');assert.ok(Array.isArray(snapshot.devices));const changes=await get('/api/v2/reader/changes?cursor='+snapshot.cursor);
 assert.deepEqual(changes.changes,[]);assert.equal(changes.cursor,snapshot.cursor);
 const conflicts=await get('/api/v2/reader/conflicts');assert.ok(Array.isArray(conflicts.conflicts));
 const exported=await fetch('http://localhost:3080/api/v2/reader/export',{headers,signal:AbortSignal.timeout(10000)});assert.equal(exported.status,200);
 const bytes=Buffer.from(await exported.arrayBuffer()),archive=parseReaderExport(bytes);assert.equal(archive.entities.length,snapshot.entities.length);
 const preview=await fetch('http://localhost:3080/api/v2/reader/import/preview',{method:'POST',headers:{...headers,'X-Cotology':'1','X-CSRF-Token':csrf,'Content-Type':'application/json'},body:bytes,signal:AbortSignal.timeout(10000)});assert.equal(preview.status,200);
 const plan=await preview.json();assert.equal(plan.applied,false);assert.ok(plan.entries.every(entry=>entry.status==='same'));
 const books=await get('/api/books');let marks=0;
 for(const book of books){const detail=await get('/api/books/'+book.id);await get('/api/v2/publications/'+book.id+'?revision=1');marks+=detail.bookmarks.length;
  for(const legacy of detail.bookmarks){const current=snapshot.entities.find(entity=>entity.entityType==='bookmark'&&entity.entityId===legacy.id);assert.ok(current&&!current.deleted);assert.equal(current.payload.note,legacy.note);assert.deepEqual(current.payload.locator,{type:'legacy',chapter:legacy.chapter,position:legacy.position});}
 }
 const report={status:'passed',checkedAt:new Date().toISOString(),version:status.version,storageVersion:status.storageVersion,booksReadable:books.length,legacyBookmarksPreserved:marks,readerEntities:snapshot.entities.length,exportBytes:bytes.length,exportSha256:archive.sha256,previewOnly:true,readerMetadataEdited:false,conflictsAccessible:conflicts.conflicts.length};
 await fs.writeFile(destination,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(csrf)await fetch('http://localhost:3080/api/logout',{method:'POST',headers:{...headers,'X-Cotology':'1','X-CSRF-Token':csrf},signal:AbortSignal.timeout(10000)});}
