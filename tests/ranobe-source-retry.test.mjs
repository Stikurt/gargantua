import test from 'node:test';
import assert from 'node:assert/strict';
import {retryRanobeSource} from '../server/ranobe-source-retry.mjs';
const error=(code,extra={})=>Object.assign(new Error(code),{code,...extra});
test('transient source failures retry with bounded backoff and preserve progress report',async()=>{
 let calls=0,allowed=0;const waits=[],report={};
 const value=await retryRanobeSource(async()=>{if(++calls<4)throw error('RANOBE_UNAVAILABLE',{transient:true});return 'safe response';},{allowed:async()=>{allowed++;},wait:async ms=>waits.push(ms),report});
 assert.equal(value,'safe response');assert.equal(calls,4);assert.deepEqual(waits,[2000,8000,20000]);assert.equal(report.sourceRetryCount,3);assert.equal(allowed,7);
});
test('permanent access, identity, response, threat and unknown failures never retry',async()=>{
 for(const failure of [error('RANOBE_RESTRICTED'),error('RANOBE_IDENTITY'),error('RANOBE_RESPONSE'),error('SCAN_THREAT',{threat:true}),error('RANOBE_UNAVAILABLE'),error('FETCH_SSRF')]){
  let calls=0;await assert.rejects(()=>retryRanobeSource(async()=>{calls++;throw failure;},{wait:async()=>assert.fail('must not wait')}),e=>e===failure);assert.equal(calls,1);
 }
});
test('timeout retry exhausts at four calls while cancellation and revoked permissions stop it',async()=>{
 let calls=0;await assert.rejects(()=>retryRanobeSource(async()=>{calls++;throw error('RANOBE_TIMEOUT');},{wait:async()=>{}}),{code:'RANOBE_TIMEOUT'});assert.equal(calls,4);
 const control=new AbortController();calls=0;
 await assert.rejects(()=>retryRanobeSource(async()=>{calls++;throw error('RANOBE_TIMEOUT');},{signal:control.signal,wait:async()=>control.abort(error('ABORTED'))}),{code:'ABORTED'});assert.equal(calls,1);
 calls=0;let allowed=0;await assert.rejects(()=>retryRanobeSource(async()=>{calls++;throw error('RANOBE_TIMEOUT');},{allowed:async()=>{if(++allowed>1)throw error('APPROVAL_REVOKED');},wait:async()=>{}}),{code:'APPROVAL_REVOKED'});assert.equal(calls,1);
});
