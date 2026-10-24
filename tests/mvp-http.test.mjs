import test from 'node:test';
import assert from 'node:assert/strict';
import {createMvpApp} from '../server/mvp-app.mjs';

async function withServer(run,sources={}){
  const server=createMvpApp({sources}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try{await run('http://127.0.0.1:'+server.address().port);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('MVP health and catalog do not depend on login, database, worker or inference',async()=>withServer(async root=>{
  assert.equal((await(await fetch(root+'/api/mvp/health')).json()).ok,true);
  const catalog=(await(await fetch(root+'/api/mvp/sources')).json()).sources;
  assert.ok(catalog.length>=7);assert.ok(catalog.some(source=>source.id==='libcat'));assert.ok(catalog.some(source=>source.id==='ranobeme'));
}));
test('search passes Cyrillic and pagination without changing query to its source',async()=>withServer(async root=>{
  const result=await(await fetch(root+'/api/mvp/search?q='+encodeURIComponent('Белые ночи')+'&source=ranobelib&page=2')).json();
  assert.equal(result.items[0].title,'Белые ночи');
},{search:async args=>{assert.deepEqual(args,{query:'Белые ночи',source:'ranobelib',page:2});return {items:[{title:args.query}],sources:[]};}}));
test('invalid source and page are reported rather than silent empty results',async()=>withServer(async root=>{
  for(const params of ['source=http://localhost','page=-1','page=NaN','page=1.1']){
    const res=await fetch(root+'/api/mvp/search?'+params);assert.equal(res.status,400);assert.ok((await res.json()).error);
  }
}));
test('source errors remain errors for the client',async()=>withServer(async root=>{
  const res=await fetch(root+'/api/mvp/random?source=ranobelib');assert.equal(res.status,502);assert.match((await res.json()).error,/недоступен/);
},{random:async()=>{throw new Error('РанобэЛиб недоступен');}}));
test('chapter routing preserves book and translation branch identity',async()=>withServer(async root=>{
  const res=await fetch(root+'/api/mvp/chapter?source=ranobelib&id=123-test&chapterId=1&branchId=52');
  assert.equal((await res.json()).text,'Открытая глава');
},{chapter:async(...args)=>{assert.deepEqual(args,['ranobelib','123-test','1',{branchId:'52'}]);return {text:'Открытая глава'};}}));
