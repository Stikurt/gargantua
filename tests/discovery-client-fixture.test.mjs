import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createDiscoveryClientFixture,syntheticWav,DISCOVERY_FIXTURE as F} from '../scripts/discovery-client-fixture.mjs';
test('synthetic discovery fixture enforces retry key and CAS and server-owned audio generation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-search-fixture-')),sample=path.join(root,'tone.wav');await fs.writeFile(sample,syntheticWav());const fixture=await createDiscoveryClientFixture({samplePath:sample});t.after(async()=>{await fixture.close();await fs.rm(root,{recursive:true,force:true});});
 const request=(route,body)=>fetch(fixture.origin+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
 await request('/api/fixture/fault',{loseCreateOnce:true,staleBranchOnce:true});const body={idempotencyKey:randomUUID(),query:'цивилизация мудрецов',intent:'book',language:'ru',allowOriginal:false,audio:true};assert.equal((await request('/api/discovery/requests',body)).status,503);const created=await(await request('/api/discovery/requests',body)).json();assert.equal(created.idempotent,true);let row=created.request;assert.equal(row.id,F.titleRequest);
 const decide=async candidateId=>request(`/api/discovery/requests/${row.id}/decision`,{action:'select',candidateId,expectedRevision:row.revision,planRevision:row.plan_revision});row=await(await decide('novel-preview')).json();assert.equal(row.plan.candidates.length,2);assert.equal((await decide('branch-main')).status,409);row=await(await request(`/api/discovery/requests/${row.id}`)).json();row=await(await decide('branch-main')).json();assert.equal(row.status,'book-ready');assert.equal(row.outputs.audio.jobId,F.jobId);
 const manifest=await request(`/api/derived/jobs/${F.jobId}/result`);const bytes=Buffer.from(await manifest.arrayBuffer());assert.equal(manifest.headers.get('x-content-sha256'),createHash('sha256').update(bytes).digest('hex'));assert.equal(JSON.parse(bytes).sourceSha256,fixture.book.content_sha256);
 const state=await(await request('/test/status')).json();assert.equal(state.rows.length,1);assert.equal(state.derivedCreated,1);assert.equal(state.derivedBodies.length,0);assert.deepEqual(state.createBodies[0],state.createBodies[1]);
});
test('synthetic discovery fixture preserves bounded chapter selection and rejects malformed ranges',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-search-range-fixture-')),sample=path.join(root,'tone.wav');await fs.writeFile(sample,syntheticWav());const fixture=await createDiscoveryClientFixture({samplePath:sample});t.after(async()=>{await fixture.close();await fs.rm(root,{recursive:true,force:true});});
 const request=(route,body)=>fetch(fixture.origin+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const body={idempotencyKey:randomUUID(),query:'цивилизация мудрецов',intent:'book',language:'ru',allowOriginal:false,audio:true,chapterRange:{start:4,count:3}};
 const created=await request('/api/discovery/requests',body);assert.equal(created.status,202);let row=(await created.json()).request;assert.deepEqual(row.input.chapterRange,{start:4,count:3});
 assert.equal((await request('/api/discovery/requests',{...body,chapterRange:{start:4,count:2}})).status,409);
 for(const chapterRange of [{start:0,count:5},{start:1,count:6},{start:1,count:5,url:'https://invalid.test'},[1,5],null])assert.equal((await request('/api/discovery/requests',{...body,idempotencyKey:randomUUID(),chapterRange})).status,400);
 const refined=await request(`/api/discovery/requests/${row.id}/decision`,{action:'refine',expectedRevision:row.revision,chapterRange:{start:6,count:5}});assert.equal(refined.status,200);row=await refined.json();assert.deepEqual(row.input.chapterRange,{start:6,count:5});
 assert.equal((await request(`/api/discovery/requests/${row.id}/decision`,{action:'refine',expectedRevision:row.revision,chapterRange:{start:6,count:6}})).status,400);
});
