// Opt-in public metadata probe. It never opens the DB, app credentials or book text.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createDiscoverySearch} from '../server/discovery-providers.mjs';
import {createRanobeAdapter} from '../server/ranobe.mjs';
import {fetchSafe} from '../server/fetch.mjs';

if(process.env.GARGANTUA_METADATA_PROBE!=='1')throw Error('Explicit metadata-only opt-in required');
const query=process.env.GARGANTUA_METADATA_QUERY??'цивилизация мудрецов';
const directory=process.env.GARGANTUA_METADATA_REPORT??'/probe-report';
const transport=[];
const safeTransport=async(value,options)=>{
 const started=Date.now(),url=new URL(value);
 try{const response=await fetchSafe(value,options);const diagnostic={host:url.hostname,path:url.pathname,bytes:response.buffer.length,milliseconds:Date.now()-started,ok:true};
  if(url.hostname==='api.cdnlibs.org'&&url.pathname.includes('/api/manga/')){try{const json=JSON.parse(response.buffer.toString('utf8'));diagnostic.envelopeKeys=Object.keys(json);diagnostic.meta=json.meta??null;diagnostic.links=json.links??null;diagnostic.dataCount=Array.isArray(json.data)?json.data.length:null;diagnostic.cardCounts=!Array.isArray(json.data)?{items_count:json.data?.items_count??null,chap_count:json.data?.chap_count??null,chapters_count:json.data?.chapters_count??null}:null;}catch{}}
  if(url.hostname==='api.cdnlibs.org'&&url.pathname.endsWith('/chapters')){try{const json=JSON.parse(response.buffer.toString('utf8')),branches=new Map();for(const item of json.data??[])for(const branch of item.branches??[]){const key=String(branch.branch_id??'default'),row=branches.get(key)??{id:key,count:0,flags:{},first:[],last:[]};row.count++;for(const flag of ['is_licensed','is_locked','is_restricted','is_paid','is_deleted','is_blocked','blocked','expired_type','price'])if(branch[flag]!==undefined){const value=String(branch[flag]);row.flags[flag+':'+value]=(row.flags[flag+':'+value]??0)+1;}const coordinate={volume:item.volume,number:item.number};if(row.first.length<3)row.first.push(coordinate);row.last=[...row.last.slice(-2),coordinate];branches.set(key,row);}diagnostic.branchCounts=[...branches.values()];diagnostic.chapterFieldKeys=[...new Set((json.data??[]).flatMap(Object.keys))];}catch{}}
  transport.push(diagnostic);return response;}
 catch(error){transport.push({host:url.hostname,path:url.pathname,milliseconds:Date.now()-started,ok:false,code:String(error.code??'UNKNOWN').slice(0,64),httpStatus:error.httpStatus??null});throw error;}
};
const report={schemaVersion:1,startedAt:new Date().toISOString(),scope:'PUBLIC_METADATA_ONLY',productionAccess:false,credentialsUsed:false,bookTextRequests:0,query,queryCompleted:false,ranobeMatchFound:false,sourceMetadataVerified:false,transport};
report.sourceFingerprints={};for(const name of ['ranobe.mjs','discovery-providers.mjs'])report.sourceFingerprints['server/'+name]=createHash('sha256').update(await fs.readFile(new URL('../server/'+name,import.meta.url))).digest('hex');
try{
 const search=createDiscoverySearch({fetchSafe:safeTransport});
 const known=process.env.GARGANTUA_KNOWN_RANOBE_METADATA==='1';
 const result=known?{requestCount:0,candidates:[{identity:{provider:'ranobelib',remoteId:'168611'},title:'Цивилизация Мудрецов',sourceBinding:{url:'https://ranobelib.me/ru/book/168611--seulgiloun-munmyeongsaenghwal'}}]}:await search(query,{intent:'book',language:'ru',allowOriginal:true,maxRequests:4,timeoutMs:45000});
 assert.ok(result.requestCount<=4);assert.ok(result.candidates.length<=20);
 report.queryCompleted=!known;report.plan=result;
 const normalized=value=>value.toLowerCase().replace(/ё/gu,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 const candidate=result.candidates.find(row=>row.identity.provider==='ranobelib'&&normalized(row.title)===normalized(query));
 report.ranobeMatchFound=Boolean(candidate);
 if(candidate){
  const adapter=createRanobeAdapter({fetchSafe:safeTransport});
  const info=await adapter.resolveRanobe(candidate.sourceBinding.url,{timeoutMs:45000});
  assert.equal(info.workId,candidate.identity.remoteId);
  report.sourceMetadataVerified=true;
  report.ranobe={workId:info.workId,slug:info.slug,title:info.title,author:info.author,chapters:info.chapters,language:info.language,completeness:info.completeness,inventorySha256:info.inventorySha256,branches:info.branches};
 }
}catch(error){report.error={code:String(error.code??'UNKNOWN').slice(0,64),message:String(error.message).slice(0,500)};process.exitCode=1;}
finally{
 report.finishedAt=new Date().toISOString();
 await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({queryCompleted:report.queryCompleted,ranobeMatchFound:report.ranobeMatchFound,sourceMetadataVerified:report.sourceMetadataVerified,requests:transport.length,error:report.error??null}));
}
