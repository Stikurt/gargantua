const{app,BrowserWindow,protocol,ipcMain,session,safeStorage,dialog}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const{randomUUID,createHash}=require('node:crypto');
const{SqliteStore}=require('./sqlite-store.cjs');
const{createCloseCoordinator}=require('./close-coordinator.cjs');
const{AudioService}=require('./audio-service.cjs');
const audioSelfCheck=process.argv.includes('--audio-self-check');
const readerSelfCheck=process.argv.includes('--reader-self-check');
const mediaSelfCheck=process.argv.includes('--reader-media-self-check');
const discoverySelfCheck=process.argv.includes('--discovery-self-check');
const audioSelfCheckMobile=audioSelfCheck&&process.argv.includes('--audio-self-check-mobile');
const selfCheck=process.argv.includes('--self-check')||audioSelfCheck||readerSelfCheck||mediaSelfCheck||discoverySelfCheck,offlineCheck=selfCheck&&process.argv.includes('--offline');
if(mediaSelfCheck&&(audioSelfCheck||readerSelfCheck||process.argv.includes('--self-check')))throw new Error('Reader media self-check requires its own isolated mode');
if(discoverySelfCheck&&(audioSelfCheck||readerSelfCheck||mediaSelfCheck||process.argv.includes('--self-check')))throw new Error('Discovery self-check requires its own isolated mode');
let SERVER='http://127.0.0.1:3080';const ORIGIN='cotology://app';
if(audioSelfCheck&&process.env.COTOLOGY_AUDIO_FIXTURE_ORIGIN){const value=process.env.COTOLOGY_AUDIO_FIXTURE_ORIGIN;if(!/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(value)||new URL(value).port==='0'||Number(new URL(value).port)>65535)throw new Error('Invalid loopback audio fixture');SERVER=value;}
if(readerSelfCheck&&!offlineCheck&&!process.env.COTOLOGY_READER_FIXTURE_ORIGIN)throw new Error('Reader self-check requires its own explicit loopback fixture');
if(readerSelfCheck&&process.env.COTOLOGY_READER_FIXTURE_ORIGIN){const value=process.env.COTOLOGY_READER_FIXTURE_ORIGIN;if(!/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(value)||Number(new URL(value).port)>65535||new URL(value).port==='3080')throw new Error('Invalid isolated loopback reader fixture');SERVER=value;}
if(mediaSelfCheck&&!offlineCheck&&!process.env.COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN)throw new Error('Reader media self-check requires its own explicit loopback fixture');
if(mediaSelfCheck&&process.env.COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN){const value=process.env.COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN,match=/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value);if(!match||Number(match[1])>65535||Number(match[1])===3080)throw new Error('Invalid isolated loopback reader media fixture');SERVER=value;}
if(discoverySelfCheck&&!offlineCheck&&!process.env.COTOLOGY_DISCOVERY_FIXTURE_ORIGIN)throw new Error('Discovery self-check requires its own explicit loopback fixture');
if(discoverySelfCheck&&process.env.COTOLOGY_DISCOVERY_FIXTURE_ORIGIN){const value=process.env.COTOLOGY_DISCOVERY_FIXTURE_ORIGIN,match=/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value);if(!match||Number(match[1])>65535||Number(match[1])===3080)throw new Error('Invalid isolated loopback discovery fixture');SERVER=value;}
protocol.registerSchemesAsPrivileged([{scheme:'cotology',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
app.setName('Gargantua Personal Library');app.setPath('userData',path.join(app.getPath('appData'),discoverySelfCheck?'Cotology-DiscoverySelfCheck':mediaSelfCheck?'Cotology-MediaSelfCheck':readerSelfCheck?'Cotology-ReaderSelfCheck':audioSelfCheckMobile?'Cotology-AudioSelfCheck-Mobile':audioSelfCheck?'Cotology-AudioSelfCheck':selfCheck?'Cotology-SelfCheck':'Cotology'));
app.setAppUserModelId('local.cotology.reader');
const single=app.requestSingleInstanceLock();if(!single)app.quit();
let window,cookie='',store,audio,allowClose=false,closing=false,finalizing=false,finishPromise=null,closeCoordinator;
const nativePending=new Set();
const dataDir=app.getPath('userData'),sessionFile=path.join(dataDir,'session.enc'),dist=path.join(__dirname,'dist');
const explicitReport=selfCheck?process.argv.find(value=>value.startsWith('--self-check-report='))?.slice('--self-check-report='.length):null;
if(explicitReport&&(!path.isAbsolute(explicitReport)||path.extname(explicitReport)!=='.json'))throw new Error('Self-check report must be an absolute JSON filename');
const csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
function tracked(action){if(finalizing)throw new Error('Приложение завершает сохранение');const promise=Promise.resolve().then(action);nativePending.add(promise);promise.finally(()=>nativePending.delete(promise)).catch(()=>{});return promise;}
async function finishClose(detail={}){
 if(finishPromise)return finishPromise;
 finalizing=true;
 finishPromise=(async()=>{
  const report={schemaVersion:1,at:new Date().toISOString(),attemptId:detail.attemptId,rendererAcknowledged:detail.acknowledged===true,timedOut:false,rejectedPromises:detail.rejectedPromises||0,storageFlushed:false,storageClosed:false,audioClosed:false};
  try{
   await Promise.allSettled([...nativePending]);
   await store?.flush();report.storageFlushed=true;
   await audio?.close();report.audioClosed=true;
   await store?.close();report.storageClosed=true;
   await fs.writeFile(path.join(dataDir,'close-status.json'),JSON.stringify(report)).catch(()=>{});
   allowClose=true;app.quit();
  }catch(error){
   report.failed=true;await fs.writeFile(path.join(dataDir,'close-status.json'),JSON.stringify(report)).catch(()=>{});
   finalizing=false;closing=false;finishPromise=null;
   throw error;
  }
 })();return finishPromise;
}
async function saveSession(){
 if(safeStorage.isEncryptionAvailable()){
  await fs.mkdir(dataDir,{recursive:true});
  if(cookie)await fs.writeFile(sessionFile,safeStorage.encryptString(cookie));
  else await fs.unlink(sessionFile).catch(()=>{});
 }
}
async function apiProxy(request,url){
 if(offlineCheck)return new Response('{"error":"Offline self-check"}',{status:503,headers:{'Content-Type':'application/json','X-Cotology-Offline':'1'}});
 if(request.initiatorOrigin&&request.initiatorOrigin!==ORIGIN)return new Response('Forbidden',{status:403});
 if(!['GET','POST','PUT','DELETE'].includes(request.method))return new Response('Method not allowed',{status:405});
 const headers={'X-Cotology':'1','Origin':'http://localhost:3080'};
 for(const key of['content-type','x-csrf-token'])if(request.headers.get(key))headers[key]=request.headers.get(key);
 if(cookie)headers.Cookie=cookie;
 let body;
 if(request.method!=='GET'){
  const chunks=[];let size=0;const reader=request.body?.getReader();
  if(reader){while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>21*1024*1024){await reader.cancel();return new Response('{"error":"Файл превышает лимит"}',{status:413,headers:{'Content-Type':'application/json'}});}chunks.push(Buffer.from(part.value));}body=Buffer.concat(chunks);}
 }
 try{
  const result=await fetch(SERVER+url.pathname+url.search,{method:request.method,headers,body,redirect:'error',signal:AbortSignal.timeout(90000)});
  for(const value of result.headers.getSetCookie())if(value.startsWith('cotology=')){cookie=value.split(';')[0];if(cookie==='cotology=')cookie='';await saveSession();}
  const responseHeaders=new Headers(result.headers);responseHeaders.delete('set-cookie');responseHeaders.delete('content-encoding');responseHeaders.delete('content-length');responseHeaders.set('Content-Security-Policy',csp);responseHeaders.set('X-Content-Type-Options','nosniff');
  return new Response(result.body,{status:result.status,headers:responseHeaders});
 }catch{return new Response('{"error":"Домашний сервер недоступен"}',{status:503,headers:{'Content-Type':'application/json','X-Cotology-Offline':'1'}});}
}
async function nativeRequest(requestPath,options={}){
 if(typeof requestPath!=='string'||requestPath.length>4096||!requestPath.startsWith('/api/')||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['method','headers','body'].includes(key)))throw new Error('Неверный запрос приложения');
 const url=new URL(ORIGIN+requestPath);if(url.host!=='app'||!url.pathname.startsWith('/api/')||url.hash)throw new Error('Неверный адрес API');
 const method=options.method||'GET';if(!['GET','POST','PUT','DELETE'].includes(method))throw new Error('Недопустимый метод API');
 const headers=new Headers(options.headers||{});if([...headers].length>30)throw new Error('Слишком много заголовков');
 if(options.body!==undefined&&(typeof options.body!=='string'||Buffer.byteLength(options.body)>21*1024*1024))throw new Error('Неверное тело запроса');
 const response=await apiProxy(new Request(url,{method,headers,...(options.body!==undefined?{body:options.body}:{})}),url);
 const limit=32*1024*1024,declared=response.headers.get('content-length');
 const oversized=()=>({status:413,type:'application/json',data:Buffer.from(JSON.stringify({error:'Ответ сервера превышает 32 МБ'})).toString('base64'),headers:{},offline:false});
 if(declared&&(!/^\d+$/.test(declared)||Number(declared)>limit)){await response.body?.cancel();return oversized();}
 const reader=response.body?.getReader(),chunks=[];let bytes=0;
 if(reader)while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>limit){await reader.cancel();return oversized();}chunks.push(Buffer.from(next.value));}
 const outputHeaders={'content-length':String(bytes)};for(const name of ['x-content-sha256','etag'])if(response.headers.get(name))outputHeaders[name]=response.headers.get(name);
 return {status:response.status,type:response.headers.get('content-type')||'application/json',data:Buffer.concat(chunks,bytes).toString('base64'),headers:outputHeaders,offline:response.headers.get('X-Cotology-Offline')==='1'};
}
app.whenReady().then(async()=>{
 await fs.mkdir(dataDir,{recursive:true});store=new SqliteStore(path.join(dataDir,'library'));await store.init();
 const validators=await import('./audio.mjs');audio=new AudioService(path.join(dataDir,'audio'),{validators,server:()=>SERVER,cookie:()=>cookie,offline:()=>offlineCheck});await audio.store.init();
 try{if(safeStorage.isEncryptionAvailable())cookie=safeStorage.decryptString(await fs.readFile(sessionFile));}catch{}
 if(selfCheck&&!offlineCheck&&process.env.COTOLOGY_SELF_CHECK_CREDENTIALS){
  const credentials=JSON.parse((await fs.readFile(process.env.COTOLOGY_SELF_CHECK_CREDENTIALS,'utf8')).replace(/^\uFEFF/,''));
  const login=await fetch(SERVER+'/api/login',{method:'POST',headers:{'X-Cotology':'1','Content-Type':'application/json'},body:JSON.stringify({login:credentials.login,password:credentials.password})});
  if(!login.ok)throw new Error('Self-check authentication failed');
  cookie=login.headers.getSetCookie().find(v=>v.startsWith('cotology=')).split(';')[0];await saveSession();
 }
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 protocol.handle('cotology',async request=>{
  const url=new URL(request.url);if(url.host!=='app')return new Response('Not found',{status:404});
  if(url.pathname.startsWith('/__audio/'))return audio.serve(request);
  if(url.pathname.startsWith('/api/'))return apiProxy(request,url);
  let relative;try{relative=decodeURIComponent(url.pathname);}catch{return new Response('Invalid path',{status:400});}
  if(relative==='/')relative='/index.html';
  const root=selfCheck&&relative.startsWith('/__selfcheck/')?path.join(__dirname,'selfcheck'):dist;
  if(root!==dist)relative=relative.slice('/__selfcheck'.length);
  const file=path.resolve(root,'.'+relative);
  if(!file.startsWith(root+path.sep)||!['.html','.js','.css','.png','.svg','.webmanifest'].includes(path.extname(file)))return new Response('Not found',{status:404});
  try{const contents=await fs.readFile(file);const types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};return new Response(contents,{headers:{'Content-Type':types[path.extname(file)],'Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff'}});}catch{return new Response('Not found',{status:404});}
 });
 const permitted=event=>{if(!window||event.sender.id!==window.webContents.id||event.senderFrame?.parent!==null||!event.senderFrame?.url.startsWith(ORIGIN+'/'))throw new Error('Недоверенный отправитель');};
 for(const name of['get','put','remove','keys','entries','apply','flush'])ipcMain.handle('store:'+name,async(event,...args)=>{permitted(event);return tracked(()=>store[name](...args));});
 ipcMain.handle('store:backupLibrary',async event=>{permitted(event);if(closing)throw new Error('Приложение закрывается');const choice=await dialog.showOpenDialog(window,{title:'Куда сохранить резервную копию книг и настроек',properties:['openDirectory','createDirectory']});if(choice.canceled||choice.filePaths.length!==1)return {cancelled:true};const target=path.join(choice.filePaths[0],'Gargantua-backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));return tracked(async()=>{const report=await store.exportSnapshot(target);return {cancelled:false,path:target,status:report.status,files:report.files.length,logicalBytes:report.logicalBytes,audioIncluded:false};});});
 ipcMain.handle('api:request',async(event,requestPath,options)=>{permitted(event);return nativeRequest(requestPath,options);});
 for(const[name,method]of Object.entries({audioCapabilities:'capabilities',audioRegister:'register',audioList:'list',audioGet:'get',audioDownload:'download',audioCancel:'cancel',audioRemove:'remove',audioPositionGet:'positionGet',audioPositionPut:'positionPut',audioUrl:'url'}))ipcMain.handle('audio:'+name,async(event,value)=>{permitted(event);return tracked(()=>audio[method](value));});
 ipcMain.on('cotology:ready-to-close',(event,detail)=>{try{permitted(event);closeCoordinator?.acknowledge(detail);}catch{}});
 if(selfCheck)ipcMain.handle('self-check:report',async(event,result)=>{permitted(event);const prefix=discoverySelfCheck?'discovery-'+(offlineCheck?'offline':'online'):mediaSelfCheck?'reader-media-'+(offlineCheck?'offline':'online'):readerSelfCheck?'reader-'+(offlineCheck?'offline':'online'):audioSelfCheck?'audio-'+(offlineCheck?'offline':'online'):offlineCheck?'offline':'online';let report=result;if(audioSelfCheck){const executable=app.getPath('exe'),manifestFile=path.join(path.dirname(executable),'release-manifest.json'),info=await fs.lstat(manifestFile);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new Error('Native audio proof needs a bounded release manifest');const manifest=await fs.readFile(manifestFile),capabilities=audio.capabilities();report={...result,nativeAudioProof:{schemaVersion:1,kind:'gargantua-native-audio-capability-proof',observedAt:new Date().toISOString(),executable,releaseManifestSha256:createHash('sha256').update(manifest).digest('hex'),rendererIpcEchoMatches:JSON.stringify(result.audioCapabilities)===JSON.stringify(capabilities),capabilities}};}const text=JSON.stringify(report,null,2);if(Buffer.byteLength(text)>1024*1024)throw new Error('Self-check report exceeded its bound');await fs.writeFile(explicitReport||path.join(dataDir,prefix+'-report.json'),text);if(audioSelfCheck||readerSelfCheck||mediaSelfCheck||discoverySelfCheck)await fs.writeFile(path.join(dataDir,prefix+'-screenshot.png'),(await window.webContents.capturePage()).toPNG());setTimeout(()=>(readerSelfCheck||mediaSelfCheck||discoverySelfCheck)?window.close():finishClose({acknowledged:true}).catch(()=>{}),100);return true;});
 if(audioSelfCheck)ipcMain.handle('self-check:capture',async(event,name)=>{permitted(event);if(!['full-player','mini-player','restored-player'].includes(name))throw new Error('Invalid self-check capture');const prefix='audio-'+(offlineCheck?'offline':'online');await fs.writeFile(path.join(dataDir,prefix+'-'+name+'.png'),(await window.webContents.capturePage()).toPNG());return true;});
 window=new BrowserWindow({show:!selfCheck,width:audioSelfCheckMobile?420:1200,height:audioSelfCheckMobile?900:820,minWidth:audioSelfCheckMobile?360:800,minHeight:600,title:'Gargantua Personal Library',backgroundColor:'#101014',icon:path.join(dist,'icon-512.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,webviewTag:false,backgroundThrottling:!selfCheck,autoplayPolicy:'no-user-gesture-required',additionalArguments:[`--cotology-server-identity=${SERVER}`,...(selfCheck?['--cotology-self-check',...(discoverySelfCheck?['--cotology-discovery-self-check']:[]),...(mediaSelfCheck?['--cotology-media-self-check']:[]),...(readerSelfCheck?['--cotology-reader-self-check']:[]),...(audioSelfCheck?['--cotology-audio-self-check']:[]),...(audioSelfCheckMobile?['--cotology-audio-self-check-mobile']:[]),...(offlineCheck?['--cotology-self-check-offline']:[])]:[])]}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(ORIGIN+'/'))event.preventDefault();});
 window.webContents.on('will-attach-webview',event=>event.preventDefault());
 closeCoordinator=createCloseCoordinator({
  send:detail=>{closing=true;window.webContents.send('cotology:before-close',detail);},
  onAccepted:detail=>finishClose(detail),
  onBlocked:async detail=>{
   closing=false;finalizing=false;
   const report={schemaVersion:1,at:new Date().toISOString(),attemptId:detail.attemptId,reason:detail.reason,windowKeptOpen:true,storageKeptOpen:true};
   await fs.writeFile(path.join(dataDir,detail.reason==='timeout'?'close-timeout.json':'close-blocked.json'),JSON.stringify(report)).catch(()=>{});
   if(!selfCheck)dialog.showErrorBox('Приложение осталось открытым',detail.reason==='timeout'?'Сохранение ещё не подтверждено. Дождитесь завершения записи и повторите закрытие. Книги и хранилище остаются доступны.':'Не все изменения удалось сохранить. Проверьте свободное место и блокировки файлов, затем повторите сохранение и закрытие.');
  }
 });
 window.on('close',event=>{if(allowClose)return;event.preventDefault();closeCoordinator.request();});
 window.setMenuBarVisibility(false);await window.loadURL(ORIGIN+(discoverySelfCheck?'/?discovery-self-check=1':mediaSelfCheck?'/?reader-media-self-check=1':readerSelfCheck?'/?reader-self-check=1':audioSelfCheck?'/?audio-self-check=1':selfCheck?'/__selfcheck/index.html':'/'));
 await fs.writeFile(path.join(dataDir,'startup-status.json'),JSON.stringify({version:app.getVersion(),loaded:true,storage:path.join(dataDir,'library'),localPackages:(await store.keys('')).filter(k=>k.includes(':book:')).length,at:new Date().toISOString()}));
}).catch(async error=>{await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(path.join(dataDir,'startup-error.txt'),String(error.stack));await store?.close().catch(()=>{});if(!selfCheck)dialog.showErrorBox('Не удалось открыть библиотеку','Данные сохранены. Автоматическая замена пустой библиотекой отключена. Подробности находятся в startup-error.txt в папке данных Cotology.');app.quit();});
app.on('second-instance',()=>{if(window){window.show();window.focus();}});
app.on('window-all-closed',()=>app.quit());
