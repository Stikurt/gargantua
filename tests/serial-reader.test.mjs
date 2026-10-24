import test from 'node:test';
import assert from 'node:assert/strict';
import {serialReaderModel,serialReaderTarget,createSerialReaderNavigator} from '../src/serial-reader.mjs';
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const chapters=(count,offset=0)=>Array.from({length:count},(_,index)=>({index,title:'Глава '+(offset+index+1)}));
function data(active=0){
 const parts=Array.from({length:6},(_,index)=>({publicationId:id(index+1),chapterOffset:index*50,chapterCount:index===5?25:50,contentSha256:'a'.repeat(64),packageSha256:'b'.repeat(64),securityState:'passed',available:true,chapters:chapters(index===5?25:50,index*50)}));
 return {book:{id:parts[active].publicationId,title:'Физическая часть '+active,author:'Автор'},chapters:parts[active].chapters,bookmarks:[],serialGroup:{schemaVersion:1,id:id(99),snapshotId:id(98),provider:'ranobelib',title:'Цивилизация Мудрецов',author:'Автор',language:'und',branch:'23137',snapshotStatus:'ready',inventorySha256:'c'.repeat(64),totalChapters:275,parts}};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
test('six immutable parts project into exactly one 275-chapter TOC without changing source data',()=>{
 const value=data(),before=JSON.stringify(value),model=serialReaderModel(value,49);assert.equal(model.title,'Цивилизация Мудрецов');assert.equal(model.totalChapters,275);assert.equal(model.toc.length,275);assert.equal(model.globalIndex,49);assert.deepEqual(serialReaderTarget(model,50),{publicationId:id(2),index:0,position:0});assert.equal(JSON.stringify(value),before);
 for(let n=0;n<275;n++){const target=serialReaderTarget(model,n);assert.equal(target.publicationId,id(Math.floor(n/50)+1));assert.equal(target.index,n%50);}
});
test('global previous and final TOC targets retain physical local chapter indexes and bookmark positions',()=>{
 const second=serialReaderModel(data(1),0);assert.equal(second.globalIndex,50);assert.deepEqual(serialReaderTarget(second,49,.37),{publicationId:id(1),index:49,position:.37});
 const final=serialReaderModel(data(5),24);assert.equal(final.globalIndex,274);assert.equal(final.next,null);assert.deepEqual(serialReaderTarget(final,274),{publicationId:id(6),index:24,position:0});assert.equal(final.previous.globalIndex,273);
});
test('missing local parts and a not-yet-published tail keep visible unavailable chapter slots',()=>{
 const value=data();value.serialGroup.parts[1].available=false;value.serialGroup.parts[1].chapters=[];value.serialGroup.parts=value.serialGroup.parts.slice(0,2);value.serialGroup.snapshotStatus='building';const model=serialReaderModel(value,0);
 assert.equal(model.toc.length,275);assert.equal(model.toc[50].available,false);assert.equal(model.toc[100].publicationId,null);assert.throws(()=>serialReaderTarget(model,50),{code:'SERIAL_READER_UNAVAILABLE'});assert.throws(()=>serialReaderTarget(model,100),{code:'SERIAL_READER_UNAVAILABLE'});assert.equal(model.toc[0].available,true);
});
test('unified bookmarks preserve stored IDs and publication scopes while current marks replace stale projected copies',()=>{
 const value=data(1),old={id:id(501),chapter:2,position:.37,note:'Старая метка'},current={id:id(502),chapter:3,position:.42,note:'Свежая метка'};value.bookmarks=[current];value.serialBookmarks=[{...old,publicationId:id(1)},{...current,note:'устаревшая',publicationId:id(2)},{...old,publicationId:id(88)},{...old,chapter:70,publicationId:id(1)}];const before=JSON.stringify(value),model=serialReaderModel(value,0);
 assert.equal(model.bookmarks.length,2);assert.equal(model.bookmarks[0].id,old.id);assert.equal(model.bookmarks[0].globalIndex,2);assert.equal(model.bookmarks[1].id,current.id);assert.equal(model.bookmarks[1].publicationId,id(2));assert.equal(model.bookmarks[1].globalIndex,53);assert.equal(model.bookmarks[1].note,'Свежая метка');assert.equal(JSON.stringify(value),before);
});
test('ordinary single-book navigation and original local bookmarks keep their previous namespace',()=>{
 const value=data();delete value.serialGroup;value.bookmarks=[{id:id(5),chapter:12,position:.2,note:'Закладка'}];const model=serialReaderModel(value,12);assert.equal(model.group,null);assert.equal(model.title,value.book.title);assert.equal(model.totalChapters,50);assert.deepEqual(serialReaderTarget(model,13),{publicationId:id(1),index:13,position:0});assert.equal(model.bookmarks[0].chapter,12);assert.equal(model.bookmarks[0].publicationId,id(1));
});
test('malformed grouping, overlap, foreign active publication and unsafe headers reject instead of retargeting text',()=>{
 const changes=[value=>value.serialGroup.parts[1].chapterOffset=49,value=>value.serialGroup.parts[1].publicationId=id(1),value=>value.serialGroup.parts[0].chapterCount=49,value=>value.serialGroup.totalChapters=20001,value=>value.serialGroup.parts[1].chapters[0].index=1,value=>value.serialGroup.parts=value.serialGroup.parts.slice(1),value=>value.serialGroup.parts[1].chapters={},value=>value.serialGroup.author={}];
 for(const change of changes){const value=data();change(value);assert.throws(()=>serialReaderModel(value,0),{code:'SERIAL_READER_CONTEXT'});}
 const value=data();let getter=false;Object.defineProperty(value.serialGroup,'title',{get(){getter=true;return 'Wrong';},enumerable:true});assert.throws(()=>serialReaderModel(value,0),{code:'SERIAL_READER_CONTEXT'});assert.equal(getter,false);
 for(const global of [-1,275,NaN,'50'])assert.throws(()=>serialReaderTarget(serialReaderModel(data(),0),global),{code:'SERIAL_READER_TARGET'});
});
test('cross-part navigation flushes the old source before loading and flushes latest scroll before commit',async()=>{
 const events=[],navigator=createSerialReaderNavigator({flush:async()=>events.push('flush'),openPart:async(target,guard)=>{events.push(['load',target.publicationId,target.index,target.position]);assert.equal(guard.isCurrent(),true);events.push('old scroll arrived while loading');assert.equal(await guard.beforeCommit(),true);if(guard.isCurrent())events.push('commit');},onBusy:value=>events.push(['busy',value])});
 assert.equal(await navigator.open({publicationId:id(2),index:0,position:0}),true);assert.deepEqual(events,[['busy',true],'flush',['load',id(2),0,0],'old scroll arrived while loading','flush','commit',['busy',false]]);
});
test('a failed position flush keeps the current part open and allows a later explicit retry',async()=>{
 let blocked=true,opens=0;const navigator=createSerialReaderNavigator({flush:async()=>{if(blocked)throw Error('Disk full');},openPart:async()=>{opens++;}});await assert.rejects(()=>navigator.open({}),/Disk full/);assert.equal(opens,0);assert.equal(navigator.isBusy(),false);blocked=false;assert.equal(await navigator.open({}),true);assert.equal(opens,1);
});
test('back or disposal fences late part loads and prevents writes to a closed reader',async()=>{
 for(const action of ['invalidate','dispose']){const gate=deferred(),entered=deferred();let commits=0,flushes=0;const navigator=createSerialReaderNavigator({flush:async()=>{flushes++;},openPart:async(_target,guard)=>{entered.resolve();await gate.promise;if(await guard.beforeCommit()&&guard.isCurrent())commits++;}}),opening=navigator.open({publicationId:id(2),index:0,position:0});await entered.promise;navigator[action]();gate.resolve();assert.equal(await opening,false);assert.equal(commits,0);assert.equal(flushes,1);}
});
test('duplicate cross-part clicks share no extra work and a cancellation does not block new navigation',async()=>{
 const firstGate=deferred(),firstEntered=deferred(),targets=[];const navigator=createSerialReaderNavigator({flush:async()=>{},openPart:async(target,guard)=>{targets.push(target.index);if(target.index===0){firstEntered.resolve();await firstGate.promise;}return guard.isCurrent();}});
 const first=navigator.open({index:0});await firstEntered.promise;assert.equal(await navigator.open({index:1}),false);navigator.invalidate();assert.equal(await navigator.open({index:2}),true);firstGate.resolve();assert.equal(await first,false);assert.deepEqual(targets,[0,2]);assert.equal(navigator.isBusy(),false);
});
