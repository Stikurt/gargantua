import test from 'node:test';
import assert from 'node:assert/strict';
import {createPacedPublishedAudioReader} from '../scripts/real-delivery-capture.mjs';
const route='/api/derived/jobs/b1000000-0000-4000-8000-000000000001/audio/segments/0';
function clock(){let value=0;const delays=[];return {now:()=>value,delay:async ms=>{delays.push(ms);value+=ms;},delays};}
test('published capture audio GETs are serialized and globally paced at 600 ms',async()=>{
 const time=clock(),starts=[],read=createPacedPublishedAudioReader(async()=>{starts.push(time.now());return new Response('exact bytes');},time);await Promise.all([read(route),read(route),read(route)]);assert.deepEqual(starts,[0,600,1200]);
});
test('429 Retry-After and network errors retry only the same immutable route',async()=>{
 const time=clock(),routes=[];let calls=0;
 const read=createPacedPublishedAudioReader(async value=>{routes.push(value);if(++calls===1)return new Response('busy',{status:429,headers:{'Retry-After':'2'}});if(calls===2)throw TypeError('connection reset');return new Response('exact bytes');},time);
 assert.equal((await read(route)).status,200);assert.deepEqual(routes,[route,route,route]);assert.ok(time.delays.includes(2000));assert.ok(time.now()>=4000);
});
test('authorization, threat blocks, missing files and excessive waits are never automatically retried',async()=>{
 for(const status of [401,403,404,423]){let calls=0;const read=createPacedPublishedAudioReader(async()=>{calls++;return new Response('denied',{status});},clock());await assert.rejects(()=>read(route),/unavailable/);assert.equal(calls,1);}
 let calls=0;const time=clock(),read=createPacedPublishedAudioReader(async()=>{calls++;return new Response('busy',{status:429,headers:{'Retry-After':'3600'}});},time);await assert.rejects(()=>read(route),/budget/);assert.equal(calls,1);assert.ok(time.delays.every(ms=>ms<=60000));
});
test('bounded transient retries preserve the queue for an explicit subsequent request',async()=>{
 const time=clock();let busy=true,calls=0;const read=createPacedPublishedAudioReader(async()=>{calls++;return new Response(busy?'busy':'ready',{status:busy?503:200});},time);await assert.rejects(()=>read(route),/budget/);assert.equal(calls,4);busy=false;assert.equal((await read(route)).status,200);assert.equal(calls,5);
});
test('arbitrary URLs, range-like inputs and invalid ordinal routes cannot enter retry machinery',async()=>{
 let calls=0;const read=createPacedPublishedAudioReader(async()=>{calls++;return new Response('ready');},clock());for(const value of ['https://evil.invalid/x',route+'?force=1',route.replace('/0','/50000'),route.replace('/0','/00'),'/api/login'])await assert.rejects(()=>read(value),/exact published audio GET/);assert.equal(calls,0);
});
