import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createAudioClientFixture,AUDIO_FIXTURE} from '../scripts/audio-client-fixture.mjs';
import {parseAudioManifest,verifyAudioChunk} from '../src/audio.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function withFixture(action,options={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-audio-fixture-')),samplePath=path.join(directory,'sample.wav'),frames=2205,bytes=Buffer.alloc(44+frames*2);
 bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(22050,24);bytes.writeUInt32LE(44100,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);for(let i=0;i<frames;i++)bytes.writeInt16LE(Math.round(Math.sin(i/10)*2000),44+i*2);
 await fs.writeFile(samplePath,bytes);let fixture;
 try{fixture=await createAudioClientFixture({samplePath,...options});return await action(fixture,bytes);}finally{await fixture?.close();await fs.rm(directory,{recursive:true,force:true});}
}
test('isolated fixture binds a loopback public response to its exact canonical byte digest',()=>withFixture(async fixture=>{
 assert.match(fixture.origin,/^http:\/\/127\.0\.0\.1:\d+$/);
 const response=await fetch(fixture.origin+`/api/derived/jobs/${AUDIO_FIXTURE.jobId}/result`),bytes=Buffer.from(await response.arrayBuffer());
 assert.equal(response.status,200);assert.equal(response.headers.get('x-content-sha256'),hash(bytes));assert.equal(hash(bytes),fixture.manifestSha256);
 const parsed=await parseAudioManifest(bytes,{expectedSha256:fixture.manifestSha256,expectedJobId:AUDIO_FIXTURE.jobId});assert.deepEqual(parsed.manifest,fixture.manifest);
 assert.notEqual(hash(Buffer.from(JSON.stringify(parsed.manifest))),fixture.manifestSha256,'Canonical server order differs from reconstructed client key order');
 const request=(await(await fetch(fixture.origin+'/api/derived/requests')).json())[0];assert.notEqual(request.result.sha256,fixture.manifestSha256,'Private result hashes cannot identify public client manifests');
}));
test('both fixture fragments are independently verified PCM rather than mock data URIs',()=>withFixture(async(fixture,sample)=>{
 for(const segment of fixture.manifest.segments){const response=await fetch(fixture.origin+segment.url),bytes=Buffer.from(await response.arrayBuffer());assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/wav');assert.equal(response.headers.get('x-content-sha256'),segment.sha256);assert.deepEqual(bytes,sample);assert.equal((await verifyAudioChunk(bytes,segment)).frames,2205);}
}));
test('fixture exposes only fixed test metadata and read-only allowlisted routes',()=>withFixture(async fixture=>{
 const response=await fetch(fixture.origin+'/api/me'),profile=await response.json();assert.equal(profile.id,AUDIO_FIXTURE.profileId);assert.match(response.headers.get('set-cookie'),/^cotology=audio-fixture-session;/);
 assert.equal((await(await fetch(fixture.origin+'/api/books')).json())[0].work_id,AUDIO_FIXTURE.workId);
 for(const route of ['/private/file','/api/books/../../private','/api/derived/jobs/'+AUDIO_FIXTURE.workId+'/result'])assert.equal((await fetch(fixture.origin+route)).status,404);
 assert.equal((await fetch(fixture.origin+'/api/derived/requests',{method:'POST',body:'{}'})).status,405);
 const status=await(await fetch(fixture.origin+'/test/status')).json();assert.ok(status.requests.some(value=>value.method==='POST'));assert.equal(JSON.stringify(status).includes('fixture-only-no-production-session'),false);
}));
test('explicit batch fixture records bounded UI intents and keeps repeated keys idempotent',()=>withFixture(async fixture=>{
 const body={idempotencyKey:'b4000000-0000-4000-8000-000000000001',kind:'audio',publicationIds:[AUDIO_FIXTURE.bookId],sourceLanguage:'ru',chapterRange:{start:4,count:3}};
 const post=value=>fetch(fixture.origin+'/api/derived/requests',{method:'POST',body:JSON.stringify(value)});
 assert.equal((await post(body)).status,202);const repeated=await post(body);assert.equal(repeated.status,200);assert.equal((await repeated.json()).idempotent,true);
 assert.equal((await post({...body,chapterRange:{start:6,count:5}})).status,409);assert.equal((await post({...body,idempotencyKey:'b4000000-0000-4000-8000-000000000002',chapterRange:{start:1,count:200}})).status,400);
 const state=await(await fetch(fixture.origin+'/api/fixture/chapter-batches')).json();assert.equal(state.enabled,true);assert.equal(state.uniqueJobs,1);assert.equal(state.creates.length,3);
}, {chapterBatches:true}));
