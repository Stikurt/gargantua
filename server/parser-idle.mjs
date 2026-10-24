import fs from 'node:fs/promises';
import path from 'node:path';

// Parser children have a 40-second hard deadline. Cancellation can remove a
// pending file before a child exits, so absence alone is not an idle proof.
export function createParserIdleBarrier({now=Date.now,settleMs=45000}={}){
 let busyAt=now();
 const markBusy=()=>{busyAt=now();};
 return {markBusy,async allowed(jobs){
  try{
   const root=path.join(jobs,'pending');for(const name of ['pending','results']){const stat=await fs.lstat(path.join(jobs,name));if(!stat.isDirectory()||stat.isSymbolicLink())return false;}
   const entries=await fs.opendir(root);let visited=0;
   for await(const entry of entries){
    if(++visited>10000){markBusy();return false;}
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/.test(entry.name))continue;
    let result;try{result=await fs.lstat(path.join(jobs,'results',entry.name));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!entry.isFile()||entry.isSymbolicLink()||!result?.isFile()||result.isSymbolicLink()){markBusy();return false;}
   }
   return now()-busyAt>=settleMs;
  }catch{markBusy();return false;}
 }};
}
