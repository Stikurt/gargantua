import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {normalizeSearchQuery,suggestSearchQueries} from '../src/search-query.mjs';
import {discoveryInput,discoveryQueryHints,reserveDiscoverySubmission} from '../src/discovery-client.mjs';
import {interpretDiscoveryQuery,createDiscoverySearch} from '../server/discovery-providers.mjs';
const inputs=['  цивилизация\t\r\n мудрецов  ','  Артур\u00a0\u2009Кларк  ','Ｒｅｎｄｅｚｖｏｕｓ　ｗｉｔｈ　Ｒａｍａ','Цивилизация мурдецов','wbdbkbpfwbz velhtwjd'];
test('client and provider share the same raw budget whitespace Unicode and URL policy',()=>{
 for(const query of inputs){const normalized=normalizeSearchQuery(query);assert.equal(discoveryInput({query}).query,normalized);assert.equal(interpretDiscoveryQuery(query).query,normalized);}
 for(const query of ['h t t p s : / / example.org','ＨＴＴＰＳ：／／example.org','x'.repeat(301),' '.repeat(300)+'x','\ufb03'.repeat(101),'Title\u202e','Title\u0000','Title\u200b','Книга\ud800'])for(const read of [normalizeSearchQuery,value=>discoveryInput({query:value}),interpretDiscoveryQuery])assert.throws(()=>read(query),TypeError);
 for(const intent of ['auto','book','author','series'])assert.equal(discoveryInput({query:'Артур Кларк',intent}).intent,intent);
});
test('metadata hints contain only already known display text, retain provenance and prioritize selected source cards',()=>{
 const hints=discoveryQueryHints({books:[{id:randomUUID(),title:'Белые ночи',author:'Фёдор Достоевский',source_url:'https://example.test/private'}],localBooks:[{title:'Локальная книга',author:'Местный автор'}],rows:[{query_text:'user text is not trusted metadata',plan:{candidates:[{id:'dsc_novel',kind:'book',title:'Цивилизация Мудрецов',originalTitle:'Civilization of the Sages',url:'https://untrusted.test'}, {id:'dsc_author',kind:'author',title:'Артур Кларк',aliases:['Arthur C. Clarke']}],plan:{kind:'series',title:'Коты-воители'}}}]});
 assert.equal(hints[0].title,'Цивилизация Мудрецов');assert.equal(hints[0].source,'search-result');assert.deepEqual(hints[0].aliases,['Civilization of the Sages']);
 assert.ok(hints.some(row=>row.title==='Белые ночи'&&row.source==='server-library'));assert.ok(hints.some(row=>row.title==='Локальная книга'&&row.source==='local-library'));assert.ok(hints.some(row=>row.title==='Коты-воители'&&row.kind==='series'));
 assert.equal(JSON.stringify(hints).includes('https://'),false);assert.equal(JSON.stringify(hints).includes('user text'),false);
 assert.equal(suggestSearchQueries('Цивилизация мурдецов',hints).suggestions[0].query,'Цивилизация Мудрецов');assert.equal(suggestSearchQueries('wbdbkbpfwbz velhtwjd',hints).suggestions[0].reason,'keyboard-layout');
});
test('a suggested correction keeps the old ticket and creates a separate ticket only after explicit submission',async()=>{
 const data=new Map(),storage={get:async key=>data.get(key),put:async(key,value)=>data.set(key,value)},profile=randomUUID(),original={query:'Цивилизация мурдецов',intent:'book',language:'ru',allowOriginal:false,audio:true};
 const first=await reserveDiscoverySubmission(storage,profile,original,randomUUID,'http://127.0.0.1:3080'),size=data.size;
 const suggestions=suggestSearchQueries(original.query,[{title:'Цивилизация Мудрецов',kind:'book'}],{intent:original.intent});assert.equal(data.size,size);assert.equal(original.query,'Цивилизация мурдецов');assert.equal(suggestions.confirmationRequired,true);
 const submitted={...original,query:suggestions.suggestions[0].query},second=await reserveDiscoverySubmission(storage,profile,submitted,randomUUID,'http://127.0.0.1:3080');assert.notEqual(second.body.idempotencyKey,first.body.idempotencyKey);assert.equal(second.body.intent,first.body.intent);assert.deepEqual(await storage.get(first.key),first.body);
 const retry=await reserveDiscoverySubmission(storage,profile,original,randomUUID,'http://127.0.0.1:3080');assert.equal(retry.body.idempotencyKey,first.body.idempotencyKey);
});
test('provider receives the original typo and never automatically selects the nearby correct work',async()=>{
 const requested=[];let now=0;
 const search=createDiscoverySearch({clock:()=>now,sleep:async ms=>{now+=ms;},fetchSafe:async url=>{requested.push(new URL(url));const source=new URL(url),data=source.hostname==='openlibrary.org'?{docs:[{key:'/works/OL1W',title:'Цивилизация Мудрецов',author_name:['Известный автор'],language:['rus']}],numFound:1}:source.hostname==='gutendex.com'?{results:[],count:0,next:null}:{data:[]};return {buffer:Buffer.from(JSON.stringify(data)),type:'application/json',url};}});
 const result=await search('  Цивилизация\tмурдецов  ',{intent:'book',language:'ru'});assert.equal(result.query,'Цивилизация мурдецов');assert.equal(result.selectedCandidateId,null);assert.equal(result.nextAction,'none');assert.ok(result.candidates.some(row=>row.title==='Цивилизация Мудрецов'));
 const open=requested.find(url=>url.hostname==='openlibrary.org');assert.ok(open.search.includes(encodeURIComponent('мурдецов'))||open.searchParams.get('title')?.includes('мурдецов')||open.searchParams.get('q')?.includes('мурдецов'));
});
