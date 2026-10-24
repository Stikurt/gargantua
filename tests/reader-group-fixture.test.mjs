import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {validateSerialGroupsResponse} from '../src/serial-groups.mjs';
import {validateDownloadedBook} from '../src/book-download.mjs';

test('real Windows reader fixture serves six independently hashed packets and every one of 275 chapter titles',async t=>{
 const source=await fs.readFile(new URL('../scripts/test-reader-client.ps1',import.meta.url),'utf8'),match=source.match(/\$fixture=@'\r?\n([\s\S]*?)\r?\n'@/);assert.ok(match,'The actual application runner must embed one bounded isolated fixture');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-group-fixture-')),ready=path.join(root,'ready.json'),script=path.join(root,'fixture.mjs');await fs.writeFile(script,match[1]);
 const child=spawn(process.execPath,[script,'--ready',ready],{stdio:['ignore','ignore','pipe'],windowsHide:true});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes.toString());
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}await fs.rm(root,{recursive:true,force:true});});
 let info;for(let n=0;n<100;n++){if(child.exitCode!==null)throw Error('Actual reader fixture failed: '+stderr);try{info=JSON.parse(await fs.readFile(ready,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}assert.ok(info,'Loopback fixture must become ready');assert.match(info.origin,/^http:\/\/127\.0\.0\.1:[0-9]+$/);
 const response=await fetch(info.origin+'/api/library/serial-groups'),[group]=validateSerialGroupsResponse(await response.json());assert.equal(group.totalChapters,275);assert.equal(group.parts.length,6);
 const books=await(await fetch(info.origin+'/api/books')).json();assert.equal(books.length,7);let count=0;
 for(const part of group.parts){
  const detail=await(await fetch(info.origin+'/api/books/'+part.publicationId)).json(),download=await fetch(info.origin+'/api/books/'+part.publicationId+'/download'),raw=Buffer.from(await download.arrayBuffer()),hash=createHash('sha256').update(raw).digest('hex'),{content}=await validateDownloadedBook(raw,hash,{book:detail.book});
  assert.equal(hash,part.contentSha256);assert.equal(hash,download.headers.get('x-content-sha256'));assert.equal(content.chapters.length,part.chapterCount);assert.equal(detail.chapters.length,part.chapterCount);assert.equal(detail.book.serial_feed_id,group.id);
  for(let local=0;local<part.chapterCount;local++){assert.equal(detail.chapters[local].index,local);assert.equal(detail.chapters[local].title,'Глава '+(part.chapterOffset+local+1));}count+=part.chapterCount;
 }
 assert.equal(count,275);
 for(const global of [0,49,50,274]){const part=group.parts.find(row=>global>=row.chapterOffset&&global<row.chapterOffset+row.chapterCount),chapter=await(await fetch(info.origin+'/api/books/'+part.publicationId+'/chapters/'+(global-part.chapterOffset))).json();assert.equal(chapter.title,'Глава '+(global+1));assert.ok(chapter.blocks[0].text.includes(`[SERIAL_CHAPTER_${global+1}]`));}
 const beyond=await fetch(info.origin+'/api/books/'+group.parts[5].publicationId+'/chapters/25');assert.equal(beyond.status,404);
 const journal=await(await fetch(info.origin+'/test/status')).json();assert.equal(journal.serialGroup.snapshotId,group.snapshotId);assert.equal(journal.requests.filter(row=>row.path.endsWith('/download')).length,6);
});
