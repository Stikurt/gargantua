// Explicit native test flag only; fixture PCM is not a model-quality assessment.
import {DEVICE} from './catalogs.mjs';
import {LOCAL_LIBRARY_INDEX,refKey} from './library-state.mjs';
const native=window.cotologyNative,PROFILE='b1000000-0000-4000-8000-000000000002',BOOK='c3000000-0000-4000-8000-000000000001',NOVEL='b1000000-0000-4000-8000-000000000007',JOB='b1000000-0000-4000-8000-000000000001';
const expectedKey=`${DEVICE}:media-self-check:expected`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const element=id=>document.querySelector(`[data-testid="${id}"]`),media=()=>element('audio-element');
const buttons=(root=document)=>Array.from(root.querySelectorAll('button'));
async function waitFor(description,read,timeout=40000){let last;const deadline=Date.now()+timeout;while(Date.now()<deadline){try{const value=await read();if(value)return value;}catch(e){last=e;}await pause(70);}throw Error(description+(last?': '+last.message:''));}
async function click(read){const button=await waitFor('Не найдена доступная кнопка',()=>{const value=typeof read==='function'?read():element(read);return value&&!value.disabled?value:null;});button.click();await pause(35);}
function setControl(control,value){const prototype=control instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(control,String(value));control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true}));}
async function nav(title){await click(()=>buttons(document.querySelector('.device-nav')||document).find(b=>b.textContent.trim()===title));}
const downloadButton=id=>element(`server-book-download-${id}`);
const packet=id=>native.get(`${PROFILE}:book:${id}`);
async function fixture(path,body){const result=await native.request('/api/fixture/'+path,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});if(result.status!==200)throw Error('Fixture control failed');return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(result.data),c=>c.charCodeAt(0))));}
async function downloadFailure(id,mode){const prior=await fixture('state');await fixture('fault',{id,mode});await click(()=>downloadButton(id));await waitFor('Ошибка скачивания не была обработана',async()=>{const state=await fixture('state');return state.attempts[id]>(prior.attempts[id]||0)&&downloadButton(id)&&!downloadButton(id).disabled&&Array.from(document.querySelectorAll('.toast')).some(t=>t.textContent.includes('Скачивание не завершено'));});}
async function downloadSuccess(id){await fixture('fault',{id,mode:'normal'});await click(()=>downloadButton(id));return waitFor('Книга не скачалась через интерфейс',async()=>{const saved=await packet(id);return saved&&downloadButton(id)?.title==='Удалить локальную копию'?saved:null;});}
function localCard(id){return Array.from(document.querySelectorAll('.device-book')).find(row=>row.getAttribute('data-ref')===refKey({owner:PROFILE,id}));}
async function openLocal(id){await click(()=>localCard(id)?.querySelector('.mini-cover'));await waitFor('Текст книги не открылся',()=>document.querySelector('.reading-page p'));}
async function back(){await click(()=>element('reader-return-library')||document.querySelector('.reader-toolbar>button'));await waitFor('Локальная библиотека не вернулась',()=>document.querySelector('.device-books'));}
async function lastChapter(title,marker){if(document.querySelector('.reading-page')?.innerText.includes(marker))return;await click(()=>document.querySelector('[aria-label="Оглавление и закладки"]'));await click(()=>buttons(document.querySelector('.reader-menu')||document).find(b=>b.textContent.includes(title)));await waitFor('Последняя глава отсутствует',()=>document.querySelector('.reading-page')?.innerText.includes(marker));}
async function reference(){const summary=(await native.audioList()).find(row=>row.jobId===JOB);if(!summary)return null;const ref={scopeId:summary.scopeId,jobId:JOB},row=await native.audioGet(ref);return row?{row,ref}:null;}

