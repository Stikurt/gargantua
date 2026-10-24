// Imported only by the explicit isolated native discovery test mode. Book text
// never enters its reports: chapter hashes, coverage and locators are sufficient.
import {DEVICE} from './catalogs.mjs';
import {LOCAL_LIBRARY_INDEX,refKey} from './library-state.mjs';
export const REAL_DELIVERY_CONFIG_KEY=`${DEVICE}:real-delivery-selfcheck:config`;
const EXPECTED_KEY=`${DEVICE}:real-delivery-selfcheck:expected`;
const native=window.cotologyNative,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const element=name=>document.querySelector(`[data-testid="${name}"]`),buttons=(root=document)=>Array.from(root.querySelectorAll('button'));
async function waitFor(description,read,timeout=60000,interval=100){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){try{const result=await read();if(result)return result;}catch(error){if(error.fatal===true)throw error;last=error;}await pause(interval);}throw Error(description+(last?': '+last.message:''));}
async function click(read){const control=await waitFor('Required real-output UI control unavailable',()=>{const value=typeof read==='function'?read():element(read);return value&&!value.disabled?value:null;});control.click();await pause(50);}
function control(input,value){if(!input)throw Error('Required media control unavailable');const type=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(type,'value').set.call(input,String(value));input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
async function digest(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');}
function checkedConfig(value){if(value?.schemaVersion!==1||value.kind!=='gargantua-real-delivery-selfcheck'||!Array.isArray(value.groups)||!value.groups.length||!Array.isArray(value.books)||!value.books.length||!Array.isArray(value.jobs)||!/^[a-f0-9]{64}$/.test(value.captureSha256))throw Error('Invalid exact real-output self-check configuration');return value;}
export async function realDeliveryConfiguration(){
 if(!native?.selfCheckDiscovery)return null;
 if(native.selfCheckOffline){const stored=await native.get(REAL_DELIVERY_CONFIG_KEY);return stored?checkedConfig(stored):null;}
 const response=await native.request('/api/fixture/real-delivery',{});if(response.status===404)return null;if(response.status!==200)throw Error('Exact-output fixture identity unavailable');
 return checkedConfig(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(response.data),value=>value.charCodeAt(0)))));
}
export async function runRealDeliverySelfCheck(input){
 const config=checkedConfig(input),results=[];let reported=false;
 const check=(name,value,detail)=>{results.push({name,ok:!!value,...(detail===undefined?{}:{detail})});if(!value)throw Error(name);};
 const finish=async(ok,error)=>{if(reported)return;reported=true;await native.selfCheckReport({schemaVersion:1,ok,mode:native.selfCheckOffline?'offline':'online',scope:config.captureProvenance==='authenticated-production-api'?'REAL_WINDOWS_EXE_EXACT_PRIVATE_PRODUCTION_TEXT_AND_TTS_OUTPUT_REPLAY_NOT_NEW_SOURCE_SEARCH_OR_VOICE_QUALITY_REVIEW':'REAL_WINDOWS_EXE_SYNTHETIC_CONTRACT_SMOKE_ONLY_NOT_A_REAL_BOOK_OR_NARRATION',captureProvenance:config.captureProvenance,captureSha256:config.captureSha256,bookParts:config.books.length,chapters:config.groups.reduce((sum,group)=>sum+group.chapterCount,0),originalChapters:config.groups.reduce((sum,group)=>sum+group.originalChapterCount,0),translatedChapters:config.groups.reduce((sum,group)=>sum+group.translatedChapterCount,0),audioJobs:config.jobs.length,audioSegments:config.jobs.reduce((sum,job)=>sum+job.segmentCount,0),results,at:new Date().toISOString(),...(error?{error:String(error.message||error).replace(/[\r\n]/g,' ').slice(0,1000)}:{})});};
 // Native downloads deliberately pace every fragment. A complete long novel
 // can exceed an hour even on loopback; a short synthetic-fixture deadline
 // must not abort its verified, resumable real download.
 const watchdog=setTimeout(()=>finish(false,Error('Real-output application acceptance timed out')),4*60*60*1000);
 const packet=id=>native.get(`${config.profileId}:book:${id}`),card=id=>Array.from(document.querySelectorAll('.device-book')).find(row=>row.getAttribute('data-ref')===refKey({owner:config.profileId,id}));
 const audioReference=async id=>{const summary=(await native.audioList()).find(row=>row.jobId===id);if(!summary)return null;const ref={scopeId:summary.scopeId,jobId:id};return {ref,row:await native.audioGet(ref)};};
 const back=async()=>{await click('reader-return-library');await waitFor('Local library did not return',()=>document.querySelector('.device-books'));};
 async function inspectBooks(){for(const book of config.books){const saved=await packet(book.id);check('Every exact publication part and its source hash are stored',saved?.book?.id===book.id&&saved.book.owner===config.profileId&&saved.book.content_sha256===book.sha256&&saved.content.chapters.length===book.chapterCount,{publicationId:book.id,chapters:book.chapterCount,sha256:book.sha256});for(let index=0;index<book.chapterCount;index++)if(await digest(saved.content.chapters[index])!==book.chapters[index].sha256)throw Error('A stored chapter differs from the actual captured publication');check('All chapter objects match their real published source hashes',true,{publicationId:book.id,chapters:book.chapterCount});}}
 async function lastChapter(book,{setPosition=false}={}){
  await click(()=>card(book.id)?.querySelector('.mini-cover'));await waitFor('Real downloaded publication did not open',()=>document.querySelector('.reading-page .chapter-end'));
  const expectedTitle=book.chapters.at(-1).title;
  if(document.querySelector('.reading-page .eyebrow')?.textContent!==`ГЛАВА ${book.chapterCount} ИЗ ${book.chapterCount}`){await click(()=>document.querySelector('[aria-label="Оглавление и закладки"]'));const expectedText=`${book.chapterCount}. ${expectedTitle}`;await click(()=>buttons(document.querySelector('.reader-menu')).find(button=>button.textContent===expectedText));}
  await waitFor('Final real chapter is not reachable through the actual reader controls',()=>document.querySelector('.reading-page h1')?.textContent===expectedTitle&&document.querySelector('.reading-page .eyebrow')?.textContent===`ГЛАВА ${book.chapterCount} ИЗ ${book.chapterCount}`&&document.querySelector('.reading-page .chapter-end'));
  const pane=document.querySelector('.reader-scroll');if(setPosition){pane.scrollTop=(pane.scrollHeight-pane.clientHeight)*.37;pane.dispatchEvent(new Event('scroll',{bubbles:true}));}
  await back();const position=await native.get(`${config.profileId}:position:${book.id}`);check('Final real chapter and text position work through the actual UI',position?.chapter===book.chapterCount-1&&Number.isFinite(position.position),{publicationId:book.id,chapter:position?.chapter,position:position?.position});return position;
 }
 async function checkAudio(job,{restore=false,expected}={}){
  await click(`audio-open-${job.id}`);await waitFor('Actual narrated audio player did not open',()=>element('audio-seek'));
  const known=await audioReference(job.id);check('Every real narrated segment is downloaded and pinned to its exact public manifest',known?.row.status==='complete'&&known.row.totalSegments===job.segmentCount&&known.row.downloadedSegments===job.segmentCount&&known.row.manifestSha256===job.manifestSha256,{jobId:job.id,segments:job.segmentCount,bytes:job.totalBytes});
  if(restore){const position=await native.audioPositionGet(known.ref);check('Audio ordinal seconds speed and manifest survive a server-free cold process',position?.ordinal===expected.ordinal&&Math.abs(position.seconds-expected.seconds)<.2&&position.rate===expected.rate&&position.manifestSha256===expected.manifestSha256,{jobId:job.id,ordinal:position?.ordinal,seconds:position?.seconds,rate:position?.rate});}
  const audio=await waitFor('Actual Chromium audio element unavailable',()=>element('audio-element'));audio.muted=true;await click('audio-toggle');await waitFor('Actual narration is not decoded by Chromium',()=>!audio.paused&&audio.currentTime>.05);check('The real WAV narration decodes through private cached native URLs',audio.currentSrc.startsWith('cotology://app/__audio/')&&Number.isFinite(audio.duration),{jobId:job.id});
  if(!restore){
   control(element('audio-rate'),1.25);await waitFor('Narration rate control did not apply',()=>Math.abs(audio.playbackRate-1.25)<.001);
   const segments=known.row.manifest.segments,ordinal=segments.length-1,before=segments.slice(0,ordinal).reduce((sum,segment)=>sum+segment.durationSeconds,0),seconds=Math.min(1.25,segments[ordinal].durationSeconds*.35);
   control(element('audio-seek'),before+seconds);await waitFor('Real narration cannot seek into its final segment',()=>audio.currentSrc.includes('/'+job.id+'/'+ordinal+'/')&&audio.currentTime>=Math.max(0,seconds-.1));
  }
  await click('audio-toggle');await waitFor('Narration pause did not apply',()=>audio.paused);const position=await waitFor('Narration listening position was not persisted',async()=>{const value=await native.audioPositionGet(known.ref);return value&&value.rate===1.25?value:null;});if(!restore)check('Final real narration segment and playback rate persist independently of reading',position.ordinal===job.segmentCount-1&&position.seconds>0,{jobId:job.id,ordinal:position.ordinal,seconds:position.seconds,rate:position.rate});return position;
 }
 try{
  check('Exact real-output probe runs only in the isolated sandboxed Windows renderer',native.selfCheckDiscovery&&native.platform==='windows'&&typeof require==='undefined'&&typeof process==='undefined');
  await waitFor('Local library did not open',()=>document.querySelector('.device-books'));
  if(native.selfCheckOffline){
   const blocked=await fetch('/api/me');check('The cold process has no live replay or production server',blocked.status===503&&blocked.headers.get('X-Cotology-Offline')==='1');
   const expected=await native.get(EXPECTED_KEY);check('All real output expectations persist without a login profile',expected?.captureSha256===config.captureSha256&&!await native.get('lastProfile'));
   await inspectBooks();for(const book of config.books){check('Every downloaded real publication remains visible after logout and cold restart',!!card(book.id),{publicationId:book.id});const position=await native.get(`${config.profileId}:position:${book.id}`);check('Text locator survived the native close and cold restart',position?.chapter===expected.text[book.id].chapter&&Math.abs(position.position-expected.text[book.id].position)<.04,{publicationId:book.id});await lastChapter(book);}
   if(config.jobs.length){await click('audio-nav');for(const job of config.jobs)await checkAudio(job,{restore:true,expected:expected.audio[job.id]});}
   for(const book of config.books){const position=await native.get(`${config.profileId}:position:${book.id}`);check('Offline narrated playback never overwrites text progress',position.chapter===expected.text[book.id].chapter,{publicationId:book.id});}
  }else{
   await native.put(REAL_DELIVERY_CONFIG_KEY,config);await click('reader-open-server');await waitFor('Production-output replay books do not appear in the actual server library',()=>config.books.every(book=>element(`server-book-download-${book.id}`)));check('All actual server publication parts are visible before any local download',true,{parts:config.books.length});
   const expected={captureSha256:config.captureSha256,text:{},audio:{}};
   for(const group of config.groups){
    await click('discovery-nav');await waitFor('Selected real discovery result is missing',()=>element(`discovery-request-${group.requestId}`));await click(`discovery-request-${group.requestId}`);await waitFor('The selected actual book result is not ready',()=>element('discovery-ready-download'));
    if(group.audioJobs.length){await click('discovery-ready-audio');for(const id of group.audioJobs){const job=config.jobs.find(job=>job.id===id);await waitFor('Complete actual narration did not download from the combined book-and-audio action',async()=>{const summary=(await native.audioList()).find(row=>row.jobId===id);if(summary?.status==='error')throw Object.assign(Error('Native narration download failed: '+(summary.error||'AUDIO_DOWNLOAD')),{fatal:true});return summary?.status==='complete'&&summary.downloadedSegments===job.segmentCount;},3*60*60*1000,5000);}check('One combined UI action downloads every real text part and every ready narration segment',true,{requestId:group.requestId,parts:group.publicationIds.length,audioJobs:group.audioJobs.length});}
    else {await click('discovery-ready-download');await waitFor('All real text parts did not download',async()=>{for(const id of group.publicationIds)if(!await packet(id))return false;return true;},10*60*1000,500);}
   }
   await inspectBooks();const index=await native.get(LOCAL_LIBRARY_INDEX);check('The shared local library contains exactly one reference for every real immutable publication',config.books.every(book=>index.books.filter(row=>row.owner===config.profileId&&row.id===book.id).length===1));
   await click('reader-library-nav');await waitFor('Real downloaded publication cards are missing',()=>config.books.every(book=>card(book.id)));for(const book of config.books)expected.text[book.id]=await lastChapter(book,{setPosition:true});
   if(config.jobs.length){await click('audio-nav');for(const job of config.jobs)expected.audio[job.id]=await checkAudio(job);}
   for(const book of config.books){const position=await native.get(`${config.profileId}:position:${book.id}`);check('Real narrated playback preserves independently saved reading progress',position.chapter===expected.text[book.id].chapter&&Math.abs(position.position-expected.text[book.id].position)<.001,{publicationId:book.id});}
   await native.remove('lastProfile');await native.put(EXPECTED_KEY,expected);await native.flush();check('All real download and locator expectations are committed without retaining login state',!await native.get('lastProfile'));
  }
  clearTimeout(watchdog);await finish(true);
 }catch(error){clearTimeout(watchdog);results.push({name:'Exact real-output application acceptance',ok:false});await finish(false,error);}
}
