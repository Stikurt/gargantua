// Verifies a request created through the ordinary Windows UI. Authentication
// stays private; this probe never chooses a source, imports or starts inference.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const requestId=process.argv[2];
assert.match(requestId??'',/^[a-f0-9-]{36}$/);
const root=new URL('../',import.meta.url),target=new URL('.local/test-results/c2-release/live-client-search.json',root);
const credentials=JSON.parse((await fs.readFile(new URL('.local/login.txt',root),'utf8')).replace(/^\uFEFF/,''));
const response=await fetch('http://localhost:3080/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Cotology':'1'},body:JSON.stringify({login:credentials.login,password:credentials.password}),signal:AbortSignal.timeout(10000)});
assert.equal(response.status,200,'Private release login failed');
const cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);let csrf;
try{
 const get=async route=>{const result=await fetch('http://localhost:3080/api'+route,{headers:{Cookie:cookie},signal:AbortSignal.timeout(15000)});assert.equal(result.status,200,route);return result.json();};
 const me=await get('/me');csrf=me.csrf;
 const row=await get('/discovery/requests/'+requestId),books=await get('/books');
 assert.equal(row.query_text,'цивилизация мудрецов');assert.equal(row.requested_by,me.id);assert.equal(row.input.audio,true);assert.equal(row.status,'needs-review');assert.equal(row.import_id,null);
 const branches=row.plan.candidates.filter(candidate=>candidate.identity?.provider==='ranobelib'&&candidate.availability==='ranobe-full');
 assert.equal(branches.length,3);
 assert.deepEqual(branches.map(candidate=>candidate.sourceBinding.branchId).sort((a,b)=>a-b),[18378,18379,23137]);
 // A live source can publish another chapter between two acceptance runs.
 // Bind to branch identity and its verified inventory, not yesterday's count.
 for(const branch of branches)assert.ok(Number.isSafeInteger(branch.chapterCount)&&branch.chapterCount>0&&branch.chapterCount<=branch.sourceBinding.completeness.received);
 const main=branches.find(branch=>branch.sourceBinding.branchId===23137);assert.equal(main.chapterCount,main.sourceBinding.completeness.received);
 for(const branch of branches){assert.equal(branch.sourceBinding.remoteId,'168611');assert.equal(branch.sourceBinding.completeness.verified,true);assert.equal(branch.sourceBinding.completeness.originalWorkComplete,false);}
 const report={status:'passed',at:new Date().toISOString(),scope:'ORDINARY_INSTALLED_WINDOWS_UI_REQUEST_PLUS_READONLY_PRODUCTION_API',requestId,query:row.query_text,statusOnServer:row.status,initiatorMatchesSignedInProfile:true,audioRequested:true,branches:branches.map(candidate=>({title:candidate.title,label:candidate.branchLabel,chapters:candidate.chapterCount,branchId:candidate.sourceBinding.branchId})),sourceTextDownloaded:false,importId:null,inferenceStarted:false,productionBooks:books.length,selectionLeftToReader:true};
 await fs.mkdir(new URL('.local/test-results/c2-release/',root),{recursive:true});await fs.writeFile(target,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(csrf)await fetch('http://localhost:3080/api/logout',{method:'POST',headers:{Cookie:cookie,'X-Cotology':'1','X-CSRF-Token':csrf},signal:AbortSignal.timeout(10000)});}