export async function runMediaSelfCheck(){
 if(!native?.selfCheckMedia||typeof native.selfCheckReport!=='function')return;
 const results=[];let reported=false;
 const check=(name,value,detail)=>{results.push({name,ok:!!value,...(detail===undefined?{}:{detail})});if(!value)throw Error(name);};
 const finish=async(ok,error)=>{if(reported)return;reported=true;await native.selfCheckReport({schemaVersion:1,ok,mode:native.selfCheckOffline?'offline':'online',scope:'REAL_WINDOWS_EXE_BOOK_NOVEL_AUDIO_UI_ISOLATED_FIXTURE_NOT_PRODUCTION_OR_ANDROID',audioOutput:'MUTED_SYNTHETIC_PCM_TONE_NOT_FRESH_TTS_OR_VOICE_QUALITY',results,at:new Date().toISOString(),...(error?{error:String(error.message||error),diagnostic:document.body.innerText.slice(-14000)}:{})});};
 const watchdog=setTimeout(()=>finish(false,Error('Истекло время проверки текста и аудио')),180000);
 try{
  check('Media self-check uses a sandboxed native renderer',typeof require==='undefined'&&typeof process==='undefined'&&typeof native.audioList==='function');
  await waitFor('Библиотека не открылась',()=>document.querySelector('.device-books'));
  if(native.selfCheckOffline){
   const denied=await fetch('/api/me');check('Cold process explicitly blocks the stopped fixture server',denied.status===503&&denied.headers.get('X-Cotology-Offline')==='1');
   const expected=await native.get(expectedKey);check('Both downloads remain visible without a remembered profile',!!expected&&!await native.get('lastProfile')&&localCard(BOOK)&&localCard(NOVEL));
   check('All ordinary-book and novel chapters survive a cold process',(await packet(BOOK)).content.chapters.length===3&&(await packet(NOVEL)).content.chapters.length===12);
   await openLocal(BOOK);await lastChapter('Книга — глава 3','BOOK-LAST-3');await back();await openLocal(NOVEL);await lastChapter('Новелла — глава 12','NOVEL-LAST-12');await back();
   check('Last chapters can be read through the actual UI without any server',true);
   const text=await native.get(`${PROFILE}:position:${NOVEL}`);check('Text reading position survives independently of audio',text.chapter===11&&Math.abs(text.position-expected.text.position)<.04);
   await nav('Аудио');await waitFor('Скачанное аудио не восстановилось',()=>element(`audio-open-${JOB}`));await click(`audio-open-${JOB}`);await waitFor('Плеер не восстановился',()=>element('audio-seek'));
   const known=await reference(),position=await native.audioPositionGet(known.ref);check('All twelve synthetic chapter-tone segments survive server-free restart',known.row.status==='complete'&&known.row.downloadedSegments===12&&known.row.totalSegments===12);
   check('Audio ordinal seconds speed and manifest remain independent of the text locator',position.ordinal===expected.audio.ordinal&&Math.abs(position.seconds-expected.audio.seconds)<.15&&position.rate===expected.audio.rate&&position.manifestSha256===expected.audio.manifestSha256);
   const audio=await waitFor('Нет нативного mediaelement',()=>media());audio.muted=true;await click('audio-toggle');await waitFor('Скачанное аудио не воспроизводится без сервера',()=>!audio.paused&&audio.currentTime>position.seconds+.2);
   check('Real Chromium decoder advances private cached WAV without a server',audio.currentSrc.startsWith('cotology://app/__audio/'));await click('audio-toggle');await waitFor('Пауза офлайн не сработала',()=>audio.paused);
   check('Listening does not move the saved text chapter',(await native.get(`${PROFILE}:position:${NOVEL}`)).chapter===expected.text.chapter);
  }else{
   await nav('Сервер');await waitFor('Обе серверные карточки не появились',()=>downloadButton(BOOK)&&downloadButton(NOVEL));
   await downloadFailure(BOOK,'wrong-sha');check('Wrong SHA response never publishes an ordinary-book packet',!await packet(BOOK)&&!(await native.get(LOCAL_LIBRARY_INDEX))?.books.some(b=>b.owner===PROFILE&&b.id===BOOK));
   const ordinary=await downloadSuccess(BOOK);check('UI downloads all three ordinary-book chapters',ordinary.content.chapters.length===3&&ordinary.book.content_sha256);
   await downloadFailure(NOVEL,'abort');check('Interrupted novel download never publishes a partial packet',!await packet(NOVEL)&&!(await native.get(LOCAL_LIBRARY_INDEX))?.books.some(b=>b.owner===PROFILE&&b.id===NOVEL));
   const novel=await downloadSuccess(NOVEL);check('Retry downloads the complete twelve-chapter novel',novel.content.chapters.length===12&&novel.content.chapters[11].blocks.some(b=>b.text.includes('NOVEL-LAST-12')));
   await nav('Книги');await waitFor('Обе скачанные книги не попали в общую библиотеку',()=>localCard(BOOK)&&localCard(NOVEL));await openLocal(BOOK);await lastChapter('Книга — глава 3','BOOK-LAST-3');await back();
   check('Ordinary-book last chapter is reachable through the shipped chapter controls',true);
   await openLocal(NOVEL);await lastChapter('Новелла — глава 12','NOVEL-LAST-12');const pane=document.querySelector('.reader-scroll');pane.scrollTop=(pane.scrollHeight-pane.clientHeight)*.37;pane.dispatchEvent(new Event('scroll',{bubbles:true}));await back();
   const text=await native.get(`${PROFILE}:position:${NOVEL}`);check('Novel text position stores its last chapter and within-chapter ratio',text.chapter===11&&text.position>.25&&text.position<.5);
   await nav('Сервер');await waitFor('Серверный список не восстановился',()=>downloadButton(BOOK));await click(()=>downloadButton(BOOK));await waitFor('Локальная копия не удалена для повторной загрузки',async()=>!await packet(BOOK)&&downloadButton(BOOK)?.title==='Скачать для офлайн-чтения');await downloadSuccess(BOOK);
   const index=await native.get(LOCAL_LIBRARY_INDEX);check('Explicit UI redownload keeps one reference per immutable publication',index.books.filter(b=>b.owner===PROFILE&&b.id===BOOK).length===1&&index.books.filter(b=>b.owner===PROFILE&&b.id===NOVEL).length===1);
   check('Redownload preserves prior text reading progress',(await native.get(`${PROFILE}:position:${BOOK}`)).chapter===2);
   await nav('Аудио');const chooser=await waitFor('Нет выбора книги для озвучки',()=>document.querySelector('select[aria-label="Книга для озвучки"]'));setControl(chooser,NOVEL);await click(()=>buttons(document.querySelector('.audio-request')||document).find(b=>b.textContent.trim()==='Создать озвучку'));
   await waitFor('Запрос озвучки не создал готовую fixture карточку',()=>element(`audio-open-${JOB}`));const fixtureState=await fixture('state');check('AudioShelf sends an idempotent audio request for the selected novel',fixtureState.ttsRequests===1&&fixtureState.lastTts?.kind==='audio'&&fixtureState.lastTts.publicationIds[0]===NOVEL&&fixtureState.lastTts.idempotencyKey);
   await click(`audio-open-${JOB}`);await waitFor('Плеер готового fixture аудио не открылся',()=>element('audio-seek'));await click('audio-download');const known=await waitFor('Двенадцать аудиофрагментов не скачались',async()=>{const value=await reference();return value?.row.status==='complete'&&value.row.downloadedSegments===12&&value.row.totalSegments===12&&Array.isArray(value.row.manifest?.segments)&&value.row.manifest.segments.length===12?value:null;});
   await waitFor('Интерфейс не подтвердил полное скачивание всех аудиофрагментов',()=>element('audio-status')?.textContent.includes('Полностью скачано')&&element('audio-download')?.disabled);
   check('UI and full native manifest confirm all twelve checksummed segments are complete',known.row.status==='complete'&&known.row.totalSegments===12&&known.row.downloadedSegments===12);
   const audio=await waitFor('Audioelement не создан',()=>media());audio.muted=true;await click('audio-toggle');await waitFor('Chromium не декодирует подготовленный PCM',()=>!audio.paused&&audio.currentTime>.2);check('Real decoder plays the prepared synthetic WAV fixture',Number.isFinite(audio.duration)&&audio.duration>1);
   setControl(element('audio-rate'),1.25);await waitFor('Скорость не изменилась',()=>Math.abs(audio.playbackRate-1.25)<.001);const preceding=known.row.manifest.segments.slice(0,11).reduce((sum,segment)=>sum+segment.durationSeconds,0);setControl(element('audio-seek'),preceding+1.25);await waitFor('Перемотка в последний фрагмент не сработала',()=>audio.currentSrc.includes('/'+JOB+'/11/')&&audio.currentTime>=1.15&&!audio.paused);await click('audio-toggle');await waitFor('Пауза не сработала',()=>audio.paused);
   const audioPosition=await waitFor('Позиция аудио не сохранилась',async()=>{const value=await native.audioPositionGet(known.ref);return value?.ordinal===11&&value.seconds>=1.15&&value.rate===1.25?value:null;});check('Seek and rate save the final audio ordinal and exact seconds',true,{ordinal:audioPosition.ordinal,seconds:audioPosition.seconds,rate:audioPosition.rate});
   const textAfter=await native.get(`${PROFILE}:position:${NOVEL}`);check('Audio listening never overwrites the novel text position',textAfter.chapter===text.chapter&&Math.abs(textAfter.position-text.position)<.001);
   await native.remove('lastProfile');await native.put(expectedKey,{text:textAfter,audio:audioPosition,profile:PROFILE,book:BOOK,novel:NOVEL,job:JOB});await native.flush();check('Offline expectations are committed without retaining login profile',!await native.get('lastProfile'));
  }
  clearTimeout(watchdog);await finish(true);
 }catch(error){clearTimeout(watchdog);results.push({name:String(error.message||error),ok:false});await finish(false,error);}
}
if(native?.selfCheckMedia)runMediaSelfCheck();
