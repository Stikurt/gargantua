import {setTimeout as delay} from 'node:timers/promises';

// Bounded, same-source recovery. No retry for identity, quarantine, redirects,
// access denial, malformed responses or unknown failures. No policy override.
export async function retryRanobeSource(operation,{signal,allowed=async()=>{},stage=async()=>{},report={},wait=ms=>delay(ms,undefined,{signal})}={}){
 const pauses=[2000,8000,20000];
 for(let attempt=0;;attempt++){
  signal?.throwIfAborted();await allowed();
  try{return await operation();}
  catch(error){
   signal?.throwIfAborted();
   if(attempt>=pauses.length||!(error.code==='RANOBE_TIMEOUT'||error.code==='RANOBE_UNAVAILABLE'&&error.transient===true))throw error;
   report.sourceRetryCount=(report.sourceRetryCount??0)+1;
   await stage(`RanobeLib: временный сбой источника, повтор ${attempt+2} из 4 через ${pauses[attempt]/1000} с`);
   await wait(pauses[attempt]);await allowed();
  }
 }
}
