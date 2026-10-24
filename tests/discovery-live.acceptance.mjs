// Opt-in metadata-only acceptance. No DB, book download, credentials or app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createDiscoverySearch,canContinueDiscoveryPlan} from '../server/discovery-providers.mjs';
import {fetchSafe} from '../server/fetch.mjs';
if(process.env.GARGANTUA_METADATA_PROBE!=='1')throw Error('Explicit metadata-only probe opt-in required');
const transportDiagnostics=[],results=[];
const search=createDiscoverySearch({fetchSafe:async(value,options)=>{const started=Date.now(),provider=new URL(value).hostname;try{const response=await fetchSafe(value,options);transportDiagnostics.push({provider,code:'OK',bytes:response.buffer.length,ms:Date.now()-started});return response;}catch(error){transportDiagnostics.push({provider,code:/^[A-Z0-9_]{1,64}$/.test(error?.code??'')?error.code:'UNKNOWN',httpStatus:Number.isSafeInteger(error?.httpStatus)?error.httpStatus:null,ms:Date.now()-started});throw error;}}});
const report={scope:'LIVE_PUBLIC_METADATA_ONLY_NO_PRODUCTION_DATABASE_OR_BOOK_TEXT',startedAt:new Date().toISOString(),ok:false,results,transportDiagnostics,limitations:['Provider availability and metadata can change.','A catalogue record is not a downloadable book, a complete bibliography or verified translation.','Generic source series positions do not prove recommended reading order.','No malware scan, translation, audio or native client is exercised by this probe.']};
async function probe(name,query,options={}){
 const result=await search(query,{language:'ru',allowOriginal:true,...options});
 assert.ok(result.requestCount<=4);assert.ok(result.candidates.length<=20);
 for(const candidate of result.candidates)assert.ok(['library','openlibrary','gutendex','ranobelib','curated'].includes(candidate.identity.provider));
 results.push({name,query,status:result.status,requestCount:result.requestCount,retryCount:result.retryCount,cacheHits:result.cacheHits,hasMore:result.hasMore,selectedCandidateId:result.selectedCandidateId,clarifications:result.clarifications,providerErrors:result.providerErrors,sourceResolutionFor:result.sourceResolutionFor??null,plan:result.plan,candidates:result.candidates.map(({id,identity,kind,title,authors,topWork,birthDate,availability,languages,languageEvidence,sourceResolutionAttempted,identityEvidenceIncomplete,seriesMemberships})=>({id,identity,kind,title,authors,topWork,birthDate,availability,languages,languageEvidence,sourceResolutionAttempted,identityEvidenceIncomplete,seriesMemberships}))});
 return result;
}
try{
 const rama=await probe('russian-book-title','Свидание с Рамой',{intent:'book'});
 const author=await probe('bare-author-clarification','Артур Кларк');
 const warriors=await probe('bare-series-reviewed-order','Коты-воители');
 assert.equal(warriors.requestCount,0);assert.equal(warriors.candidates.length,6);assert.deepEqual(warriors.plan.items.map(item=>item.sequence),[1,2,3,4,5,6]);assert.equal(warriors.plan.bibliographyComplete,false);
 await probe('generic-series-no-invented-reading-order','series Earthsea');
 const selectedAuthor=author.candidates.find(item=>item.kind==='author'&&item.identity.provider==='openlibrary'&&item.identity.remoteId==='OL2623461A');
 if(selectedAuthor){
  const works=await probe('explicit-author-identity-to-works',selectedAuthor.title,{intent:'author',trustedFilter:{provider:'openlibrary',kind:'author',remoteId:selectedAuthor.identity.remoteId}});
  if(canContinueDiscoveryPlan(works)){
   const next=await probe('explicit-saved-author-next-page',selectedAuthor.title,{intent:'author',continuation:works.plan.continuation});
   const old=new Set(works.candidates.filter(item=>item.kind==='book').map(item=>item.id));
   report.authorPagination={previousOffset:works.plan.continuation.offset,loadedNext:next.plan?.providerCoverage?.loaded??null,overlap:next.candidates.filter(item=>item.kind==='book'&&old.has(item.id)).length};
   assert.equal(report.authorPagination.overlap,0,'Live catalogue changed or repeated its author page; inspect before accepting pagination');
  }
 }
 const selectedWork=rama.candidates.find(item=>item.identity.provider==='openlibrary'&&item.identity.remoteId==='OL17417W');
 if(selectedWork){
  const expanded=await probe('explicit-work-identity-to-safe-source-choices',selectedWork.title,{intent:'book',expandSelectedSources:true,trustedFilter:{provider:'openlibrary',kind:'book',remoteId:selectedWork.identity.remoteId}});
  assert.ok(!expanded.candidates.some(item=>item.identity.provider==='openlibrary'&&item.availability==='fetchable'));
 }
 report.observations={canonicalClarkeSeen:Boolean(selectedAuthor),canonicalRamaSeen:Boolean(selectedWork),metadataQueries:results.length,productionAccess:false,bookDownloads:0};
 assert.ok(selectedAuthor,'Canonical Clarke absent in this live catalogue response');assert.ok(selectedWork,'Canonical Rama absent in this live catalogue response');
 report.ok=true;
}catch(error){report.error={name:error.name,code:error.code??null,message:String(error.message).slice(0,500)};process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await fs.writeFile('/probe-report/report.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({ok:report.ok,queries:results.length,observations:report.observations,error:report.error}));}
