// Explicit owner acceptance actions. Credentials and text stay out of output.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {recheckBookEpub} from './recheck-book-epub.mjs';
import {optionalAcceptanceChapterRange} from './acceptance-input.mjs';
const root=new URL('../',import.meta.url),directory=new URL('.local/real-book-acceptance/',root),stateFile=new URL('state.json',directory);
await fs.mkdir(directory,{recursive:true});
let state;try{state=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;state={schemaVersion:1,novelRequestId:'cdb0c449-8646-478d-aabf-0d906901bd90',bookTickets:{}};}
const save=async()=>fs.writeFile(stateFile,JSON.stringify(state,null,2)+'\n');
const login=JSON.parse((await fs.readFile(new URL('.local/login.txt',root),'utf8')).replace(/^\uFEFF/,''));
const response=await fetch('http://localhost:3080/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Cotology':'1'},body:JSON.stringify({login:login.login,password:login.password}),signal:AbortSignal.timeout(10000)});
assert.equal(response.status,200,'Private owner login failed');const cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);let csrf;
const api=async(route,body)=>{const result=await fetch('http://localhost:3080/api'+route,{method:body?'POST':'GET',headers:{Cookie:cookie,'X-Cotology':'1',...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(90000)});const value=await result.json();if(!result.ok)throw Object.assign(Error(value.error||'API request failed'),{status:result.status});return value;};
try{
 const me=await api('/me');csrf=me.csrf;
 const action=process.argv[2]||'status';
 if(action==='select-novel'){
  let row=await api('/discovery/requests/'+state.novelRequestId);
  assert.equal(row.requested_by,me.id);assert.equal(row.input.audio,true);
  if(row.status==='needs-review'&&!row.import_id){const candidate=row.plan?.candidates?.find(item=>item.sourceBinding?.remoteId==='168611'&&item.sourceBinding?.branchId===23137&&item.availability==='ranobe-full');assert.ok(candidate,'The requested branch is absent; no alternative will be selected');assert.ok(candidate.chapterCount>=275);state.novelSelected={candidateId:candidate.id,planRevision:row.plan_revision,chaptersAtSelection:candidate.chapterCount,branchId:23137,at:new Date().toISOString()};await save();row=await api('/discovery/requests/'+row.id+'/decision',{action:'select',expectedRevision:row.revision,planRevision:row.plan_revision,candidateId:candidate.id});}
  console.log(JSON.stringify({requestId:row.id,status:row.status,revision:row.revision,importId:row.import_id,selected:state.novelSelected}));
 }else if(action==='create-book'){
  const query=process.argv[3];assert.ok(query?.length>=2);let ticket=state.bookTickets[query];if(!ticket){ticket={idempotencyKey:randomUUID(),query,intent:'book',language:'ru',allowOriginal:true,audio:true};state.bookTickets[query]=ticket;await save();}
  const result=await api('/discovery/requests',ticket);state.bookRequestId=result.request.id;await save();console.log(JSON.stringify({requestId:result.request.id,status:result.request.status,reused:result.reused}));
 }else if(action==='import-book-file'||action==='import-book-epub'){
  const property=action==='import-book-epub'?'bookEpubImportId':'bookFileImportId';
  if(!state[property]){
   const url=action==='import-book-epub'?'https://www.gutenberg.org/ebooks/7256.epub3.images':'https://www.gutenberg.org/cache/epub/7256/pg7256.txt';
   // Recover a lost response by exact source+initiator, never blindly repost.
   const imports=await api('/imports');
   const existing=imports.find(item=>item.source_url===url&&item.requested_by===me.id&&!['cancelled','rejected'].includes(item.status));
   if(existing)state[property]=existing.id;
   else{state.bookFileIntent={url,kind:'file',filename:'The Gift of the Magi.'+(action==='import-book-epub'?'epub':'txt')};await save();const imported=await api('/imports/link',state.bookFileIntent);state[property]=imported.id;}
   await save();
  }
  console.log(JSON.stringify({importId:state[property]}));
 }else if(action==='recheck-book-epub'){
  const result=await recheckBookEpub({api,me,state,directory,stateFile});console.log(JSON.stringify(result));
 }else if(action==='refine-book'){
  const query=process.argv[3],chapterRange=optionalAcceptanceChapterRange(process.argv.slice(4)),row=await api('/discovery/requests/'+state.bookRequestId);assert.ok(query?.length>=2);assert.equal(row.import_id,null);
  const result=await api('/discovery/requests/'+row.id+'/decision',{action:'refine',expectedRevision:row.revision,query,intent:'book',language:'ru',allowOriginal:true,audio:true,...(chapterRange?{chapterRange}:{})});
  console.log(JSON.stringify({requestId:result.id,status:result.status,query:result.query_text}));
 }else if(action==='select-book'){
  const candidateId=process.argv[3],row=await api('/discovery/requests/'+state.bookRequestId);assert.ok(row.plan?.candidates?.some(candidate=>candidate.id===candidateId));
  const result=await api('/discovery/requests/'+row.id+'/decision',{action:'select',expectedRevision:row.revision,planRevision:row.plan_revision,candidateId});console.log(JSON.stringify({requestId:result.id,status:result.status}));
 }else if(action==='retry-novel-import'){
  const row=await api('/discovery/requests/'+state.novelRequestId);assert.ok(row.import_id);const result=await api('/imports/'+row.import_id+'/decision',{action:'retry',reason:'Owner acceptance: supported Ranobe document nodes fixed and regression-tested; repeat all quarantine and identity gates'});console.log(JSON.stringify({importId:row.import_id,result}));
 }else if(action==='status'){
  const requests=[];for(const id of [state.novelRequestId,state.bookRequestId].filter(Boolean)){const row=await api('/discovery/requests/'+id);requests.push({id:row.id,query:row.query_text,status:row.status,revision:row.revision,planRevision:row.plan_revision,importId:row.import_id,error:row.error,outputs:row.outputs,candidates:row.plan?.candidates?.map(item=>({id:item.id,title:item.title,authors:item.authors,kind:item.kind,provider:item.identity?.provider,availability:item.availability,branchId:item.sourceBinding?.branchId,chapters:item.chapterCount,blockedReason:item.blockedReason}))});}
  const imports=(await api('/imports')).filter(row=>[state.bookFileImportId,state.bookEpubImportId,state.bookEpubRecheckImportId,...requests.map(request=>request.importId)].includes(row.id)).map(row=>({id:row.id,status:row.status,stage:row.stage,bookId:row.book_id,securityState:row.security_state,error:row.error}));
  const value={at:new Date().toISOString(),requests,imports};await fs.writeFile(new URL('latest-status.json',directory),JSON.stringify(value,null,2)+'\n');console.log(JSON.stringify(value));
 }else throw Error('Supported actions: select-novel, create-book <title>, import-book-file, import-book-epub, recheck-book-epub, refine-book <title> [start count], select-book <candidateId>, retry-novel-import, status');
}finally{if(csrf)await api('/logout',{}).catch(()=>{});}
