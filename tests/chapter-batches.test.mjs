import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chapterRangeInput,chapterRangeInfo,chapterBatchLabel,chapterBatchInput,nextChapterBatch,reserveChapterBatch} from '../src/chapter-batches.mjs';
import {discoveryInput,discoveryOutput,reserveDiscoverySubmission} from '../src/discovery-client.mjs';
import {audioRequestRows} from '../src/audio-requests.mjs';
const source=(extra={})=>({id:randomUUID(),jobId:randomUUID(),requestedBy:randomUUID(),kind:'translation',sourceLanguage:'en',publicationIds:[randomUUID(),randomUUID()],snapshotId:randomUUID(),chapterRange:{start:1,count:5,total:275,hasMore:true,nextStart:6},audio:true,...extra});
test('new batches default to five and never accept fractional negative unknown or oversized input',()=>{
 assert.deepEqual(chapterRangeInput(),{start:1,count:5});assert.equal(chapterRangeInput({start:21,count:50},{kind:'audio'}).count,50);
 for(const kind of ['translation','discovery'])assert.throws(()=>chapterRangeInput({start:1,count:6},{kind}));
 for(const value of [{start:0,count:5},{start:1.5,count:5},{start:1,count:'5'},{start:1,count:0},{start:20001,count:1},{start:1,count:5,url:'https://untrusted.test'},null])assert.throws(()=>chapterRangeInput(value));
});
test('displayed range includes total and rejects inconsistent continuation coordinates',()=>{
 assert.equal(chapterBatchLabel({chapterRange:source().chapterRange}),'Главы 1–5 из 275');assert.equal(chapterBatchLabel({chapterRange:{start:1,count:275,total:275,hasMore:false,nextStart:null}}),'Главы 1–275 из 275');
 assert.equal(chapterBatchLabel({originChapterRange:{start:6,count:5,total:275,hasMore:true,nextStart:11},chapterRange:{start:1,count:5,total:5,hasMore:false,nextStart:null}}),'Главы 6–10 из 275');
 for(const extra of [{nextStart:7},{hasMore:false},{total:4},{count:0}])assert.throws(()=>chapterRangeInfo({...source().chapterRange,...extra}));
});
test('next batch pins the same ordered physical sources and snapshot and starts at six',()=>{
 const row=source(),body=nextChapterBatch(row);assert.deepEqual(body.publicationIds,row.publicationIds);assert.equal(body.snapshotId,row.snapshotId);assert.deepEqual(body.chapterRange,{start:6,count:5});assert.equal(body.kind,'translation');assert.equal(body.audio,true);
 assert.throws(()=>nextChapterBatch({...row,chapterRange:{start:271,count:5,total:275,hasMore:false,nextStart:null}}));
});
test('next batch of translated audio refers to its exact original translation parent',()=>{
 const parent=source(),child=source({kind:'audio',sourceLanguage:'ru',parentRequestId:parent.id,parentJobId:parent.jobId,requestedBy:parent.requestedBy,originChapterRange:parent.chapterRange,chapterRange:{start:1,count:5,total:5,hasMore:false,nextStart:null}});
 const body=nextChapterBatch(child,{parents:[parent]});assert.equal(body.kind,'translation');assert.deepEqual(body.publicationIds,parent.publicationIds);assert.deepEqual(body.chapterRange,{start:6,count:5});
 for(const parents of [[],[{...parent,requestedBy:randomUUID()}],[{...parent,jobId:randomUUID()}]])assert.throws(()=>nextChapterBatch(child,{parents}));
});
test('batch identity excludes untrusted source URLs and preserves strict language routing',()=>{
 const row=source({url:'https://untrusted.test',recipeSha256:'fake'});assert.equal('url' in chapterBatchInput(row),false);assert.equal('recipeSha256' in chapterBatchInput(row),false);
 for(const extra of [{kind:'audio',sourceLanguage:'en'},{sourceLanguage:'ru'},{publicationIds:['fake']},{publicationIds:[row.publicationIds[0],row.publicationIds[0]]}])assert.throws(()=>chapterBatchInput({...row,...extra}));
});
test('durable batch tickets survive retries while changed range snapshot profile and server stay distinct',async()=>{
 const entries=new Map(),storage={get:async key=>entries.get(key),put:async(key,value)=>entries.set(key,value)},profileId=randomUUID(),scope={profileId,serverIdentity:'http://localhost:3080'},row=source();
 const first=await reserveChapterBatch(storage,scope,row),again=await reserveChapterBatch(storage,scope,row);assert.deepEqual(again,first);
 for(const [scopeChange,input]of [[scope,{...row,chapterRange:{start:6,count:5}}],[scope,{...row,snapshotId:randomUUID()}],[{...scope,profileId:randomUUID()},row],[{...scope,serverIdentity:'https://different.test'},row]])assert.notEqual((await reserveChapterBatch(storage,scopeChange,input)).body.idempotencyKey,first.body.idempotencyKey);
 entries.set(first.key,{...first.body,idempotencyKey:'broken'});await assert.rejects(()=>reserveChapterBatch(storage,scope,row),{code:'CHAPTER_BATCH_INPUT'});
});
test('concurrent double taps reserve one durable batch intent',async()=>{
 const entries=new Map();let writes=0;const storage={get:async key=>entries.get(key),put:async(key,value)=>{await new Promise(resolve=>setTimeout(resolve,5));entries.set(key,value);writes++;}},scope={profileId:randomUUID(),serverIdentity:'http://localhost:3080'},input=source();
 const reserved=await Promise.all(Array.from({length:8},()=>reserveChapterBatch(storage,scope,input)));assert.equal(writes,1);assert.equal(new Set(reserved.map(row=>row.body.idempotencyKey)).size,1);
});
test('discovery preserves explicit chapter choices and reports a ready batch separately from the complete text',async()=>{
 const input=discoveryInput({query:'Цивилизация Мудрецов',chapterRange:{start:6,count:5}});assert.deepEqual(input.chapterRange,{start:6,count:5});assert.equal('chapterRange' in discoveryInput({query:'Old request'}),false);
 for(const chapterRange of [{start:0,count:5},{start:1,count:6},{start:1,count:5,sourceUrl:'https://untrusted.test'}])assert.throws(()=>discoveryInput({query:'Book',chapterRange}));
 const range={start:6,count:5,total:275,hasMore:true,nextStart:11},output=discoveryOutput({outputs:{book:{status:'ready',publicationId:randomUUID()},translation:{status:'not-required'},audio:{status:'ready',chapterRange:range}}});assert.equal(output.ready,true);assert.equal(output.audioReady,true);assert.ok(output.audio.includes('Главы 6–10 из 275'));
 const entries=new Map(),storage={get:async key=>entries.get(key),put:async(key,value)=>entries.set(key,value)},owner=randomUUID();const a=await reserveDiscoverySubmission(storage,owner,input,randomUUID,'http://localhost:3080'),b=await reserveDiscoverySubmission(storage,owner,{...input,chapterRange:{start:11,count:5}},randomUUID,'http://localhost:3080');assert.notEqual(a.body.idempotencyKey,b.body.idempotencyKey);
});
test('the visible audio continuation retains only its exact translation parent context',()=>{
 const parent=source({status:'completed',jobStatus:'completed',revision:1,updatedAt:'2026-10-23T00:00:00Z'}),child=source({kind:'audio',status:'completed',jobStatus:'completed',sourceLanguage:'ru',requestedBy:parent.requestedBy,parentRequestId:parent.id,parentJobId:parent.jobId,originChapterRange:parent.chapterRange,chapterRange:{start:1,count:5,total:5,hasMore:false,nextStart:null},revision:1,updatedAt:'2026-10-23T00:00:00Z'});
 const rows=audioRequestRows([parent,child],{profileId:parent.requestedBy});assert.equal(rows.length,1);assert.deepEqual(rows[0].continuationParent,parent);assert.deepEqual(nextChapterBatch(rows[0],{parents:[rows[0].continuationParent]}).publicationIds,parent.publicationIds);
 const wrong={...parent,requestedBy:randomUUID()};assert.equal(audioRequestRows([wrong,child]).find(row=>row.jobId===child.jobId).continuationParent,undefined);
});
