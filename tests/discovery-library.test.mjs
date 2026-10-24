import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {findLocalDiscoveryPlan,reuseDiscoveredSources} from '../server/discovery-library.mjs';
const input={query:'Example',language:'ru',allowOriginal:false};
const book=(changes={})=>({id:randomUUID(),title:'Example',author:'Right Author',language:'ru',...changes});
const db=rows=>({query:async()=>({rows})});

test('local title reuse records limited evidence and never implies a cross-source work merge',async()=>{
 const local=book(),plan=await findLocalDiscoveryPlan(db([local]),input,{titles:['Example']});
 assert.equal(plan.status,'resolved');assert.equal(plan.candidates[0].bookId,local.id);assert.equal(plan.candidates[0].matchEvidence,'exact-local-title');assert.equal(plan.candidates[0].identity.provider,'library');
});
test('selected external work keeps author context, including a same-title wrong author',async()=>{
 const wrong=book({author:'Other Author'}),right=book();
 assert.equal(await findLocalDiscoveryPlan(db([wrong]),input,{titles:['Example'],authors:['Right Author'],requireAuthor:true}),null);
 const plan=await findLocalDiscoveryPlan(db([wrong,right]),input,{titles:['Example'],authors:['Author, Right'],requireAuthor:true});
 assert.deepEqual(plan.candidates.map(item=>item.bookId),[right.id]);assert.equal(plan.candidates[0].matchEvidence,'exact-local-title-and-author');
 assert.equal(await findLocalDiscoveryPlan(db([right]),input,{titles:['Example'],requireAuthor:true}),null);
});
test('truncated local matches cannot silently become an unambiguous edition choice',async()=>{
 const plan=await findLocalDiscoveryPlan(db(Array.from({length:21},()=>book())),input,{titles:['Example']});
 assert.equal(plan.candidates.length,20);assert.equal(plan.hasMore,true);assert.equal(plan.selectedCandidateId,null);assert.equal(plan.status,'needs_clarification');
 const overflow=await findLocalDiscoveryPlan(db(Array.from({length:1001},()=>book())),input,{titles:['Example']});assert.equal(overflow,null);
});
test('unknown language stays ineligible even when original-language editions are allowed',async()=>{
 const plan=await findLocalDiscoveryPlan(db([book({language:'und'})]),{...input,allowOriginal:true},{titles:['Example']});
 assert.equal(plan.candidates[0].eligibleForAcquisition,false);assert.equal(plan.selectedCandidateId,null);
 const multiple=await findLocalDiscoveryPlan(db([book(),book({language:'en'})]),input,{titles:['Example']});assert.equal(multiple.status,'needs_clarification');
});

const source=(id='11')=>({id:'source-'+id,kind:'book',identity:{provider:'gutendex',remoteId:id},title:'Example',availability:'fetchable',eligibleForAcquisition:true,downloadSelections:[{extension:'epub',expected:{provider:'gutenberg',remoteId:id,title:'Example',authors:['Right Author'],languages:['ru'],language:'ru'}}]});
const plan=items=>({candidates:items,status:'resolved',selectedCandidateId:items[0].id,nextAction:'acquire',clarifications:[],providerErrors:[],hasMore:false});
test('verified-source reuse binds full persisted expectations and keeps clarification references valid',async()=>{
 const local=book(),remote=source(),before=plan([remote]);before.clarifications=[{code:'CHOOSE_BOOK',candidateIds:[remote.id]}];before.plan={items:[{candidateId:remote.id}],suggestedCandidateIds:[remote.id],seriesVariants:[{items:[{candidateId:remote.id}]}]};before.identityLinks=[{candidateIds:[remote.id,'old-peer']}];let query;
 const result=await reuseDiscoveredSources({query:async(sql,args)=>{query={sql,args};return {rows:[local]};}},before,input);
 assert.match(query.sql,/identityVerification,verified/);assert.match(query.sql,/identityVerification,inputSha256/);assert.match(query.sql,/security_state='passed'/);assert.deepEqual(JSON.parse(query.args[0]),remote.downloadSelections[0].expected);
 assert.equal(result.candidates[0].matchEvidence,'verified-gutenberg-source-and-metadata');assert.equal(result.selectedCandidateId,result.candidates[0].id);assert.equal(result.clarifications[0].candidateIds[0],result.candidates[0].id);assert.equal(result.plan.items[0].candidateId,result.candidates[0].id);
 assert.equal(result.plan.suggestedCandidateIds[0],result.candidates[0].id);assert.equal(result.plan.seriesVariants[0].items[0].candidateId,result.candidates[0].id);assert.deepEqual(result.identityLinks,[]);assert.deepEqual(result.candidates[0].matchedSource,{provider:'gutenberg',remoteId:'11'});
 assert.equal(before.candidates[0],remote,'saved provider result is not mutated');
});
test('ambiguous source revisions and unavailable editions are never silently reused',async()=>{
 const before=plan([source()]);assert.equal(await reuseDiscoveredSources(db([book(),book()]),before,input),before);
 assert.equal(await reuseDiscoveredSources(db([book({language:'en'})]),before,input),before);
 const blocked=source();blocked.conflictingMetadata=true;assert.equal((await reuseDiscoveredSources({query:()=>{throw Error('must not query conflicted source');}},plan([blocked]),input)).candidates[0],blocked);
});
