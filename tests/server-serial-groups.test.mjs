import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serialGroupView,listSerialGroups,withSerialMembership} from '../server/serial-groups.mjs';
const sha='a'.repeat(64),packageSha='b'.repeat(64);
const feed=extra=>({id:randomUUID(),snapshot_id:randomUUID(),title:'Цивилизация Мудрецов',author:'wirae',language:'ru',branch_key:'23137',snapshot_status:'building',inventory_sha256:sha,chapter_count:275,...extra});
const part=(offset,count=50,extra={})=>({book_id:randomUUID(),ordinal:offset,chapter_count:count,book_chapter_count:count,content_sha256:sha,package_sha256:packageSha,ledger_package_sha256:packageSha,security_state:'passed',...extra});
test('server group preserves exact source offsets and immutable publication IDs',()=>{
 const input=feed(),parts=[part(0),part(50),part(100)],view=serialGroupView(input,parts);
 assert.equal(view.id,input.id);assert.equal(view.snapshotId,input.snapshot_id);assert.equal(view.title,input.title);assert.equal(view.branch,'23137');assert.equal(view.totalChapters,275);assert.equal(view.snapshotStatus,'building');
 assert.deepEqual(view.parts.map(p=>[p.publicationId,p.chapterOffset,p.chapterCount]),parts.map(p=>[p.book_id,p.ordinal,p.chapter_count]));assert.equal(view.parts.reduce((n,p)=>n+p.chapterCount,0),150);
});
test('short final part is retained; ready snapshots require complete ordered coverage',()=>{
 const input=feed({snapshot_status:'ready'}),parts=[0,50,100,150,200].map(n=>part(n)).concat(part(250,25));assert.equal(serialGroupView(input,parts).parts.at(-1).chapterCount,25);
 for(const altered of [parts.slice(1),parts.slice(0,-1),parts.filter((_,i)=>i!==2)])assert.throws(()=>serialGroupView(input,altered),{code:'SERIAL_GROUPS_UNAVAILABLE'});
});
test('building gaps retain declared offsets and blocked parts stay blocked',()=>{
 const view=serialGroupView(feed(),[part(0),part(100,50,{security_state:'blocked'}),part(150,20,{security_state:'error'})]);assert.deepEqual(view.parts.map(p=>[p.chapterOffset,p.securityState]),[[0,'passed'],[100,'blocked'],[150,'pending']]);
});
test('overlap duplicate wrong hash and mismatched chapter count fail closed',()=>{
 const a=part(0),b=part(50);for(const parts of [[b,a],[a,{...b,ordinal:49}],[a,{...b,book_id:a.book_id}],[{...a,book_chapter_count:49}],[{...a,ledger_package_sha256:sha}],[part(270,50)],[{...a,security_state:'trusted'}],[part(0,51)]])assert.throws(()=>serialGroupView(feed(),parts),{code:'SERIAL_GROUPS_UNAVAILABLE'});
});
test('malformed metadata and oversized source groups are rejected',()=>{
 for(const extra of [{id:'made-up'},{snapshot_id:''},{title:''},{title:'bad\u202e'},{branch_key:'https://evil.test'},{chapter_count:20001},{snapshot_status:'abandoned'},{inventory_sha256:'bad'}])assert.throws(()=>serialGroupView(feed(extra),[]),{code:'SERIAL_GROUPS_UNAVAILABLE'});
 assert.throws(()=>serialGroupView(feed({chapter_count:20000}),Array.from({length:401},(_,i)=>part(i*50))),{code:'SERIAL_GROUPS_UNAVAILABLE'});
});
test('ledger membership leaves cross-feed ambiguity explicit and does not mutate stored books',async()=>{
 const first={id:randomUUID(),title:'Same name'},second={id:randomUUID(),title:'Same name'},third={id:randomUUID(),title:'Other'},one=randomUUID(),two=randomUUID();let calls=0;
 const pool={query:async(sql,params)=>{calls++;assert.ok(sql.includes('ranobe_run_parts'));assert.deepEqual(params,[[first.id,second.id,third.id]]);return {rows:[{book_id:first.id,feed_id:one},{book_id:second.id,feed_id:one},{book_id:second.id,feed_id:two}]};}};
 const view=await withSerialMembership(pool,[first,second,third]);assert.equal(view[0].serial_feed_id,one);assert.equal(view[1].serial_feed_id,undefined);assert.equal(view[2].serial_feed_id,undefined);assert.equal(first.serial_feed_id,undefined);assert.equal(calls,1);assert.deepEqual(await withSerialMembership(pool,[]),[]);assert.equal(calls,1);await assert.rejects(()=>withSerialMembership(pool,[{id:'fake'}]),{code:'SERIAL_GROUPS_UNAVAILABLE'});
});

test('the server automatically projects several unrelated feed inventories including partial first imports',async()=>{
 const cases=[['Полдень над морем',1],['Легенда о медном лесе',51],['Night Watchers',126],['Легенда о медном лесе',201]],feeds=cases.map(([title,chapter_count],index)=>feed({title,chapter_count,branch_key:String(100+index),snapshot_status:index===3?'building':'ready'})),rows=[];
 for(const [index,current]of feeds.entries())for(let offset=0;offset<current.chapter_count;offset+=50){if(index===3&&offset===50)continue;rows.push({...part(offset,Math.min(50,current.chapter_count-offset)),run_id:current.snapshot_id});}
 const calls=[],client={query:async(sql,params)=>{calls.push({sql,params});if(sql.includes('SELECT f.id'))return {rows:feeds};if(sql.includes('SELECT p.run_id'))return {rows};return {rows:[]};},release:()=>calls.push({sql:'release'})},owner={id:randomUUID(),role:'owner'},pool={connect:async()=>client},before=structuredClone({feeds,rows});
 const result=await listSerialGroups(pool,owner);assert.equal(result.groups.length,4);assert.equal(result.groups.filter(row=>row.title==='Легенда о медном лесе').length,2);for(const [index,g]of result.groups.entries()){assert.equal(g.id,feeds[index].id);assert.equal(g.snapshotId,feeds[index].snapshot_id);assert.equal(g.title,feeds[index].title);assert.equal(g.totalChapters,feeds[index].chapter_count);assert.deepEqual(g.parts.map(row=>row.chapterOffset),rows.filter(row=>row.run_id===g.snapshotId).map(row=>row.ordinal));}
 assert.deepEqual({feeds,rows},before);assert.match(calls[0].sql,/REPEATABLE READ READ ONLY/);assert.equal(calls.at(-2).sql,'COMMIT');assert.equal(calls.at(-1).sql,'release');const inventoryQuery=calls.find(row=>row.sql.includes('SELECT f.id'));assert.match(inventoryQuery.sql,/COALESCE\(f\.head_run_id/);assert.deepEqual(inventoryQuery.params.slice(0,2),[true,owner.id]);
});
