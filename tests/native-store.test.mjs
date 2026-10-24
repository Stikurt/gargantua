import test from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs/promises';
import path from'node:path';
import os from'node:os';
import storeModule from'../desktop/store.cjs';
const{FileStore}=storeModule;
test('native store persists book files across process/store restarts',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cotology-test-'));
 try{
  const key='10000000-0000-4000-8000-000000000001:book:20000000-0000-4000-8000-000000000002';
  const store=new FileStore(root);await store.put(key,{title:'Книга',content:{chapters:[{title:'Глава',blocks:[{type:'text',text:'Текст'}]}]}});
  assert.ok((await fs.stat(path.join(root,'books','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002.cotology.json'))).isFile());
  const reopened=new FileStore(root);assert.equal((await reopened.get(key)).title,'Книга');assert.deepEqual(await reopened.keys('10000000'),[key]);
  await reopened.remove(key);assert.equal(await reopened.get(key),null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('native store rejects arbitrary paths and oversized data',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cotology-test-'));
 try{const store=new FileStore(root);await assert.rejects(()=>store.put('../../evil',{x:1}));await assert.rejects(()=>store.put('lastProfile','x'.repeat(33*1024*1024)));}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
test('native index remains consistent under concurrent writes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cotology-test-'));
 try{const store=new FileStore(root),prefix='10000000-0000-4000-8000-000000000001:position:';await Promise.all(Array.from({length:12},(_,i)=>store.put(prefix+i,{chapter:i})));assert.equal((await new FileStore(root).keys(prefix)).length,12);}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
