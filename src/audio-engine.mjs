import {validateAudioManifest,audioSummary,normalizeAudioPosition,seekAudioPosition,absoluteAudioPosition} from './audio.mjs';

const HASH=/^[a-f0-9]{64}$/;
const stale=()=>Object.assign(new Error('Воспроизведение изменилось'),{code:'AUDIO_STALE'});
const initial=()=>({row:null,position:null,seconds:0,totalSeconds:0,playing:false,buffering:false,error:null,rate:1});

/** A single audio element and a single, serialized stream of local position saves. */
export class AudioEngine{
 constructor({bridge,element,onState=()=>{},onError=()=>{},timeoutMs=30000}={}){
  if(!bridge||!['audioUrl','audioPositionGet','audioPositionPut'].every(name=>typeof bridge[name]==='function')||!element||typeof element.addEventListener!=='function')throw new Error('Недоступен локальный аудиоплеер');
  this.bridge=bridge;this.element=element;this.onState=onState;this.onError=onError;this.timeoutMs=timeoutMs;this.state=initial();
  this.generation=0;this.destroyed=false;this.intent=false;this.ready=false;this.restoring=false;this.sourceOrdinal=null;this.sourceUrl='';this.cancelLoad=null;this.playPending=null;this.ignorePause=0;
  this.writes=Promise.resolve();this.lastFingerprint=null;this.lastSaveAt=0;this.lastTimestamp=0;
  this.handlers={timeupdate:()=>this._time(),ended:()=>{this._ended().catch(error=>this._report(error));},pause:()=>this._paused(),playing:()=>{if(this.intent&&this.ready&&!this.destroyed)this._emit({playing:true,buffering:false});},waiting:()=>{if(this.intent&&this.ready&&!this.destroyed)this._emit({buffering:true});},canplay:()=>{if(this.ready&&!this.restoring&&!this.destroyed)this._emit({buffering:false});},error:()=>{if(this.ready&&!this.restoring&&!this.destroyed)this._report(new Error('Не удалось воспроизвести аудиофрагмент. Повторите скачивание.'));}};
  for(const [name,handler]of Object.entries(this.handlers))element.addEventListener(name,handler);
  this.lifecycle=event=>{const saved=this.flush();event?.detail?.waitUntil?.(saved);saved.catch(()=>{});};
  if(typeof globalThis.addEventListener==='function')for(const name of ['pagehide','cotology-before-close'])globalThis.addEventListener(name,this.lifecycle);
  this.visibility=()=>{if(globalThis.document?.hidden)this.lifecycle();};globalThis.document?.addEventListener('visibilitychange',this.visibility);
 }
 _emit(change={}){if(this.destroyed)return this.state;this.state={...this.state,...change};try{this.onState({...this.state,position:this.state.position?{...this.state.position}:null});}catch{}return this.state;}
 _valid(generation){return !this.destroyed&&generation===this.generation;}
 _advanceGeneration(){this.generation++;this.cancelLoad?.();this.cancelLoad=null;this.playPending=null;return this.generation;}
 _ref(row=this.state.row){return {scopeId:row.scopeId,jobId:row.jobId};}
 _options(row=this.state.row,rate=this.state.rate){return {manifestSha256:row.manifestSha256,rate,updatedAt:Date.now()};}
 _fingerprint(row,position){return JSON.stringify([row.scopeId,row.jobId,position.manifestSha256,position.ordinal,position.seconds,position.rate,position.completed]);}
 _pauseElement(){const expected=this.element.paused===false;if(expected)this.ignorePause++;try{this.element.pause();}catch{if(expected)this.ignorePause--;}}
 _clearElement(){this.ready=false;this.sourceOrdinal=null;this.sourceUrl='';this._pauseElement();try{this.element.removeAttribute('src');this.element.load();}catch{}}
 _position(position){return this._emit({position,seconds:absoluteAudioPosition(this.state.row.manifest,position,{manifestSha256:this.state.row.manifestSha256})??this.state.seconds,rate:position.rate});}
 _readTime(){
  if(!this.state.row||!this.ready||this.restoring||this.sourceOrdinal===null||this.sourceOrdinal!==this.state.position?.ordinal)return false;
  const current=this.element.currentTime,duration=this.state.row.manifest.segments[this.sourceOrdinal].durationSeconds;
  if(!Number.isFinite(current)||current<0||current>duration+1/22050)return false;
  const prefix=this.state.row.manifest.segments.slice(0,this.sourceOrdinal).reduce((sum,segment)=>sum+segment.durationSeconds,0);
  this._position(seekAudioPosition(this.state.row.manifest,prefix+Math.min(current,duration),this._options()));return true;
 }
 _time(){if(this.destroyed||this.restoring||!this.ready)return;this._readTime();if(Date.now()-this.lastSaveAt>=1000)this._persist().catch(()=>{});}
 _paused(){if(this.ignorePause>0){this.ignorePause--;return;}if(this.destroyed||this.restoring||!this.ready||this.state.buffering||this.element.ended)return;this.intent=false;this._readTime();this._emit({playing:false});this._persist().catch(()=>{});}
 _persist(explicit=false){
  const row=this.state.row,position=this.state.position;if(!row||!position||this.restoring&&!explicit)return this.writes;
  const fingerprint=this._fingerprint(row,position);if(fingerprint===this.lastFingerprint)return this.writes;
  this.lastFingerprint=fingerprint;this.lastSaveAt=Date.now();this.lastTimestamp=Math.max(this.lastSaveAt,this.lastTimestamp+1);
  const snapshot={...position,updatedAt:this.lastTimestamp};this.state={...this.state,position:snapshot};
  const save=this.writes.catch(()=>{}).then(()=>this.bridge.audioPositionPut({...this._ref(row),position:snapshot}));
  this.writes=save.catch(error=>{if(this.lastFingerprint===fingerprint)this.lastFingerprint=null;this._notify(error);throw error;});
  // An event may start a save without anyone awaiting its promise.
  this.writes.catch(()=>{});return this.writes;
 }
 _notify(error){if(error?.code==='AUDIO_STALE'||this.destroyed)return;try{this.onError(error instanceof Error?error:new Error(String(error)));}catch{}}
 _report(error){if(error?.code==='AUDIO_STALE'||this.destroyed)return this.state;this.intent=false;this.restoring=false;this.ready=false;this._pauseElement();this._emit({playing:false,buffering:false,error:error?.message||'Не удалось воспроизвести аудио'});this._notify(error);return this.state;}
 async open(value){
  if(this.destroyed)throw new Error('Плеер закрыт');
  if(!value||!HASH.test(value.scopeId||'')||!HASH.test(value.manifestSha256||''))throw new Error('Неверная аудиокнига');
  const manifest=validateAudioManifest(value.manifest,{expectedJobId:value.jobId}),row={...value,manifest};
  await this.pause().catch(()=>{});const generation=this._advanceGeneration();this.intent=false;this.restoring=true;this._clearElement();this._emit({buffering:true,error:null});
  try{const saved=await this.bridge.audioPositionGet(this._ref(row));if(!this._valid(generation))return this.state;const position=saved===null?seekAudioPosition(manifest,0,this._options(row,1)):normalizeAudioPosition(manifest,saved,{manifestSha256:row.manifestSha256});if(!position)throw new Error('Сохранённая позиция аудио повреждена или относится к другой версии. Прежняя позиция сохранена.');this.restoring=false;this.lastFingerprint=saved===null?null:this._fingerprint(row,position);this.lastSaveAt=Date.now();this._emit({...initial(),row,totalSeconds:audioSummary(manifest).totalDurationSeconds});this._position(position);return this.state;}
  catch(error){if(this._valid(generation)){this.restoring=false;this._emit({playing:false,buffering:false,error:error?.message||'Не удалось открыть аудиокнигу'});this._notify(error);throw error;}return this.state;}
 }
 async _prepare(position,generation){
  if(!this._valid(generation))throw stale();
  if(this.ready&&this.sourceOrdinal===position.ordinal&&this.sourceUrl){this.restoring=true;try{this.element.currentTime=position.seconds;this.element.playbackRate=this.state.rate;}finally{this.restoring=false;}return;}
  this.ready=false;this.restoring=true;this._emit({buffering:true,playing:false,error:null});this._pauseElement();
  const row=this.state.row,result=await this.bridge.audioUrl({...this._ref(row),ordinal:position.ordinal});if(!this._valid(generation))throw stale();
  const expected=`cotology://app/__audio/${row.scopeId}/${row.jobId}/${position.ordinal}/${row.manifest.segments[position.ordinal].sha256}.wav`;
  if(result?.url!==expected)throw new Error('Плеер отклонил неподтверждённый адрес аудио');
  this.sourceOrdinal=position.ordinal;this.sourceUrl=expected;
  await new Promise((resolve,reject)=>{
   let finished=false,metadata=false;const events=['loadedmetadata','canplay','seeked','loadeddata'];
   const cleanup=()=>{clearTimeout(timeout);for(const name of events)this.element.removeEventListener(name,check);this.element.removeEventListener('error',failed);if(this.cancelLoad===cancel)this.cancelLoad=null;};
   const finish=error=>{if(finished)return;finished=true;cleanup();error?reject(error):resolve();};
   const cancel=()=>finish(stale());
   const failed=()=>finish(new Error('Аудиофрагмент недоступен или повреждён. Повторите скачивание.'));
   const check=()=>{
    if(!this._valid(generation))return finish(stale());
    const actual=this.element.currentSrc||this.element.src;
    if(actual!==expected||this.element.readyState<1||!Number.isFinite(this.element.duration)||this.element.duration<=0)return;
    const declared=row.manifest.segments[position.ordinal].durationSeconds;if(Math.abs(this.element.duration-declared)>0.025)return finish(new Error('Длительность аудио не совпадает с проверенным фрагментом'));
    if(!metadata){metadata=true;try{this.element.currentTime=position.seconds;this.element.playbackRate=this.state.rate;}catch(error){return finish(error);}}
    if(this.element.readyState>=3&&!this.element.seeking&&Number.isFinite(this.element.currentTime)&&Math.abs(this.element.currentTime-position.seconds)<=0.025)finish();
   };
   const timeout=setTimeout(()=>finish(new Error('Не удалось подготовить аудио. Повторите попытку.')),this.timeoutMs);
   this.cancelLoad=cancel;for(const name of events)this.element.addEventListener(name,check);this.element.addEventListener('error',failed);
   try{this.element.src=expected;this.element.load();check();}catch(error){finish(error);}
  });
  if(!this._valid(generation))throw stale();this.ready=true;this.restoring=false;this._emit({buffering:false,error:null});
 }
 async _start(generation){
  try{await this._prepare(this.state.position,generation);if(!this._valid(generation)||!this.intent)return this.state;await this.element.play();if(!this._valid(generation))return this.state;if(!this.intent){this._pauseElement();return this.state;}this._emit({playing:true,buffering:false,error:null});return this.state;}
  catch(error){if(this._valid(generation))this._report(error);return this.state;}
 }
 play(){
  if(this.destroyed||!this.state.row||!this.state.position)return Promise.resolve(this.state);
  if(this.playPending&&this.intent)return this.playPending;
  if(this.state.playing&&this.intent)return Promise.resolve(this.state);
  const generation=this._advanceGeneration();this.intent=true;
  if(this.state.position.completed){this._position(seekAudioPosition(this.state.row.manifest,0,this._options()));this._persist().catch(()=>{});}
  const promise=this._start(generation).finally(()=>{if(this.playPending===promise)this.playPending=null;});this.playPending=promise;return promise;
 }
 async pause(){
  if(this.destroyed)return this.writes.catch(()=>{});this.intent=false;this._readTime();this._advanceGeneration();this.restoring=false;this._pauseElement();this._emit({playing:false,buffering:false});await this._persist();return this.state;
 }
 async seek(seconds){
  if(this.destroyed||!this.state.row||!this.state.position)return this.state;
  const position=seekAudioPosition(this.state.row.manifest,seconds,this._options()),wasPlaying=this.intent,generation=this._advanceGeneration();this.intent=false;this._pauseElement();this.restoring=false;this._position(position);this._emit({playing:false,buffering:false,error:null});
  await this._persist();if(!this._valid(generation))return this.state;
  if(this.ready&&this.sourceOrdinal===position.ordinal){this.restoring=true;try{this.element.currentTime=position.seconds;}finally{this.restoring=false;}}
  else{this.ready=false;}
  if(wasPlaying&&!position.completed){this.intent=true;await this._start(generation);}return this.state;
 }
 async setRate(rate){
  if(!Number.isFinite(rate)||rate<0.5||rate>2)throw new Error('Выберите скорость от 0,5 до 2');if(this.destroyed||!this.state.position)return this.state;
  this._readTime();const position={...this.state.position,rate,updatedAt:Date.now()};this._position(position);this.element.playbackRate=rate;await this._persist(true);return this.state;
 }
 async _ended(){
  if(this.destroyed||!this.intent||!this.ready||this.restoring||this.sourceOrdinal===null)return;
  const ordinal=this.sourceOrdinal,row=this.state.row,generation=this._advanceGeneration();this.ready=false;this.restoring=false;this._emit({playing:false});
  const seconds=row.manifest.segments.slice(0,ordinal+1).reduce((sum,segment)=>sum+segment.durationSeconds,0),position=seekAudioPosition(row.manifest,seconds,this._options());this._position(position);await this._persist();
  if(!this._valid(generation))return;if(position.completed){this.intent=false;this._emit({playing:false,buffering:false});return;}await this._start(generation);
 }
 async flush(){if(!this.destroyed)this._readTime();await this._persist();return this.state;}
 async clear(){
  if(this.destroyed)return this.state;this.intent=false;this._readTime();const generation=this._advanceGeneration();this.restoring=false;this._pauseElement();this._emit({playing:false,buffering:false});await this._persist();if(!this._valid(generation))return this.state;
  this._clearElement();this.lastFingerprint=null;this.lastSaveAt=0;this._emit(initial());return this.state;
 }
 async destroy(){
  if(this.destroyed)return this.writes.catch(()=>{});let pending;try{pending=this.pause();}catch(error){this._notify(error);}this._advanceGeneration();this.destroyed=true;this.intent=false;this.cancelLoad?.();this.cancelLoad=null;
  for(const [name,handler]of Object.entries(this.handlers))this.element.removeEventListener(name,handler);
  if(typeof globalThis.removeEventListener==='function')for(const name of ['pagehide','cotology-before-close'])globalThis.removeEventListener(name,this.lifecycle);globalThis.document?.removeEventListener('visibilitychange',this.visibility);
  this._clearElement();await pending;await this.writes;return this.state;
 }
}
