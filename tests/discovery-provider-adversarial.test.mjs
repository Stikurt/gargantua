import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscoverySearch,searchSelectedDiscovery,canExpandDiscoveryCandidate,interpretDiscoveryQuery} from '../server/discovery-providers.mjs';

const response=(value,url)=>({buffer:Buffer.from(JSON.stringify(value)),type:'application/json',url});
const work=(changes={})=>({key:'/works/OL1W',title:'Exact Novel',author_name:['Known Writer'],author_key:['OL1A'],language:['rus'],...changes});
async function storedSelection(){
 const search=createDiscoverySearch({fetchSafe:async url=>{
  const host=new URL(url).hostname;return response(host==='openlibrary.org'?{docs:[work()],numFound:1}:host==='gutendex.com'?{count:0,next:null,results:[]}:{data:[]},url);
 }});
 return (await search('Exact Novel')).candidates[0];
}

test('a formerly valid selection cannot use fresh truncated work metadata as an exact source query',async()=>{
 const selected=await storedSelection();
 for(const changes of [{title:'A'.repeat(301)},{author_name:['B'.repeat(201)]}]){
  const calls=[],result=await searchSelectedDiscovery(selected,{fetchSafe:async url=>{calls.push(url);return response(work(changes),url);}});
  assert.equal(calls.length,1);assert.equal(new URL(calls[0]).pathname,'/works/OL1W.json');
  assert.equal(result.candidates[0].identityEvidenceIncomplete,true);assert.equal(result.candidates[0].sourceResolutionAttempted,true);
  assert.equal(result.selectedCandidateId,null);assert.equal(result.status,'needs_clarification');assert.notEqual(result.nextAction,'acquire');
  assert.ok(result.clarifications.some(item=>item.code==='AUTHOR_IDENTITY_UNRESOLVED'));
 }
});

test('an overlong refreshed canonical author cannot be truncated into another matching author',async()=>{
 const selected=await storedSelection(),calls=[];
 const result=await searchSelectedDiscovery(selected,{sleep:async()=>{},fetchSafe:async url=>{
  calls.push(url);return response(new URL(url).pathname==='/works/OL1W.json'?work():{key:'OL1A',name:'Known Writer '+ 'A'.repeat(201)},url);
 }});
 assert.equal(calls.length,2);assert.equal(new URL(calls[1]).pathname,'/authors/OL1A.json');
 assert.equal(result.selectedCandidateId,null);assert.notEqual(result.nextAction,'acquire');
 assert.ok(result.providerErrors.some(item=>item.code==='RESPONSE_FORMAT'));assert.ok(result.clarifications.some(item=>item.code==='AUTHOR_IDENTITY_UNRESOLVED'));
});

test('an exhausted source-resolution card cannot trigger a repeated expansion loop',async()=>{
 const selected=await storedSelection(),exhausted={...selected,sourceResolutionAttempted:true};let calls=0;
 assert.equal(canExpandDiscoveryCandidate(exhausted),false);
 await assert.rejects(()=>searchSelectedDiscovery(exhausted,{fetchSafe:async()=>{calls++;throw Error('must not fetch');}}),TypeError);
 assert.equal(calls,0);
});

test('changed stable work identity cannot seed another downloadable title',async()=>{
 const selected=await storedSelection(),calls=[];
 const result=await searchSelectedDiscovery(selected,{fetchSafe:async url=>{calls.push(url);return response(work({key:'/works/OL2W'}),url);}});
 assert.equal(calls.length,1);assert.equal(result.candidates.length,0);assert.equal(result.selectedCandidateId,null);assert.equal(result.status,'unavailable');
 assert.ok(result.providerErrors.some(item=>item.code==='RESPONSE_FORMAT'));
});

test('empty successful provider responses and exhausted transient failures are different outcomes',async()=>{
 const make=failOpen=>createDiscoverySearch({sleep:async()=>{},fetchSafe:async url=>{
  const host=new URL(url).hostname;
  if(host==='openlibrary.org'&&failOpen)throw Object.assign(new Error('internal host detail must remain private'),{code:'FETCH_HTTP',httpStatus:503});
  return response(host==='openlibrary.org'?{numFound:0,docs:[]}:host==='gutendex.com'?{count:0,next:null,results:[]}:{data:[]},url);
 }});
 const absent=await make(false)('Unknown Book');assert.equal(absent.status,'not_found');assert.equal(absent.providerErrors.length,0);assert.equal(absent.candidates.length,0);
 const incomplete=await make(true)('Unknown Book');assert.equal(incomplete.status,'unavailable');assert.equal(incomplete.selectedCandidateId,null);assert.equal(incomplete.retryCount,1);assert.equal(incomplete.requestCount,4);
 assert.ok(incomplete.providerErrors.some(item=>item.code==='SOURCE_UNAVAILABLE'));assert.ok(!JSON.stringify(incomplete).includes('internal host detail'));
});

test('an explicit overlong author is rejected before it can match a truncated local or source name',async()=>{
 const query='Exact Novel автора '+ 'A'.repeat(201);let calls=0;
 assert.ok(query.length<=300);assert.throws(()=>interpretDiscoveryQuery(query),TypeError);
 const search=createDiscoverySearch({fetchSafe:async()=>{calls++;throw Error('must not fetch');}});
 await assert.rejects(()=>search(query),TypeError);assert.equal(calls,0);
});

test('an overlong metadata alias cannot be truncated into an exact automatic author selection',async()=>{
 const alias='A'.repeat(200),calls=[];
 const search=createDiscoverySearch({fetchSafe:async url=>{
  calls.push(url);const parsed=new URL(url);
  assert.equal(parsed.pathname,'/search/authors.json');
  return response({numFound:1,docs:[{key:'OL1A',name:'Unrelated Person',alternate_names:[alias+'Z']}]},url);
 }});
 const result=await search(alias,{intent:'author'});
 assert.equal(calls.length,1);assert.equal(result.plan,null);assert.equal(result.selectedCandidateId,null);assert.equal(result.status,'needs_clarification');
 assert.deepEqual(result.candidates[0].aliases,[]);assert.ok(result.clarifications.some(item=>item.code==='CHOOSE_AUTHOR'));
});

test('compatibility normalization cannot silently shorten a different query or source identity',async()=>{
 const expanded='ﬃ'.repeat(101);assert.equal(expanded.length,101);assert.equal(expanded.normalize('NFKC').length,303);
 assert.throws(()=>interpretDiscoveryQuery(expanded),TypeError);
 assert.throws(()=>interpretDiscoveryQuery('Exact Novel автора '+ 'ﬃ'.repeat(67)),TypeError);
 const selected=await storedSelection(),calls=[];
 const result=await searchSelectedDiscovery(selected,{fetchSafe:async url=>{calls.push(url);return response(work({title:expanded}),url);}});
 assert.equal(calls.length,1);assert.equal(result.candidates[0].identityEvidenceIncomplete,true);assert.equal(result.selectedCandidateId,null);assert.notEqual(result.nextAction,'acquire');
 const alias='ﬃ'.repeat(67),aliasSearch=createDiscoverySearch({fetchSafe:async url=>response({numFound:1,docs:[{key:'OL1A',name:'Unrelated Person',alternate_names:[alias]}]},url)});
 const aliases=await aliasSearch(alias.normalize('NFKC').slice(0,200),{intent:'author'});
 assert.deepEqual(aliases.candidates[0].aliases,[]);assert.equal(aliases.plan,null);assert.equal(aliases.status,'needs_clarification');
});
