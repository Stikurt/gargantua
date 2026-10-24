import test from 'node:test';
import assert from 'node:assert/strict';
import {audioAssociationFor,audioAssociationKey,checkedAudioAssociation,bookAudioChoices,bookAudioCommand,audioReady} from '../src/book-audio.mjs';

const id=value=>`b8000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
const profile=id(1),publication=id(2),job=id(3),snapshot=id(4);
const range=(start=1,count=5,total=20)=>({start,count,total,hasMore:start+count-1<total,nextStart:start+count-1<total?start+count:null});
const book=(values={})=>({id:publication,owner:profile,title:'Same title',language:'ru',chapter_count:20,...values});
const remote=(values={})=>({id:id(5),kind:'audio',jobId:job,profileId:profile,requestedBy:profile,jobStatus:'completed',status:'active',publicationIds:[publication],snapshotId:null,sourceSha256:'a'.repeat(64),sourceLanguage:'ru',chapterRange:range(),...values});
const local=(values={})=>({scopeId:'b'.repeat(64),profileId:profile,jobId:job,manifestSha256:'c'.repeat(64),manifest:{jobId:job,sourceSha256:'a'.repeat(64),workId:id(90),expressionId:id(91),editionId:id(92)},status:'complete',...values});
function saved(row=local(),request=remote()){return {...row,bookAssociation:audioAssociationFor(row,request)};}
const catalog=(values={})=>({local:[],remote:[remote()],profileId:profile,serverState:'online',...values});

test('one concrete publication gets existing server audio without a new generation request',()=>{
 const choices=bookAudioChoices(book(),catalog());assert.equal(choices.length,1);assert.equal(choices[0].kind,'remote');assert.equal(choices[0].rangeLabel,'Главы 1–5 из 20');assert.equal(choices[0].ready,true);assert.equal(choices[0].complete,false);
 for(const action of ['open','play','download']){const command=bookAudioCommand(choices[0],action,{token:id(10)});assert.equal(command.action,action);assert.equal(command.jobId,job);assert.equal(command.token,id(10));assert.equal(Object.hasOwn(command,'kind'),true);assert.equal(Object.hasOwn(command,'idempotencyKey'),false);}
});
test('same title, author, work or expression cannot associate another source publication',()=>{
 const row=remote({workId:id(90),expressionId:id(91)});for(const changed of [{id:id(80)},{owner:id(81)},{language:'en'},{chapter_count:21},{snapshotId:snapshot}])assert.deepEqual(bookAudioChoices(book({...changed,work_id:id(90),expression_id:id(91)}),catalog({remote:[row]})),[]);
 assert.deepEqual(bookAudioChoices(book({owner:undefined}),catalog()),[]);
});
test('series audio requires every ordered part and exact snapshot, with no packet or old-version reuse',()=>{
 const ids=[publication,id(11)],group={snapshotId:snapshot,language:'ru',totalChapters:20,parts:ids.map(publicationId=>({publicationId}))},request=remote({publicationIds:ids,snapshotId:snapshot});
 assert.equal(bookAudioChoices(book({serialGroup:group}),catalog({remote:[request]})).length,1);
 for(const changed of [{snapshotId:id(12)},{publicationIds:[publication]},{publicationIds:[...ids].reverse()},{publicationIds:[publication,id(13)]},{chapterRange:range(1,5,21)}])assert.deepEqual(bookAudioChoices(book({serialGroup:group}),catalog({remote:[{...request,...changed}]})),[]);
 assert.deepEqual(bookAudioChoices(book(),catalog({remote:[request]})),[]);
});
test('an immutable publication marked und may use its verified Russian audio without matching names',()=>{
 assert.equal(bookAudioChoices(book({language:'und'}),catalog()).length,1);assert.equal(bookAudioChoices(book({language:'ru-RU'}),catalog()).length,1);
});
test('ready status cannot bypass a cancelled, rejected or unapproved subscription',()=>{
 for(const status of ['cancelled','rejected','pending-approval']){assert.equal(audioReady(remote({status})),false);assert.deepEqual(bookAudioChoices(book(),catalog({remote:[remote({status})]})),[]);}
 for(const jobStatus of ['queued','processing','paused','blocked','failed'])assert.deepEqual(bookAudioChoices(book(),catalog({remote:[remote({jobStatus})]})),[]);
});
test('server requests from another profile and forged current-profile labels are excluded',()=>{
 for(const row of [remote({profileId:id(9)}),remote({requestedBy:id(9)})])assert.deepEqual(bookAudioChoices(book(),catalog({remote:[row]})),[]);
 assert.deepEqual(bookAudioChoices(book(),catalog({profileId:id(9)})),[]);
});
test('native receipt survives a JSON cold restart and works without server or login',()=>{
 const row=saved(),cold=JSON.parse(JSON.stringify(row)),choices=bookAudioChoices(book(),{local:[cold],remote:[],profileId:null,serverState:'offline'});
 assert.equal(choices.length,1);assert.equal(choices[0].kind,'local');assert.equal(choices[0].complete,true);assert.deepEqual(choices[0].command,{scopeId:row.scopeId,jobId:job,profileId:profile});assert.equal(audioAssociationKey(row),`audio-book:${row.scopeId}:${job}`);
});
test('scope, profile, job, source SHA or manifest SHA change invalidates an offline receipt',()=>{
 const row=saved();for(const changed of [{scopeId:'d'.repeat(64)},{profileId:id(99)},{jobId:id(99)},{manifestSha256:'d'.repeat(64)},{manifest:{...row.manifest,sourceSha256:'d'.repeat(64)}}])assert.deepEqual(bookAudioChoices(book(),{local:[{...row,...changed}]}),[]);
 for(const key of ['scopeId','profileId','jobId','manifestSha256','sourceSha256'])assert.equal(checkedAudioAssociation(row,{...row.bookAssociation,[key]:null}),null,key);
});
test('local manifest alone is insufficient provenance even when work and expression match',()=>{
 assert.deepEqual(bookAudioChoices(book({work_id:id(90),expression_id:id(91)}),{local:[local()]}),[]);
});
test('a recording binds only a completed own request with its verified native source SHA',()=>{
 for(const changed of [{jobId:id(99)},{profileId:id(99)},{requestedBy:id(99)},{sourceSha256:'d'.repeat(64)},{kind:'translation'},{jobStatus:'processing'},{sourceLanguage:'und-x-\0'},{publicationIds:[publication,publication]},{snapshotId:'../x'},{chapterRange:range(18,5,20)}])assert.equal(audioAssociationFor(local(),remote(changed)),null);
 assert.equal(audioAssociationFor(local({manifest:{jobId:id(99),sourceSha256:'a'.repeat(64)}}),remote()),null);
});
function translated(){
 const parent=remote({id:id(30),jobId:id(31),kind:'translation',audio:true,publicationIds:[publication],sourceSha256:'d'.repeat(64),sourceLanguage:'en',chapterRange:range(3,1,4)});
 const child=remote({publicationIds:[id(32)],sourceLanguage:'ru',sourceSha256:'a'.repeat(64),chapterRange:range(1,1,1),originChapterRange:parent.chapterRange,parentJobId:parent.jobId,parentRequestId:parent.id,continuationParent:parent});
 return {parent,child};
}
test('translated story audio belongs to the exact original and its concrete translated publication',()=>{
 const {child}=translated(),original=book({language:'en',chapter_count:4}),translatedBook=book({id:id(32),language:'ru',chapter_count:1}),online=catalog({remote:[child]});
 const originChoice=bookAudioChoices(original,online)[0],translationChoice=bookAudioChoices(translatedBook,online)[0];assert.equal(originChoice.rangeLabel,'Главы 3–3 из 4');assert.equal(originChoice.language,'ru');assert.equal(translationChoice.rangeLabel,'Главы 1–1 из 1');
 const cold=JSON.parse(JSON.stringify(saved(local(),child)));assert.equal(bookAudioChoices(original,{local:[cold]}).length,1);assert.equal(bookAudioChoices(translatedBook,{local:[cold]}).length,1);
});
test('a different parent, profile, source language, range or child request cannot bind translation audio to an original',()=>{
 const {child}=translated(),original=book({language:'en',chapter_count:4});
 for(const changed of [{parentJobId:id(90)},{parentRequestId:id(90)},{originChapterRange:range(2,1,4)},{continuationParent:{...child.continuationParent,requestedBy:id(90)}},{continuationParent:{...child.continuationParent,sourceLanguage:'ru'}},{continuationParent:null}])assert.deepEqual(bookAudioChoices(original,catalog({remote:[{...child,...changed}]})),[]);
});
test('corrupt or extended persisted receipts do not hide healthy other recordings',()=>{
 const good=saved(),bad=saved(local({jobId:id(40),manifest:{jobId:id(40),sourceSha256:'a'.repeat(64)}}),remote({jobId:id(40)}));bad.bookAssociation.references[0].chapterRange.start=20;
 assert.equal(bookAudioChoices(book(),{local:[bad,good]}).length,1);
 for(const extra of [{...good.bookAssociation,server:'https://elsewhere.invalid'},{...good.bookAssociation,references:[{...good.bookAssociation.references[0],url:'https://elsewhere.invalid'}]}])assert.equal(checkedAudioAssociation(good,extra),null);
});
test('offline local recordings replace their remote duplicates while separate chapter batches remain selectable',()=>{
 const row=saved(),second=remote({jobId:id(43),chapterRange:range(6,5,20)}),choices=bookAudioChoices(book(),catalog({local:[row],remote:[second,remote()]}));assert.equal(choices.length,2);assert.deepEqual(choices.map(choice=>choice.range.start),[1,6]);assert.equal(choices[0].kind,'local');
});
test('invalid commands cannot turn a listen or download button into a generation operation',()=>{
 const choice=bookAudioChoices(book(),catalog())[0];for(const action of ['translate','prepare','../x',undefined])assert.throws(()=>bookAudioCommand(choice,action,{token:id(10)}),{code:'AUDIO_COMMAND'});assert.throws(()=>bookAudioCommand(choice,'play',{token:'bad'}),{code:'AUDIO_COMMAND'});
});
