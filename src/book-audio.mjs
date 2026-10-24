import {chapterBatchLabel,chapterRangeInfo} from './chapter-batches.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&UUID.test(value);
const hash=value=>typeof value==='string'&&HASH.test(value);
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const language=value=>typeof value==='string'&&/^[a-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)?value.toLowerCase().split('-')[0]:null;
const range=value=>{try{return chapterRangeInfo(value);}catch{return null;}};
function sourceReference(row,relation='source'){
 if(!Array.isArray(row?.publicationIds)||!row.publicationIds.length||row.publicationIds.length>20000||row.publicationIds.some(value=>!uuid(value))||new Set(row.publicationIds).size!==row.publicationIds.length||row.snapshotId!==null&&row.snapshotId!==undefined&&!uuid(row.snapshotId)||!hash(row.sourceSha256)||!language(row.sourceLanguage))return null;
 const chapterRange=range(row.chapterRange);if(!chapterRange)return null;
 return {relation,publicationIds:[...row.publicationIds],snapshotId:row.snapshotId??null,sourceSha256:row.sourceSha256,language:language(row.sourceLanguage),chapterRange};
}
function references(row){
 const direct=sourceReference(row);if(!direct)return [];
 const result=[direct],parent=row.continuationParent;
 // A translated recording is linked to the original through the exact parent
 // subscription and immutable source, never through its title or work ID.
 if(row.originChapterRange&&parent?.kind==='translation'&&parent.audio===true&&uuid(parent.id)&&uuid(parent.jobId)&&row.parentRequestId===parent.id&&row.parentJobId===parent.jobId&&row.requestedBy===parent.requestedBy&&same(range(row.originChapterRange),range(parent.chapterRange))){const origin=sourceReference(parent,'translation-original');if(origin)result.push(origin);}
 return result;
}
export function audioReady(row){return row?.kind==='audio'&&(row.jobStatus??row.job?.status)==='completed'&&!['cancelled','rejected','pending-approval'].includes(row.status);}
export function audioAssociationKey(row){if(!hash(row?.scopeId)||!uuid(row.jobId))throw Object.assign(Error('Неверная локальная запись аудио'),{code:'AUDIO_ASSOCIATION'});return `audio-book:${row.scopeId}:${row.jobId}`;}
/** This small receipt adds book provenance to an already verified native entry.
 * The public audio manifest stays unchanged for older Android clients. */
export function audioAssociationFor(local,remote){
 if(!hash(local?.scopeId)||!uuid(local.profileId)||!uuid(local.jobId)||!hash(local.manifestSha256)||local.manifest?.jobId!==local.jobId||!hash(local.manifest.sourceSha256)||!audioReady(remote)||remote.jobId!==local.jobId||remote.profileId!==local.profileId||remote.requestedBy!==local.profileId||remote.sourceSha256!==local.manifest.sourceSha256)return null;
 const sources=references(remote);if(!sources.length)return null;
 return {schemaVersion:1,scopeId:local.scopeId,profileId:local.profileId,jobId:local.jobId,manifestSha256:local.manifestSha256,sourceSha256:local.manifest.sourceSha256,references:sources};
}
export function checkedAudioAssociation(local,value){
 if(!record(value)||Object.keys(value).sort().join('|')!==['schemaVersion','scopeId','profileId','jobId','manifestSha256','sourceSha256','references'].sort().join('|')||value.schemaVersion!==1||value.scopeId!==local?.scopeId||value.profileId!==local?.profileId||value.jobId!==local?.jobId||value.manifestSha256!==local?.manifestSha256||value.sourceSha256!==local?.manifest?.sourceSha256||!hash(value.scopeId)||!uuid(value.profileId)||!uuid(value.jobId)||!hash(value.manifestSha256)||!hash(value.sourceSha256)||!Array.isArray(value.references)||!value.references.length||value.references.length>2)return null;
 const sources=[];
 for(const source of value.references){if(!record(source)||Object.keys(source).sort().join('|')!==['relation','publicationIds','snapshotId','sourceSha256','language','chapterRange'].sort().join('|')||!['source','translation-original'].includes(source.relation))return null;const checked=sourceReference({...source,sourceLanguage:source.language},source.relation);if(!checked||!same(checked,source))return null;sources.push(checked);}
 if(sources[0].relation!=='source'||sources[0].sourceSha256!==value.sourceSha256||sources.length===2&&sources[1].relation!=='translation-original')return null;
 return {...value,references:sources};
}
function matchingReference(book,sources){
 if(!uuid(book?.owner)||!uuid(book.id))return null;
 const group=book.serialGroup,publicationIds=group?.parts?.map(part=>part.publicationId)??[book.id],snapshotId=group?.snapshotId??book.snapshotId??null;
 if(publicationIds.some(value=>!uuid(value))||snapshotId!==null&&!uuid(snapshotId))return null;
 const bookLanguage=language(group?.language??book.language),total=group?.totalChapters??book.chapter_count;
 return sources.find(source=>same(source.publicationIds,publicationIds)&&source.snapshotId===snapshotId&&(!bookLanguage||bookLanguage==='und'||source.language===bookLanguage)&&(!Number.isSafeInteger(total)||total===source.chapterRange.total))??null;
}
/** Read-only choices for one concrete copy/version. A same-named local file,
 * another profile, another snapshot or another translation is not a match. */
export function bookAudioChoices(book,catalog={}){
 if(!uuid(book?.owner)||!uuid(book?.id))return [];
 const output=[],known=new Set();
 for(const row of Array.isArray(catalog.local)?catalog.local:[]){
  if(row.profileId!==book.owner)continue;
  const association=checkedAudioAssociation(row,row.bookAssociation),source=association&&matchingReference(book,association.references);if(!source)continue;
  const key=`${row.scopeId}:${row.jobId}`;if(known.has(key))continue;known.add(key);
  output.push({key,kind:'local',row,range:source.chapterRange,rangeLabel:chapterBatchLabel({chapterRange:source.chapterRange}),language:source.relation==='translation-original'?'ru':source.language,ready:true,complete:row.status==='complete',status:row.status,command:{scopeId:row.scopeId,jobId:row.jobId,profileId:row.profileId}});
 }
 if(catalog.profileId!==book.owner)return output;
 for(const row of Array.isArray(catalog.remote)?catalog.remote:[]){
  if(row.profileId!==book.owner||row.requestedBy!==book.owner||!audioReady(row))continue;
  const source=matchingReference(book,references(row));if(!source||output.some(choice=>choice.row.jobId===row.jobId&&choice.row.profileId===row.profileId))continue;
  output.push({key:`remote:${book.owner}:${row.jobId}`,kind:'remote',row,range:source.chapterRange,rangeLabel:chapterBatchLabel({chapterRange:source.chapterRange}),language:source.relation==='translation-original'?'ru':source.language,ready:true,complete:false,status:'remote',command:{...row,profileId:book.owner,jobId:row.jobId}});
 }
 return output.sort((left,right)=>left.range.start-right.range.start||Number(right.complete)-Number(left.complete)||left.key.localeCompare(right.key));
}

export function bookAudioCommand(choice,action,{token=globalThis.crypto?.randomUUID?.()}={}){if(!choice?.command||!['open','play','download'].includes(action)||!uuid(token))throw Object.assign(Error('Неверное действие аудиокниги'),{code:'AUDIO_COMMAND'});return {...choice.command,action,token};}
