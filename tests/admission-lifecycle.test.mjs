import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {acquireImportAdmission,withImportAdmission,assertImportRequestActive} from '../server/import-admission.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture({acquisitionGate,lockError}={}){
 const state={locked:false,releases:[],unlocks:0,acquired:gate()};
 const pool={connect:async()=>({
  async query(sql){
   if(sql.includes('pg_try_advisory_lock')){
    if(state.locked)return {rows:[{owned:false}]};
    state.locked=true;state.acquired.resolve();
    if(acquisitionGate)await acquisitionGate.promise;
    if(lockError)throw lockError;
    return {rows:[{owned:true}]};
   }
   if(sql.includes('pg_advisory_unlock')){state.locked=false;state.unlocks++;return {rows:[{pg_advisory_unlock:true}]};}
   throw new Error('Unexpected test SQL');
  },
  release(error){state.releases.push(error);if(error)state.locked=false;}
 })};
 const req={aborted:false,destroyed:false,complete:false},res=Object.assign(new EventEmitter(),{destroyed:false});
 return {state,pool,req,res};
}

test('disconnect during lock acquisition releases the eventual lease without entering handler',async()=>{
 const wait=gate(),f=fixture({acquisitionGate:wait});let entered=false;
 const pending=withImportAdmission(f.pool,f.req,f.res,async()=>{entered=true;});
 await f.state.acquired.promise;f.res.destroyed=true;f.res.emit('close');wait.resolve();
 await assert.rejects(pending,{status:499});assert.equal(entered,false);assert.equal(f.state.locked,false);assert.equal(f.state.unlocks,1);
});
test('response close does not release admission while a mutation is still settling',async()=>{
 const f=fixture(),started=gate(),finish=gate();let inserted=false;
 const pending=withImportAdmission(f.pool,f.req,f.res,async()=>{started.resolve();await finish.promise;inserted=true;});
 await started.promise;f.res.destroyed=true;f.res.emit('close');f.res.emit('finish');
 await assert.rejects(()=>acquireImportAdmission(f.pool),{status:429});assert.equal(f.state.unlocks,0);assert.equal(inserted,false);
 finish.resolve();await pending;assert.equal(inserted,true);assert.equal(f.state.unlocks,1);
});
test('abort after asynchronous capacity work prevents a new reservation',async()=>{
 const f=fixture(),started=gate(),capacity=gate();let inserted=false;
 const pending=withImportAdmission(f.pool,f.req,f.res,async assertActive=>{started.resolve();await capacity.promise;assertActive();inserted=true;});
 await started.promise;f.req.aborted=true;capacity.resolve();await assert.rejects(pending,{status:499});assert.equal(inserted,false);assert.equal(f.state.locked,false);
});
test('handler failures release their lease exactly once',async()=>{
 const f=fixture();await assert.rejects(()=>withImportAdmission(f.pool,f.req,f.res,async()=>{throw new Error('fixture mutation failure');}),/fixture mutation failure/);
 assert.equal(f.state.unlocks,1);assert.equal(f.state.releases.length,1);
});
test('ambiguous acquisition destroys the session instead of pooling a possible lock owner',async()=>{
 const failure=new Error('lost lock response'),f=fixture({lockError:failure});
 await assert.rejects(()=>acquireImportAdmission(f.pool),/lost lock response/);assert.equal(f.state.locked,false);assert.equal(f.state.releases[0],failure);
});
test('ordinary busy admission keeps the non-owner connection reusable',async()=>{
 const f=fixture(),release=await acquireImportAdmission(f.pool);await assert.rejects(()=>acquireImportAdmission(f.pool),{status:429});
 assert.equal(f.state.releases.length,1);assert.equal(f.state.releases[0],undefined);assert.equal(f.state.locked,true);
 await release();await release();assert.equal(f.state.unlocks,1);
});
test('fully consumed normal request is accepted but an incomplete destroyed request is rejected',()=>{
 assert.doesNotThrow(()=>assertImportRequestActive({destroyed:true,complete:true},{destroyed:false}));
 assert.throws(()=>assertImportRequestActive({destroyed:true,complete:false},{destroyed:false}),{status:499});
 assert.throws(()=>assertImportRequestActive({complete:true},{destroyed:true}),{status:499});
});
