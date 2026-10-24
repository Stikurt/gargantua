import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkedSpec,boundedBytes} from '../scripts/real-delivery-capture.mjs';
import {createRealDeliveryFixture,loadRealCapture} from '../scripts/real-delivery-fixture.mjs';
import {syntheticWav} from '../scripts/discovery-client-fixture.mjs';
const profile='b1000000-0000-4000-8000-000000000002',bookId='b1000000-0000-4000-8000-000000000007',jobId='b1000000-0000-4000-8000-000000000001',requestId='d1000000-0000-4000-8000-000000000001';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function fixtureCapture(action){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-real-replay-contract-')),artifacts=[];
 const store=async(relative,bytes)=>{const target=path.join(directory,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);const row={path:relative,bytes:bytes.length,sha256:sha(bytes)};artifacts.push(row);return row;};
 const content={title:'Synthetic contract publication',author:'Fixture only',language:'ru',chapters:[{title:'One',blocks:[{type:'text',text:'This is synthetic contract input, never a real book claim.'}]}],assets:{}},bookBytes=Buffer.from(JSON.stringify(content,null,2)),wav=syntheticWav();
 const book={id:bookId,title:content.title,author:content.author,language:'ru',chapter_count:1,security_state:'passed'};
 const manifest={schemaVersion:1,jobId,kind:'audio',sourceSha256:sha(bookBytes),recipeSha256:'f'.repeat(64),quality:'technical-unlistened',workId:'b1000000-0000-4000-8000-000000000003',expressionId:'b1000000-0000-4000-8000-000000000004',editionId:'b1000000-0000-4000-8000-000000000005',segments:[{ordinal:0,sha256:sha(wav),bytes:wav.length,mediaType:'audio/wav',durationSeconds:4,sampleRate:22050,url:`/api/derived/jobs/${jobId}/audio/segments/0`}]},manifestBytes=Buffer.from(JSON.stringify(manifest,null,1));
 const request={id:requestId,requested_by:profile,status:'book-ready',revision:2,plan_revision:1,query_text:'Synthetic contract publication',input:{query:'Synthetic contract publication',intent:'book',language:'ru',allowOriginal:false,audio:true},outputs:{book:{status:'ready',publicationId:bookId},translation:{status:'not-required'},audio:{status:'ready',jobId}}};
 const bookArtifact=await store('books/'+bookId+'.json',bookBytes),manifestArtifact=await store('audio/'+jobId+'/manifest.json',manifestBytes),segmentArtifact=await store('audio/'+jobId+'/0.wav',wav),requestArtifact=await store('requests/'+requestId+'.json',Buffer.from(JSON.stringify(request)));
 const capture={schemaVersion:1,kind:'gargantua-private-real-output-replay',provenance:'synthetic-contract-fixture',source:'http://127.0.0.1:3080',profileId:profile,groups:[{requestId,publicationIds:[bookId],chapterCount:1,originalChapterCount:1,translatedChapterCount:0,audioJobs:[jobId],requestArtifact}],books:[{id:bookId,metadata:book,artifact:bookArtifact,chapterCount:1,chapters:content.chapters.map(chapter=>({title:chapter.title,sha256:sha(Buffer.from(JSON.stringify(chapter)))}))}],jobs:[{id:jobId,manifestArtifact,manifestSha256:sha(manifestBytes),segmentCount:1,totalBytes:wav.length,totalDurationSeconds:4,segments:[{ordinal:0,artifact:segmentArtifact}],requests:[{id:requestId,requestedBy:profile,jobId,kind:'audio',status:'active',jobStatus:'completed'}]}],artifacts};
 const save=async()=>{const bytes=Buffer.from(JSON.stringify(capture));await fs.writeFile(path.join(directory,'capture.json'),bytes);await fs.writeFile(path.join(directory,'capture.sha256'),sha(bytes)+'  capture.json\n');};
 let replay;try{await save();await action({directory,capture,save,bookBytes,wav,manifestBytes,start:async()=>replay=await createRealDeliveryFixture({directory,allowSyntheticContract:true})});}finally{await replay?.close();await fs.rm(directory,{recursive:true,force:true});}
}
test('real-output capture requires explicit unique requests and exact expected chapter coverage',()=>{
 assert.equal(checkedSpec({schemaVersion:1,kind:'gargantua-real-delivery-spec',groups:[{requestId,expectedChapters:275}]}).groups[0].expectedChapters,275);
 for(const groups of [[],[{requestId,expectedChapters:0}],[{requestId,expectedChapters:275},{requestId,expectedChapters:275}],[{requestId,expectedChapters:275,audio:'yes'}]])assert.throws(()=>checkedSpec({schemaVersion:1,kind:'gargantua-real-delivery-spec',groups}));
});
test('capture preserves exact byte hashing and rejects unauthenticated shape, oversize, and mismatched streams',async()=>{
 const bytes=Buffer.from('exact published bytes'),headers={'x-content-sha256':sha(bytes),'content-length':String(bytes.length)};
 assert.deepEqual((await boundedBytes(new Response(bytes,{headers}),100)).bytes,bytes);
 await assert.rejects(boundedBytes(new Response(bytes,{headers:{...headers,'x-content-sha256':'0'.repeat(64)}}),100),/SHA256/);
 await assert.rejects(boundedBytes(new Response(bytes,{headers}),2),/declared size/);
 await assert.rejects(boundedBytes(new Response(bytes,{headers:{'x-content-sha256':sha(bytes)}}),2),/stream exceeds/);
 await assert.rejects(boundedBytes(new Response('{}',{status:401}),100),/unavailable/);
});
test('private replay serves exact original whitespace and binary bytes without reconstruction',()=>fixtureCapture(async({start,bookBytes,manifestBytes,wav})=>{
 const replay=await start();assert.match(replay.origin,/^http:\/\/127\.0\.0\.1:\d+$/);assert.equal(replay.loaded.verifiedFiles,4);
 for(const [route,expected] of [[`/api/books/${bookId}/download`,bookBytes],[`/api/derived/jobs/${jobId}/result`,manifestBytes],[`/api/derived/jobs/${jobId}/audio/segments/0`,wav]]){const response=await fetch(replay.origin+route),bytes=Buffer.from(await response.arrayBuffer());assert.deepEqual(bytes,expected);assert.equal(response.headers.get('x-content-sha256'),sha(expected));}
 const config=await(await fetch(replay.origin+'/api/fixture/real-delivery')).json();assert.equal(config.kind,'gargantua-real-delivery-selfcheck');assert.equal(config.groups[0].chapterCount,1);assert.equal(config.jobs[0].segmentCount,1);
 assert.equal((await fetch(replay.origin+'/api/discovery/requests',{method:'POST',body:'{}'})).status,405);assert.equal((await fetch(replay.origin+'/api/derived/requests',{method:'POST',body:'{}'})).status,405);assert.equal((await fetch(replay.origin+'/capture.json')).status,404);
}));
test('real replay refuses any modified book bytes before opening a listening socket',()=>fixtureCapture(async({directory,capture})=>{await fs.appendFile(path.join(directory,capture.books[0].artifact.path),' ');await assert.rejects(loadRealCapture(directory,{allowSyntheticContract:true}),/length mismatch/);}));
test('real replay refuses changed audio bytes even if descriptor length stays constant',()=>fixtureCapture(async({directory,capture})=>{const target=path.join(directory,capture.jobs[0].segments[0].artifact.path),bytes=await fs.readFile(target);bytes[100]^=1;await fs.writeFile(target,bytes);await assert.rejects(loadRealCapture(directory,{allowSyntheticContract:true}),/SHA mismatch/);}));
test('real replay refuses a forged group chapter total and an inventory traversal',()=>fixtureCapture(async({directory,capture,save})=>{capture.groups[0].chapterCount=275;await save();await assert.rejects(loadRealCapture(directory,{allowSyntheticContract:true}),/coverage mismatch/);capture.groups[0].chapterCount=1;capture.artifacts[0].path='../login.txt';await save();await assert.rejects(loadRealCapture(directory,{allowSyntheticContract:true}),/unsafe/);}));
test('chapter digests detect altered semantic inventory even when the outer manifest is recomputed',()=>fixtureCapture(async({directory,capture,save})=>{capture.books[0].chapters[0].sha256='0'.repeat(64);await save();await assert.rejects(loadRealCapture(directory,{allowSyntheticContract:true}),/chapter inventory mismatch/);}));
test('a synthetic contract can never be mistaken for an authenticated production output capture',()=>fixtureCapture(async({directory})=>{await assert.rejects(loadRealCapture(directory),/provenance/);}));
