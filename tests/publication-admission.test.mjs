// Real HTTP and aborted sockets against Express. No database or book bytes.
import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import express from 'express';
import {publicationAdmission,publicationHandler,publicationWork} from '../server/publication-admission.mjs';

const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const fixtures=[];
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
async function fixture(){
 const app=express(),holds=new Map(),rawEntered=gate(),rawClosed=gate();let parsersEntered=0;
 const auth=(req,res,next)=>req.get('Authorization')==='fixture'?next():res.status(401).json({error:'fixture auth'});
 const held=key=>{if(!holds.has(key))holds.set(key,{entered:gate(),release:gate(),finished:gate(),started:false});return holds.get(key);};
 app.get('/hold/:key',auth,...publicationWork(wrap,async(req,res)=>{
  const item=held(req.params.key);item.started=true;item.entered.resolve();
  try{await item.release.promise;if(!res.destroyed)res.json({ok:true});}finally{item.finished.resolve();}
 }));
 app.get('/finish/:key',auth,...publicationWork(wrap,async(req,res)=>{
  const item=held(req.params.key);item.started=true;item.entered.resolve();res.json({ok:true});
  try{await item.release.promise;}finally{item.finished.resolve();}
 }));
 app.get('/quick',auth,...publicationWork(wrap,async(_req,res)=>res.json({ok:true})));
 app.get('/throw',auth,...publicationWork(wrap,async()=>{throw Object.assign(new Error('fixture failure'),{status:418});}));
 app.post('/json',auth,publicationAdmission,(_req,_res,next)=>{parsersEntered++;next();},express.json({limit:'64b'}),publicationHandler(wrap,async(_req,res)=>res.json({ok:true})));
 app.post('/raw',auth,publicationAdmission,(_req,res,next)=>{parsersEntered++;res.once('close',()=>rawClosed.resolve());rawEntered.resolve();next();},express.raw({type:'application/json',limit:'64b'}),publicationHandler(wrap,async(_req,res)=>res.json({ok:true})));
 app.use((error,_req,res,_next)=>{if(!res.destroyed)res.status(error.status||500).json({error:error.message});});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const request=(url,options={})=>fetch(base+url,{...options,headers:{Authorization:'fixture',...options.headers}});
 const value={server,holds,held,request,base,rawEntered,rawClosed,parsersEntered:()=>parsersEntered};fixtures.push(value);return value;
}
afterEach(async()=>{
 for(const value of fixtures.splice(0)){
  for(const hold of value.holds.values())hold.release.resolve();
  await Promise.all([...value.holds.values()].filter(hold=>hold.started).map(hold=>hold.finished.promise));
  await new Promise(resolve=>setImmediate(resolve));value.server.closeAllConnections();await new Promise(resolve=>value.server.close(resolve));
 }
});
async function openHold(value,key,options={}){
 const pending=value.request('/hold/'+key,options);pending.catch(()=>{});await value.held(key).entered.promise;return {pending,item:value.held(key)};
}

test('two shared leases admit work across separate apps; the third gets429 before its handler',async()=>{
 const one=await fixture(),two=await fixture(),first=await openHold(one,'first'),second=await openHold(two,'second');
 assert.equal((await one.request('/quick')).status,429);assert.equal((await two.request('/quick')).status,429);
 first.item.release.resolve();assert.equal((await first.pending).status,200);assert.equal((await one.request('/quick')).status,200);
 second.item.release.resolve();assert.equal((await second.pending).status,200);
});
test('aborted response keeps the lease until asynchronous work actually settles',async()=>{
 const value=await fixture(),controller=new AbortController(),first=await openHold(value,'aborted',{signal:controller.signal}),second=await openHold(value,'live');
 controller.abort();await assert.rejects(first.pending,error=>error.name==='AbortError');
 assert.equal((await value.request('/quick')).status,429,'disconnect must not free the running task');
 first.item.release.resolve();await first.item.finished.promise;await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await value.request('/quick')).status,200);
 second.item.release.resolve();assert.equal((await second.pending).status,200);
});
test('a completed HTTP response does not release still-running post-response work',async()=>{
 const value=await fixture(),first=value.request('/finish/early');await value.held('early').entered.promise;assert.equal((await first).status,200);
 const second=await openHold(value,'other');assert.equal((await value.request('/quick')).status,429);
 value.held('early').release.resolve();await value.held('early').finished.promise;await new Promise(resolve=>setImmediate(resolve));assert.equal((await value.request('/quick')).status,200);
 second.item.release.resolve();await second.pending;
});
test('throwing handlers release exactly once and repeated failures do not leak admission',async()=>{
 const value=await fixture();for(let attempt=0;attempt<4;attempt++)assert.equal((await value.request('/throw')).status,418);
 const first=await openHold(value,'first'),second=await openHold(value,'second');assert.equal((await value.request('/quick')).status,429);
 first.item.release.resolve();second.item.release.resolve();await Promise.all([first.pending,second.pending]);assert.equal((await value.request('/quick')).status,200);
});
test('body-parser syntax and size failures release before the handler begins',async()=>{
 const value=await fixture();
 assert.equal((await value.request('/json',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"broken":'})).status,400);
 assert.equal((await value.request('/json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({long:'x'.repeat(100)})})).status,413);
 const first=await openHold(value,'first'),second=await openHold(value,'second');assert.equal((await value.request('/quick')).status,429);
 first.item.release.resolve();second.item.release.resolve();await Promise.all([first.pending,second.pending]);
});
test('admission precedes raw parsing and authentication precedes admission',async()=>{
 const value=await fixture(),first=await openHold(value,'first'),second=await openHold(value,'second');
 assert.equal((await value.request('/quick',{headers:{Authorization:''}})).status,401);
 assert.equal((await value.request('/raw',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(100)})).status,429);assert.equal(value.parsersEntered(),0);
 first.item.release.resolve();second.item.release.resolve();await Promise.all([first.pending,second.pending]);
 assert.equal((await value.request('/raw',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);assert.equal(value.parsersEntered(),1);
});
test('socket abort during raw parsing releases an unstarted lease',async()=>{
 const value=await fixture(),request=http.request(value.base+'/raw',{method:'POST',headers:{Authorization:'fixture','Content-Type':'application/json','Content-Length':'40'}});request.on('error',()=>{});request.write('{');
 await value.rawEntered.promise;request.destroy();await value.rawClosed.promise;
 const first=await openHold(value,'first'),second=await openHold(value,'second');assert.equal((await value.request('/quick')).status,429);
 first.item.release.resolve();second.item.release.resolve();await Promise.all([first.pending,second.pending]);assert.equal((await value.request('/quick')).status,200);
});
