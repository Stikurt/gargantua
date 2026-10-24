import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createMvpSources,extractMvpHtml} from '../server/mvp-sources.mjs';
import {createExtraBookSources} from '../server/mvp-extra-books.mjs';
import {createExtraNovelSources} from '../server/mvp-extra-novels.mjs';
import {mvpRetryAfterMs} from '../server/mvp-errors.mjs';
import {createMvpApp} from '../server/mvp-app.mjs';
import {request} from '../src/mvp/api.mjs';

test('Retry-After respects seconds, HTTP dates, long cooldowns and a bounded invalid fallback',()=>{
  const now=Date.parse('2026-10-24T00:00:00Z');
  assert.equal(mvpRetryAfterMs('180',now),180000);
  assert.equal(mvpRetryAfterMs('Sat, 24 Oct 2026 06:00:00 GMT',now),21600000);
  assert.equal(mvpRetryAfterMs('not-a-delay',now),60000);
  assert.equal(mvpRetryAfterMs(null,now),60000);
  assert.equal(mvpRetryAfterMs('999999999999',now),604800000);
});

test('all provider families preserve actual429 status, code and Retry-After',async()=>{
  const response=()=>new Response('Too Many Requests',{status:429,headers:{'Retry-After':'180'}});
  const sources=createMvpSources({fetchImpl:async()=>response()});
  const books=createExtraBookSources({fetchImpl:async()=>response(),extractHtml:extractMvpHtml});
  const novels=createExtraNovelSources({fetchImpl:async()=>response(),extractHtml:extractMvpHtml});
  for(const read of [()=>sources.book('ranobelib','38728--supreme-magus'),()=>books.book('litlife','11593'),()=>novels.book('ranobeme','297'),()=>novels.book('ranobehub','964-supreme-magus')]) {
    await assert.rejects(read,error=>error.status===429&&error.code==='SOURCE_RATE_LIMIT'&&error.retryAfterMs===180000);
  }
});

test('HTTP middleware emits structured429 and Retry-After without collapsing it into502',async()=>{
  const app=createMvpApp({sources:{sources:[{id:'test',name:'Test'}],book:async()=>{throw Object.assign(new Error('Источник просит снизить частоту'),{status:429,code:'SOURCE_RATE_LIMIT',retryAfterMs:21600000});}}});
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/mvp/book?source=test&id=1`);
    assert.equal(response.status,429); assert.equal(response.headers.get('retry-after'),'21600');
    assert.deepEqual(await response.json(),{error:'Источник просит снизить частоту',code:'SOURCE_RATE_LIMIT',retryAfterMs:21600000});
  } finally {await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

async function nativeRequest(fetchImpl) {
  const handlers=new Map(); let ready;
  const app={setName(){},setPath(){},getPath(){return '/profile';},setAppUserModelId(){},requestSingleInstanceLock(){return true;},quit(){},on(){},whenReady(){return {then(callback){ready=callback();return ready;}};}};
  class BrowserWindow {
    constructor(){this.webContents={id:7,send(){},setWindowOpenHandler(){},on(){}};}
    on(){} setMenuBarVisibility(){} async loadURL(){}
  }
  const electron={app,BrowserWindow,protocol:{registerSchemesAsPrivileged(){},handle(){}},ipcMain:{handle:(name,callback)=>handlers.set(name,callback),on(){}},session:{defaultSession:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}}},shell:{},dialog:{}};
  const source=await fs.readFile(new URL('../desktop/mvp-main.cjs',import.meta.url),'utf8');
  vm.runInNewContext(source,{
    require:name=>name==='electron'?electron:name==='node:fs/promises'?fs:name==='node:path'?path:name==='./close-coordinator.cjs'?{createCloseCoordinator:()=>({})}:assert.fail('Unexpected import '+name),
    __dirname:'/desktop',process:{argv:[]},URL,Response,Buffer,AbortSignal,fetch:fetchImpl,
  });
  await ready;
  return async address=>JSON.parse(JSON.stringify(await handlers.get('mvp:request')({sender:{id:7},senderFrame:{parent:null,url:'gargantua://app/'}},address)));
}

test('actual native handler and client wrapper keep429 fields through IPC serialization',async()=>{
  const native=await nativeRequest(async()=>new Response(JSON.stringify({error:'Источник просит снизить частоту',code:'SOURCE_RATE_LIMIT',retryAfterMs:180000}),{status:429}));
  const previous=globalThis.window;
  try {
    globalThis.window={gargantua:{request:native}};
    await assert.rejects(()=>request('/chapter?source=ranobelib&id=38728--supreme-magus&chapterId=v1-c1'),error=>error.status===429&&error.code==='SOURCE_RATE_LIMIT'&&error.retryAfterMs===180000);
  } finally {if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
});

test('native transport failures and malformed502 have distinct classifications',async()=>{
  const offline=await nativeRequest(async()=>{throw new TypeError('fetch failed');});
  assert.deepEqual(await offline('/api/mvp/health'),{error:'Сервер недоступен. Запустите сервер Гаргантюа и повторите.',status:0,code:'SERVER_OFFLINE'});
  const invalid=await nativeRequest(async()=>new Response('invalid source response',{status:502}));
  assert.deepEqual(await invalid('/api/mvp/health'),{error:'Сервер вернул некорректный ответ',status:502,code:'SOURCE_FORMAT'});
});
