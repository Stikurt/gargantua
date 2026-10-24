import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {stagePublication,placePublication,readPublication,inspectLegacyPublication,canonicalManifest,packageDigest,digest,readBoundedFile,removeAttemptFiles} from '../server/publication-files.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6QkAAAAASUVORK5CYII=','base64');
const fixture=()=>({title:'Проверка',author:'Тест',language:'ru',chapters:[{title:'Первая',blocks:[{type:'text',text:'Локальные байты.'},{type:'image',asset:'image-1.png',text:'Карта'}]}],assets:{'image-1.png':png.toString('base64')}});
const rowFor=(p,book)=>({id:p.id,title:book.title,author:book.author,language:book.language,chapter_count:book.chapters.length,artifact_manifest:p.manifest,content_sha256:p.contentSha256,content_bytes:p.contentBytes,package_sha256:p.packageSha256});
async function temporary(fn){const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'gargantua-publication-'));try{return await fn(root);}finally{assert.ok(path.resolve(root).startsWith(parent+path.sep));assert.ok(path.basename(root).startsWith('gargantua-publication-'));await fs.rm(root,{recursive:true,force:true});}}
async function ready(root){const book=fixture(),p=await stagePublication(root,randomUUID(),randomUUID(),book);await placePublication(root,p);return {book,p,row:rowFor(p,book)};}

test('staging is invisible until placement; new readers validate exact persisted bytes',()=>temporary(async root=>{
 const book=fixture(),p=await stagePublication(root,randomUUID(),randomUUID(),book),row=rowFor(p,book);
 await assert.rejects(()=>readPublication(root,row),{code:'ENOENT'});
 await placePublication(root,p);const r=await readPublication(root,row);
 assert.deepEqual(r.content,book);assert.equal(digest(r.raw),row.content_sha256);assert.ok(r.buffers.get('image-1.png').equals(png));
 assert.notEqual(row.content_sha256,digest(Buffer.from('original EPUB input')));
}));
test('canonical package digest is stable across JSONB file property ordering',()=>{
 const a={schemaVersion:1,files:[{path:'book.json',bytes:5,sha256:'a'.repeat(64)},{path:'image-1.png',bytes:10,sha256:'b'.repeat(64)}]};
 const b={files:[{sha256:'b'.repeat(64),bytes:10,path:'image-1.png'},{sha256:'a'.repeat(64),bytes:5,path:'book.json'}],schemaVersion:1};
 assert.equal(packageDigest(a),packageDigest(b));
 for(const bad of [null,{schemaVersion:1,files:[]},{...a,files:[...a.files,a.files[0]]},{...a,files:[{...a.files[0],path:'../book.json'}]},{...a,files:[a.files[1]]},{...a,files:[{...a.files[0],bytes:0}]}])assert.throws(()=>canonicalManifest(bad),{code:'PUBLICATION_INTEGRITY'});
});
test('tampered text and missing assets fail closed instead of returning a package',()=>temporary(async root=>{
 const {row}=await ready(root),file=path.join(root,'books',row.id,'book.json'),original=await fs.readFile(file);
 await fs.writeFile(file,original.toString().replace('Локальные','Подменённые'));await assert.rejects(()=>readPublication(root,row),{code:'PUBLICATION_INTEGRITY'});
 await fs.writeFile(file,original);await fs.unlink(path.join(root,'books',row.id,'image-1.png'));await assert.rejects(()=>readPublication(root,row),{code:'ENOENT'});
}));
test('asset bytes cannot be substituted, including a manifest matching a different inline asset',()=>temporary(async root=>{
 const {row}=await ready(root),file=path.join(root,'books',row.id,'image-1.png'),changed=Buffer.concat([png,Buffer.from('wrong')]);await fs.writeFile(file,changed);
 await assert.rejects(()=>readPublication(root,row),{code:'PUBLICATION_INTEGRITY'});
 row.artifact_manifest.files.find(f=>f.path==='image-1.png').bytes=changed.length;row.artifact_manifest.files.find(f=>f.path==='image-1.png').sha256=digest(changed);row.package_sha256=packageDigest(row.artifact_manifest);
 await assert.rejects(()=>readPublication(root,row),{code:'PUBLICATION_INTEGRITY'});
}));
test('legacy seal validates identity and physical assets without changing file bytes',()=>temporary(async root=>{
 const {row}=await ready(root),file=path.join(root,'books',row.id,'book.json'),before=await fs.readFile(file);
 const legacy={...row,artifact_manifest:null};const checked=await inspectLegacyPublication(root,legacy);assert.equal(checked.contentSha256,digest(before));assert.ok((await fs.readFile(file)).equals(before));
 await assert.rejects(()=>inspectLegacyPublication(root,{...legacy,title:'Другая книга'}),{code:'PUBLICATION_INTEGRITY'});
}));
test('existing final directories are preserved and invalid input never creates a publication',()=>temporary(async root=>{
 const {p,row}=await ready(root),second=await stagePublication(root,randomUUID(),p.id,fixture());
 await assert.rejects(()=>placePublication(root,second),{code:'PUBLICATION_INTEGRITY'});assert.equal((await readPublication(root,row)).content.title,'Проверка');
 const bad=fixture();bad.assets['image-1.png']='not-base64';await assert.rejects(()=>stagePublication(root,randomUUID(),randomUUID(),bad),{code:'PUBLICATION_INTEGRITY'});
}));
test('reconciliation removes only the explicitly owned attempt and unreferenced result',()=>temporary(async root=>{
 const {p,row}=await ready(root),other=await stagePublication(root,randomUUID(),randomUUID(),fixture());
 await removeAttemptFiles(root,other.attemptId,other.id,{removePlaced:true});assert.equal((await readPublication(root,row)).content.title,'Проверка');
 await assert.rejects(()=>removeAttemptFiles(root,'../../outside',p.id,{removePlaced:true}),{code:'PUBLICATION_INTEGRITY'});
}));
test('bounded file reads reject excess bytes and symlink files',()=>temporary(async root=>{
 const file=path.join(root,'bytes');await fs.writeFile(file,'0123456789');await assert.rejects(()=>readBoundedFile(file,5),{code:'PUBLICATION_INTEGRITY'});
 const link=path.join(root,'link');try{await fs.symlink(file,link);}catch(e){if(process.platform==='win32'&&e.code==='EPERM')return;throw e;}
 await assert.rejects(()=>readBoundedFile(link,100),{code:'PUBLICATION_INTEGRITY'});
}));
test('parser-writable parent links and special files cannot redirect or block a reader',()=>temporary(async root=>{
 const actual=path.join(root,'actual');await fs.mkdir(actual);await fs.writeFile(path.join(actual,'secret.json'),'private');const link=path.join(root,'linked');
 try{await fs.symlink(actual,link,'dir');}catch(e){if(process.platform==='win32'&&e.code==='EPERM')return;throw e;}
 await assert.rejects(()=>readBoundedFile(path.join(link,'secret.json'),100));
 if(process.platform!=='win32'){
  const fifo=path.join(actual,'pipe');assert.equal(spawnSync('mkfifo',[fifo]).status,0);await assert.rejects(()=>readBoundedFile(fifo,100),{code:'PUBLICATION_INTEGRITY'});
 }
}));
