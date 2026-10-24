import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makeDerivedPlan,makeDerivedPlanStreaming,translatedBooks,sourceUnit,assertDerivedPartBudget,assertDerivedManifestBudget} from '../server/derived-plan.mjs';
import {canonicalJson} from '../server/publication-model.mjs';
import {verifyInferenceReceipt,executorIsIdle} from '../server/derived-spool.mjs';
import {validateDerivedManifest} from '../server/derived-files.mjs';

const source={sha256:'a'.repeat(64),parts:[{id:randomUUID()},{id:randomUUID()}]};
const book=(text,title='Chapter')=>({title:'Original',author:'Author',language:'en',assets:{},chapters:[{title,blocks:[{type:'text',text}]}]});
test('streaming planning equals whole-source planning including Unicode offsets and stable IDs',async()=>{
 const contents=[book(' 😀 words '.repeat(170)),book('Other\n\nparagraph.\t'.repeat(110))],reads=[];
 const full=makeDerivedPlan(source,contents,'translation'),streamed=await makeDerivedPlanStreaming(source,async i=>{reads.push(i);return contents[i];},'translation');
 assert.deepEqual(reads,[0,1]);assert.deepEqual(streamed,full);
 for(const unit of full.manifest.segments)assert.ok(Array.from(sourceUnit(contents,unit)).length<=700);
});
test('reassembly preserves whitespace on chunk seams and original bytes',()=>{
 const contents=[book('word '.repeat(400))],src={...source,parts:[source.parts[0]]},before=canonicalJson(contents),plan=makeDerivedPlan(src,contents,'translation').manifest;
 const translated=translatedBooks(src,contents,plan,plan.segments.map(unit=>sourceUnit(contents,unit).trim()));
 assert.equal(canonicalJson(contents),before);assert.equal(translated[0].chapters[0].blocks[0].text,contents[0].chapters[0].blocks[0].text);
});
test('completion receipts cannot bypass stopped-container proof with empty cleanup',()=>{
 const request={jobId:randomUUID(),attemptId:randomUUID(),segmentId:randomUUID(),kind:'translation',profile:'fixed',profileSha256:'b'.repeat(64),recipeSha256:'c'.repeat(64),inputSha256:'d'.repeat(64)},hash='e'.repeat(64),provider='f'.repeat(64);
 const receipt={...request,schemaVersion:1,status:'completed',requestSha256:hash,providerRecipeSha256:provider,cleanupVerified:true,cleanup:[]};
 assert.throws(()=>verifyInferenceReceipt(receipt,request,hash,provider),{code:'DERIVED_EXECUTOR_UNSAFE'});
 assert.equal(verifyInferenceReceipt({...receipt,cleanup:[{verifiedStopped:true}]},request,hash,provider).status,'completed');
 assert.equal(verifyInferenceReceipt({...receipt,status:'paused'},request,hash,provider).status,'paused');
 assert.throws(()=>verifyInferenceReceipt({...receipt,attemptId:randomUUID()},request,hash,provider),{code:'DERIVED_OUTPUT'});
});
test('final manifest validates types and provenance before touching its segment list',()=>{
 for(const value of [null,{},[],{schemaVersion:1,jobId:source.parts[0].id,segments:{}},{schemaVersion:1,jobId:source.parts[0].id,segments:[]}])assert.throws(()=>validateDerivedManifest(value,source.parts[0].id),{code:'DERIVED_INTEGRITY'});
});
test('publication memory budget rejects expansion before allocating model output buffers',()=>{
 assert.deepEqual(assertDerivedPartBudget({content_bytes:'1024'},[{output_bytes:'4096'}]),{sourceBytes:1024,outputBytes:4096});
 for(const [source,output] of [[1024,8*1024*1024+1],[31*1024*1024,1024*1024],[NaN,10],[1024,Infinity],[1024,-1]])assert.throws(()=>assertDerivedPartBudget({content_bytes:source},[{output_bytes:output}]),{code:'DERIVED_RESULT_TOO_LARGE'});
});
test('idle proof requires a real fresh timestamp and rejects clock skew or missing metrics',()=>{
 const good={schemaVersion:1,state:'idle',cleanupVerified:true,updatedAt:100000};assert.equal(executorIsIdle(good,100001),true);
 for(const change of [{updatedAt:undefined},{updatedAt:'100000'},{updatedAt:NaN},{updatedAt:200000},{updatedAt:0},{state:'running'},{cleanupVerified:false}])assert.equal(executorIsIdle({...good,...change},100001),false);
});
test('manifest budget rejects an unpublishable large plan before any generation',()=>{
 assert.doesNotThrow(()=>assertDerivedManifestBudget({segments:{length:8000}},1));
 for(const [segments,parts] of [[10000,1],[0,1],[8000,20000],[8000,0]])assert.throws(()=>assertDerivedManifestBudget({segments:{length:segments}},parts),{code:'DERIVED_MANIFEST_TOO_LARGE'});
});
