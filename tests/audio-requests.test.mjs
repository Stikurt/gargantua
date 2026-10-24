import test from 'node:test';
import assert from 'node:assert/strict';
import {audioRequestRows,shouldPollAudioRequests,audioRequestStatus} from '../src/audio-requests.mjs';

const id=index=>`c1000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
const profile=id(1),other=id(2);
function request(values={}){return {id:id(3),jobId:id(4),requestedBy:profile,kind:'audio',status:'active',jobStatus:'queued',revision:1,updatedAt:'2026-10-23T00:00:00.000Z',...values};}
function translation(values={}){return request({kind:'translation',audio:true,jobStatus:'completed',...values});}
function child(parent,values={}){return request({id:id(5),jobId:id(6),parentJobId:parent.jobId,parentRequestId:parent.id,requestedBy:parent.requestedBy,...values});}

test('one shared job appears once with the current profile subscription preferred',()=>{
 const own=request({revision:1,status:'pending-approval'}),foreign=request({id:id(7),requestedBy:other,revision:20});
 const rows=audioRequestRows([foreign,own],{profileId:profile});assert.equal(rows.length,1);assert.equal(rows[0].id,own.id);assert.notEqual(rows[0],own);assert.equal(audioRequestStatus(rows[0]),'Ожидает разрешения владельца');
});
test('duplicate subscriptions prefer live, newest revision and timestamp without mutating input',()=>{
 const old=request({revision:2,updatedAt:'2026-10-23T00:00:00.000Z'}),newer=request({id:id(8),revision:2,updatedAt:'2026-10-23T01:00:00.000Z'}),cancelled=request({id:id(9),status:'cancelled',revision:100});
 const input=[old,cancelled,newer],snapshot=structuredClone(input);assert.equal(audioRequestRows(input)[0].id,newer.id);assert.deepEqual(input,snapshot);
});
test('completed translations keep polling until their audio child is present',()=>{
 const parent=translation();assert.deepEqual(audioRequestRows([parent]),[parent]);assert.equal(shouldPollAudioRequests([parent]),true);assert.equal(audioRequestStatus(parent),'Перевод готов, ожидается озвучка');
 const audio=child(parent,{jobStatus:'processing'});assert.deepEqual(audioRequestRows([parent,audio]),[audio]);assert.equal(shouldPollAudioRequests([parent,audio]),true);
});
test('ready audio replaces its parent and no longer leaves a perpetual translation wait',()=>{
 const parent=translation(),audio=child(parent,{status:'completed',jobStatus:'completed'});assert.deepEqual(audioRequestRows([parent,audio]),[audio]);assert.equal(audioRequestStatus(audio),'Готово');assert.equal(shouldPollAudioRequests([parent,audio]),false);
});
test('failed, blocked and cancelled children replace parent waits with actionable terminal states',()=>{
 const parent=translation();for(const status of ['failed','blocked','cancelled']){const audio=child(parent,{jobStatus:status});assert.deepEqual(audioRequestRows([parent,audio]),[audio]);assert.equal(shouldPollAudioRequests([parent,audio]),false);assert.notEqual(audioRequestStatus(audio),'Перевод готов, ожидается озвучка');}
});
test('a different reader or parent request cannot hide this reader translation request',()=>{
 const parent=translation();
 for(const audio of [child(parent,{requestedBy:other}),child(parent,{parentRequestId:id(88)}),child(parent,{parentJobId:id(89)})]){assert.equal(audioRequestRows([parent,audio],{profileId:profile}).length,2);assert.equal(shouldPollAudioRequests([parent,audio]),true);}
});
test('child matching is done before shared audio-job deduplication',()=>{
 const parent=translation(),ownChild=child(parent,{revision:1}),standalone=request({id:id(20),jobId:ownChild.jobId,revision:2,parentJobId:null,parentRequestId:null});
 assert.deepEqual(audioRequestRows([parent,ownChild,standalone],{profileId:profile}),[standalone]);
});
test('cancelled or unapproved subscriptions override shared completed-job state',()=>{
 const cancelled=request({status:'cancelled',jobStatus:'completed'});assert.equal(audioRequestStatus(cancelled),'Отменено');assert.equal(shouldPollAudioRequests([cancelled]),false);
 const pending=request({status:'pending-approval',jobStatus:'completed'});assert.equal(audioRequestStatus(pending),'Ожидает разрешения владельца');assert.equal(shouldPollAudioRequests([pending]),true);
});
test('server status spellings and thermal/resource pauses have useful Russian labels',()=>{
 for(const [status,label]of [['pending-approval','Ожидает разрешения владельца'],['approval-required','Ожидает разрешения владельца'],['processing','Обрабатывается'],['blocked','Остановлено для проверки безопасности'],['queued','В очереди'],['paused','Приостановлено']])assert.equal(audioRequestStatus(request({jobStatus:status})),label);
 assert.equal(audioRequestStatus(request({jobStatus:'paused',pauseReason:'gpu-overheat'})),'Ожидаем охлаждения ПК');assert.equal(audioRequestStatus(request({jobStatus:'paused',pauseReason:'resource-pressure'})),'Ожидаем свободные ресурсы ПК');
});
test('approval and resource changes continue polling while terminal jobs do not',()=>{
 for(const status of ['pending-approval','approval-required','queued','processing','paused'])assert.equal(shouldPollAudioRequests([request({jobStatus:status})]),true,status);
 for(const status of ['failed','blocked','cancelled','rejected','completed'])assert.equal(shouldPollAudioRequests([request({jobStatus:status})]),false,status);
});
test('irrelevant, malformed and non-audio translations never create client work or unsafe labels',()=>{
 const list=[null,{},request({jobId:'../../x'}),translation({audio:false}),request({kind:'other'})];assert.deepEqual(audioRequestRows(list),[]);assert.equal(shouldPollAudioRequests(list),false);assert.equal(audioRequestStatus({jobStatus:'<script>evil</script>'}),'В обработке');
 for(const value of [null,{},Array(1001)])assert.throws(()=>audioRequestRows(value),error=>error.code==='AUDIO_REQUESTS');
});
