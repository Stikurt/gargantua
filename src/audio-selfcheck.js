// This module is imported only by the isolated native audio self-check. It
// exercises the shipped React controls and the real Chromium audio decoder.
const JOB='b1000000-0000-4000-8000-000000000001',PROFILE='b1000000-0000-4000-8000-000000000002';
const native=window.cotologyNative;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const element=id=>document.querySelector(`[data-testid="${id}"]`);
const media=()=>element('audio-element')||document.querySelector('audio');
async function waitFor(description,read,{timeout=25000}={}){
 const deadline=Date.now()+timeout;let last;
 while(Date.now()<deadline){try{const value=await read();if(value)return value;}catch(error){last=error;}await delay(80);}
 throw Error(description+(last?' — '+last.message:''));
}
async function click(id){const button=await waitFor('Нет доступной кнопки '+id,()=>{const value=element(id);return value&&!value.disabled?value:null;});button.click();await delay(40);}
function setControl(control,value){
 const prototype=control instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(prototype,'value').set.call(control,String(value));
 control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true}));
}
async function batchFixture(){const response=await native.request('/api/fixture/chapter-batches',{});if(response.status===404)return null;if(response.status!==200)throw Error('Batch fixture identity unavailable');return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(response.data),value=>value.charCodeAt(0))));}
async function reference(){const rows=await native.audioList({}),listed=rows.find(value=>value.jobId===JOB);if(!listed)return null;const ref={scopeId:listed.scopeId,jobId:JOB},row=await native.audioGet(ref);return {row,ref};}
export async function runAudioSelfCheck(){
 if(!native?.selfCheckAudio||typeof native.selfCheckReport!=='function')return;
 const results=[];let reported=false,audioCapabilities;
 const check=(name,condition,detail)=>{results.push({name,ok:!!condition,...(detail===undefined?{}:{detail})});if(!condition)throw Error(name);};
 const finish=async(ok,error)=>{if(reported)return;reported=true;await native.selfCheckReport({schemaVersion:1,ok,mode:native.selfCheckOffline?'offline':'online',narrowDesktopWindow:!!native.selfCheckMobile,viewport:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth},audioCapabilities,results,at:new Date().toISOString(),...(error?{error:String(error.message||error),diagnostic:document.body.innerText.slice(-10000)}:{}),audioOutput:'MUTED_SELF_CHECK_NOT_A_LISTENING_QUALITY_ASSESSMENT'});};
 const viewport=name=>check(name,document.documentElement.scrollWidth<=innerWidth+1,{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,narrowDesktopWindow:!!native.selfCheckMobile});
 const capture=async name=>{if(typeof native.selfCheckCapture==='function')await native.selfCheckCapture(name);};
 const watchdog=setTimeout(()=>finish(false,Error('Истекло время проверки реального аудиоплеера')),80000);
 try{
  check('Renderer remains sandboxed',typeof require==='undefined'&&typeof process==='undefined');
  check('Private native audio bridge is available',['audioRegister','audioList','audioGet','audioDownload','audioCancel','audioPositionGet','audioPositionPut','audioUrl'].every(name=>typeof native[name]==='function'));
  audioCapabilities=await native.audioCapabilities();let readonly=false;try{await native.audioCapabilities({maxAudioBytes:32*1024**3});}catch{readonly=true;}
  check('Windows native audio capability is confirmed through restricted IPC',audioCapabilities?.schemaVersion===1&&audioCapabilities.platform==='windows'&&audioCapabilities.maxAudioBytes===16*1024**3&&audioCapabilities.freeReserveBytes===512*1024**2&&audioCapabilities.maxSegments===8192&&readonly);
  if(!native.selfCheckOffline){
   // This is a dedicated app data directory. Remove only the fixed fixture's
   // previous audio record so a repeated online run must download fresh bytes.
   for(const prior of await native.audioList())if(prior.jobId===JOB)await native.audioRemove({scopeId:prior.scopeId,jobId:JOB});
  }
  await click('audio-nav');
  if(native.selfCheckOffline){
   const response=await fetch('/api/me');check('Offline process explicitly denies server API access',response.status===503&&response.headers.get('X-Cotology-Offline')==='1');
  }else await click('audio-refresh');
  if(!native.selfCheckOffline){
   const before=await batchFixture();
   if(before?.enabled){
    await waitFor('Нет формы выбора глав',()=>element('audio-batch-book'));
    check('Opening the chapter controls never automatically submits a full book',before.creates.length===0&&Number(element('audio-batch-count').value)===5&&Number(element('audio-batch-start').value)===1);
    setControl(element('audio-batch-book'),'b1000000-0000-4000-8000-000000000007');await delay(80);
    setControl(element('audio-batch-start'),4);await delay(80);setControl(element('audio-batch-count'),3);await delay(80);await click('audio-batch-submit');
    const first=await waitFor('Не сохранён выбранный пакет',async()=>{const state=await batchFixture();return state.creates.length===1?state:null;});
    check('The actual form sends exactly the chosen chapter start and count',first.creates[0].chapterRange.start===4&&first.creates[0].chapterRange.count===3&&first.creates[0].publicationIds.length===1&&first.creates[0].publicationIds[0]==='b1000000-0000-4000-8000-000000000007');
    await click('audio-batch-submit');const retry=await waitFor('Повтор пакета не дошёл до fixture',async()=>{const state=await batchFixture();return state.creates.length===2?state:null;});
    check('Repeated chapter submission reuses its durable intent instead of creating another job',retry.uniqueJobs===1&&retry.creates[0].idempotencyKey===retry.creates[1].idempotencyKey);
    await click('audio-next-batch-'+JOB);const next=await waitFor('Следующие главы не запрошены',async()=>{const state=await batchFixture();return state.creates.length===3?state:null;});
    check('Only the explicit next-five button requests chapters6–10 of the same pinned source',next.uniqueJobs===2&&next.creates[2].chapterRange.start===6&&next.creates[2].chapterRange.count===5&&JSON.stringify(next.creates[2].publicationIds)===JSON.stringify(next.creates[0].publicationIds)&&next.creates[2].idempotencyKey!==next.creates[0].idempotencyKey);
   }
  }
  await waitFor('Аудиокнига не появилась в настоящем интерфейсе',()=>element('audio-card-'+JOB));
  const open=element('audio-open-'+JOB)||element('audio-card-'+JOB)?.querySelector('[data-testid="audio-play"],button');
  check('Fixture audio is discoverable in the actual React library',!!open);open.click();
  await waitFor('Плеер не открылся',()=>element('audio-seek'));
  if(!native.selfCheckOffline&&(await batchFixture())?.enabled)check('The next-five action remains available after registering the current package on the device',!!element('audio-next-batch-'+JOB));
  viewport('Full player fits its desktop viewport without horizontal page scrolling');
  if(native.selfCheckMobile)check('Narrow layout is tested in a desktop Chromium window',innerWidth>=360&&innerWidth<=420,{width:innerWidth});
  if(native.selfCheckOffline){
   const known=await reference();check('Both verified chunks survive a fresh offline process',known?.row.status==='complete'&&known.row.downloadedSegments===2&&known.row.totalSegments===2);
   const expected=await native.get(PROFILE+':audio-self-check:expected'),position=await native.audioPositionGet(known.ref);
   check('Resume position and playback speed survive process restart',!!expected&&position?.manifestSha256===expected.manifestSha256&&position.ordinal===expected.ordinal&&Math.abs(position.seconds-expected.seconds)<0.15&&position.rate===expected.rate,{ordinal:position?.ordinal,seconds:position?.seconds,rate:position?.rate});
   const current=await waitFor('Локальный аудиофрагмент не подготовлен',()=>media());current.muted=true;
   await click(element('audio-play')?'audio-play':'audio-toggle');
   await waitFor('Аудио без сервера не начало воспроизводиться',()=>{const value=media();return value&&!value.paused&&value.readyState>=2&&value.currentTime>position.seconds+0.2?value:null;});
   check('Chromium decodes and advances private local audio with the server disabled',media().currentSrc.startsWith('cotology://app/__audio/'));
   await capture('restored-player');
   await click(element('audio-pause')?'audio-pause':'audio-toggle');await waitFor('Пауза офлайн не сработала',()=>media()?.paused);
   const saved=await waitFor('Новая позиция офлайн не сохранилась',async()=>{const value=await native.audioPositionGet(known.ref);return value&&value.seconds>position.seconds?value:null;});
   check('Offline playback saves its advanced position',saved.ordinal===position.ordinal&&saved.rate===position.rate);
  }else{
   const current=await waitFor('Аудиоэлемент не подготовлен',()=>media());current.muted=true;
   await click(element('audio-play')?'audio-play':'audio-toggle');
   await waitFor('Настоящий аудиодекодер не начал воспроизведение',()=>{const value=media();return value&&!value.paused&&value.readyState>=2&&value.currentTime>0.25?value:null;});
   check('Real Chromium audio playback advances beyond zero',media().currentTime>0.25&&Number.isFinite(media().duration),{duration:media().duration});
   await click(element('audio-pause')?'audio-pause':'audio-toggle');await waitFor('Пауза не сработала',()=>media()?.paused);
   await click('audio-download');
   const complete=await waitFor('Полное скачивание аудио не завершилось',async()=>{const value=await reference();return value?.row.status==='complete'&&value.row.downloadedSegments===2?value:null;});
   check('Explicit UI download saves every verified fragment',complete.row.totalSegments===2&&complete.row.downloadedSegments===2,{downloadedBytes:complete.row.downloadedBytes});
   const firstDuration=complete.row.manifest.segments[0].durationSeconds;
   setControl(element('audio-seek'),Math.max(0,firstDuration-0.18));
   await delay(220);if(media())media().muted=true;
   await click(element('audio-play')?'audio-play':'audio-toggle');
   await waitFor('Переход к следующему аудиофрагменту не произошёл',()=>{const value=media();return value?.currentSrc.includes('/'+JOB+'/1/')&&!value.paused&&value.currentTime>0.15?value:null;});
   check('End of a fragment automatically starts the next fragment',media().currentSrc.includes('/'+JOB+'/1/'));
   setControl(element('audio-rate'),1.25);await waitFor('Скорость воспроизведения не изменилась',()=>Math.abs((media()?.playbackRate||0)-1.25)<0.001);
   setControl(element('audio-seek'),firstDuration+1.5);await waitFor('Перемотка во второй фрагмент не сработала',()=>media()?.currentSrc.includes('/'+JOB+'/1/')&&media()?.currentTime>=1.4&&media()?.currentTime<3);
   viewport('Playing full player has no horizontal page overflow');await capture('full-player');
   const source=media().currentSrc,before=media().currentTime;
   const booksButton=Array.from(document.querySelectorAll('.device-nav button')).find(button=>button.textContent.trim()==='Книги');check('Books navigation remains available during playback',!!booksButton);booksButton.click();
   const mini=await waitFor('Мини-плеер не появился в разделе книг',()=>element('audio-mini'));
   await waitFor('Воспроизведение прервалось при переходе к книгам',()=>media()?.currentSrc===source&&!media().paused&&media().currentTime>before+0.2);
   check('Audio keeps advancing in the mini-player while browsing books',media().currentSrc===source&&!media().paused);viewport('Mini-player fits its desktop viewport');await capture('mini-player');
   const miniOpen=mini.querySelector('.audio-mini-title');check('Mini-player can reopen the active full player',!!miniOpen);miniOpen.click();await waitFor('Полный плеер не восстановился из мини-плеера',()=>element('audio-seek'));
   check('Reopening the full player preserves active audio and position',media().currentSrc===source&&!media().paused&&media().currentTime>=before);viewport('Restored full player fits its desktop viewport');
   await click(element('audio-pause')?'audio-pause':'audio-toggle');await waitFor('Финальная пауза не сработала',()=>media()?.paused);
   const saved=await waitFor('Позиция и скорость не записаны на диск',async()=>{const position=await native.audioPositionGet(complete.ref);return position?.ordinal===1&&position.seconds>=1.4&&position.seconds<complete.row.manifest.segments[1].durationSeconds-0.2&&position.rate===1.25?position:null;});
   await native.put(PROFILE+':audio-self-check:expected',saved);check('Pause durably stores exact fragment position and speed',saved.ordinal===1&&!saved.completed,{ordinal:saved.ordinal,seconds:saved.seconds,rate:saved.rate});
   await click('audio-close');check('Closing the full player preserves the mini-player',!!await waitFor('Мини-плеер не появился',()=>element('audio-mini')));
  }
  check('No React error boundary is shown',!document.querySelector('[data-testid="audio-fatal-error"]'));
  viewport('Final application layout has no horizontal page overflow');
  clearTimeout(watchdog);await finish(true);
 }catch(error){clearTimeout(watchdog);results.push({name:String(error.message||error),ok:false});await finish(false,error);}
}
if(native?.selfCheckAudio)runAudioSelfCheck();
