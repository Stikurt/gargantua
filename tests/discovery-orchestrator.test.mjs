import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {libraryDiscoveryPlan,buildDiscoveryPlan,acquisitionSelection} from '../server/discovery-orchestrator.mjs';
const local=(title='Test Book',language='ru')=>({id:randomUUID(),title,author:'Test Author',language});
const input=(changes={})=>({input:{query:'Test Book',intent:'book',language:'ru',allowOriginal:false,audio:true,...changes}});
const db=rows=>({query:async()=>({rows})});
const candidate=()=>({kind:'book',identity:{provider:'gutendex',remoteId:'11'},title:'Alice',authors:[{name:'Lewis Carroll'}],eligibleForAcquisition:true,availability:'fetchable',sourceBinding:{copyright:false},downloadSelections:[{extension:'epub',url:'https://gutenberg.pglaf.org/cache/epub/11/pg11-images-3.epub',originalUrl:'https://www.gutenberg.org/cache/epub/11/pg11-images-3.epub',mimeType:'application/epub+zip',maxRedirects:0,requiresQuarantine:true,expected:{provider:'gutenberg',remoteId:'11',title:'Alice',authors:['Lewis Carroll'],language:'en',languages:['en']}}]});

test('one accepted exact local version is reused without a network request',async()=>{
 const book=local();let calls=0;const plan=await buildDiscoveryPlan(db([book]),input(),{search:async()=>{calls++;throw Error('network should not run');}});
 assert.equal(calls,0);assert.equal(plan.status,'resolved');assert.equal(plan.candidates[0].bookId,book.id);assert.equal(plan.requestCount,0);assert.equal(plan.nextAction,'acquire');
});
test('different local editions remain a choice and wrong-language original needs consent',async()=>{
 const plan=await libraryDiscoveryPlan(db([local(),local()]),input());assert.equal(plan.status,'needs_clarification');assert.equal(plan.candidates.length,2);assert.equal(plan.selectedCandidateId,null);
 const foreign=await libraryDiscoveryPlan(db([local('Test Book','en')]),input());assert.equal(foreign.status,'needs_clarification');assert.equal(foreign.candidates[0].eligibleForAcquisition,false);
 const consent=await libraryDiscoveryPlan(db([local('Test Book','en')]),input({allowOriginal:true}));assert.equal(consent.status,'resolved');
});
test('title fragments and mismatching known author never reuse a local publication',async()=>{
 assert.equal(await libraryDiscoveryPlan(db([local('Test Book 2')]),input()),null);
 assert.equal(await libraryDiscoveryPlan(db([local('Rendezvous with Rama')]),input({query:'Свидание с Рамой'})),null);
});
test('a persisted selected author expands through the fixed identity selector',async()=>{
 const author={id:'dsc_123',kind:'author',identity:{provider:'openlibrary',remoteId:'OL2623461A'},title:'Arthur C. Clarke'},row={...input(),selected_candidate_id:author.id,plan:{candidates:[author]}};let selected;
 const result=await buildDiscoveryPlan(db([]),row,{searchSelected:async(c,options)=>{selected={c,options};return {sentinel:true};},search:async()=>{throw Error('unfiltered search');}});
 assert.deepEqual(result,{sentinel:true});assert.equal(selected.c,author);assert.equal(selected.options.language,'ru');
});
test('acquisition reconstructs the permitted mirror path and requires matching identity',()=>{
 const value=candidate();assert.equal(acquisitionSelection(value).extension,'epub');
 for(const change of [c=>{c.downloadSelections[0].url='https://attacker.example/book.epub';},c=>{c.downloadSelections[0].expected.remoteId='12';},c=>{c.downloadSelections[0].maxRedirects=3;},c=>{c.downloadSelections[0].expected.title='Different';},c=>{c.sourceBinding.copyright=true;},c=>{c.conflictingMetadata=true;},c=>{c.downloadSelections[0].expected.language=null;}]){const bad=candidate();change(bad);assert.throws(()=>acquisitionSelection(bad),{code:'DISCOVERY_NEEDS_REVIEW'});}
});
test('Ranobe preview and metadata-only cards cannot be turned into a file download',()=>{
 for(const provider of ['ranobelib','openlibrary'])assert.throws(()=>acquisitionSelection({...candidate(),identity:{provider,remoteId:'11'},availability:'needs-preview'}),{code:'DISCOVERY_NEEDS_REVIEW'});
});
test('a selected series volume searches the title and checks its known author separately',async()=>{
 const selection={id:'first',kind:'book',identity:{provider:'curated',remoteId:'warriors:tpc:1'},title:'Into the Wild',authors:[{name:'Erin Hunter'}]},row={...input(),selected_candidate_id:'first',plan:{candidates:[selection]}};let selected;
 const result=await buildDiscoveryPlan(db([]),row,{search:async()=>{throw Error('must not repeat broad query');},searchSelected:async item=>{selected=item;return {candidates:[{id:'right',authors:[{name:'Hunter, Erin'}]}],selectedCandidateId:null,status:'needs_clarification',clarifications:[],nextAction:'none'};}});
 assert.equal(selected,selection);assert.deepEqual(result.candidates.map(item=>item.id),['right']);assert.equal(result.nextAction,'none');
});

test('selected catalogue book never falls back to the wrong same-title local author',async()=>{
 const selection={id:'work',kind:'book',identity:{provider:'openlibrary',remoteId:'OL17417W'},title:'Into the Wild',authors:[{name:'Erin Hunter'}]},row={...input(),selected_candidate_id:'work',plan:{candidates:[selection]}};let calls=0;
 const result=await buildDiscoveryPlan(db([local('Into the Wild')]),row,{search:async()=>{throw Error('broad query forbidden');},searchSelected:async item=>{calls++;assert.equal(item,selection);return {status:'not_found',candidates:[]};}});
 assert.equal(calls,1);assert.equal(result.status,'not_found');
 const right=local('Into the Wild');right.author='Hunter, Erin';const reused=await buildDiscoveryPlan(db([right]),row,{searchSelected:async()=>{throw Error('local verified publication should be offered');}});
 assert.equal(reused.candidates[0].bookId,right.id);assert.equal(reused.candidates[0].matchEvidence,'exact-local-title-and-author');
});

test('explicit next page resumes only the saved provider continuation before any broad query',async()=>{
 const remoteId='OL2623461A',authorId='dsc_'+createHash('sha256').update(JSON.stringify(['openlibrary','author',remoteId])).digest('hex').slice(0,32),continuation={kind:'author-works',provider:'openlibrary',remoteId,offset:19};
 const row={...input({query:'все книги автора Артура Кларка',intent:'author'}),plan:{continuationRequested:true,plan:{kind:'author',authorCandidateId:authorId,continuation},candidates:[]}};let options;
 const result=await buildDiscoveryPlan(db([]),row,{search:async(_query,value)=>{options=value;return {status:'needs_clarification',candidates:[]};},searchSelected:async()=>{throw Error('must not restart author page');}});
 assert.equal(result.status,'needs_clarification');assert.deepEqual(options.continuation,continuation);assert.equal(options.intent,'author');
 row.plan.plan.continuation={...continuation,remoteId:'https://example.org/private'};
 await assert.rejects(()=>buildDiscoveryPlan(db([]),row,{search:async()=>{throw Error('traffic forbidden');}}),{code:'DISCOVERY_CONTINUATION'});
});
