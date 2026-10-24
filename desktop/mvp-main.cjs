const {app,BrowserWindow,protocol,ipcMain,session,shell,dialog}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createCloseCoordinator}=require('./close-coordinator.cjs');
const ORIGIN='gargantua://app',SERVER='http://127.0.0.1:3080';
const testProfile=process.argv.find(v=>v.startsWith('--test-profile='))?.slice(15);
if(testProfile&&!path.isAbsolute(testProfile))throw new Error('Test profile must be absolute');
app.setName('Гаргантюа');
app.setPath('userData',testProfile||path.join(app.getPath('appData'),'Gargantua-MVP'));
app.setAppUserModelId('local.gargantua.mvp');
const offline=Boolean(testProfile)&&process.argv.includes('--offline');
protocol.registerSchemesAsPrivileged([{scheme:'gargantua',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const primary=app.requestSingleInstanceLock();if(!primary)app.quit();
let window,allowClose=false,closeCoordinator;
const csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const externalHosts=new Set(['ranobelib.me','www.gutenberg.org','gutenberg.org','ru.wikisource.org','litlife.club','libcat.ru','ranobe.me','ranobehub.org']);
function openExternal(url){try{const target=new URL(url);if(target.protocol==='https:'&&externalHosts.has(target.hostname))shell.openExternal(target.href);}catch{}}
app.whenReady().then(async()=>{
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  const dist=path.join(__dirname,'dist');
  protocol.handle('gargantua',async request=>{
    const url=new URL(request.url);
    if(url.host!=='app'||request.method!=='GET')return new Response('Not found',{status:404});
    let relative;try{relative=decodeURIComponent(url.pathname);}catch{return new Response('Bad path',{status:400});}
    if(relative==='/')relative='/index.html';
    const file=path.resolve(dist,'.'+relative);
    const types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
    if(!file.startsWith(dist+path.sep)||!types[path.extname(file)])return new Response('Not found',{status:404});
    try{return new Response(await fs.readFile(file),{headers:{'Content-Type':types[path.extname(file)],'Content-Security-Policy':csp}});}catch{return new Response('Not found',{status:404});}
  });
  ipcMain.handle('mvp:request',async(event,requestPath)=>{
    if(!window||event.sender.id!==window.webContents.id||event.senderFrame?.parent!==null||!event.senderFrame.url.startsWith(ORIGIN+'/'))throw new Error('Недоверенный запрос');
    if(typeof requestPath!=='string'||requestPath.length>8192||!/^\/api\/mvp\/(health|sources|search|random|book|chapter|related|merge)(\?|$)/.test(requestPath))throw new Error('Недопустимый запрос');
    const url=new URL(requestPath,SERVER);
    if(url.origin!==SERVER)throw new Error('Недопустимый сервер');
    // Isolated acceptance profiles can audit real client transport without
    // replacing requests or reading the normal user's library.
    if(testProfile)process.stdout.write(JSON.stringify({event:'mvp-request',path:requestPath,offline,at:Date.now()})+'\n');
    if(offline)return {error:'Сервер недоступен. Сохранённые главы можно читать без интернета.',status:0,code:'SERVER_OFFLINE'};
    let response;
    try{response=await fetch(url,{signal:AbortSignal.timeout(url.pathname.endsWith('/health')?3000:url.pathname.endsWith('/related')?90000:65000),redirect:'error'});}catch(error){return {error:error.name==='TimeoutError'?'Источник не ответил вовремя. Повторите запрос.':'Сервер недоступен. Запустите сервер Гаргантюа и повторите.',status:0,code:error.name==='TimeoutError'?'SOURCE_TIMEOUT':'SERVER_OFFLINE'};}
    const chunks=[];let size=0;
    try{const reader=response.body.getReader();while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>24*1024*1024){await reader.cancel();return {error:'Ответ источника слишком большой',status:502,code:'SOURCE_LIMIT'};}chunks.push(Buffer.from(part.value));}}
    catch{return {error:'Соединение с сервером прервано. Загрузка продолжится после паузы.',status:0,code:'SERVER_OFFLINE'};}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return {error:'Сервер вернул некорректный ответ',status:response.status||502,code:'SOURCE_FORMAT'};}
    // Electron serializes thrown Error objects without their status and code.
    // Return failures as data so the renderer can respect source cooldowns.
    if(!response.ok)return {error:result.error||`Ошибка сервера (${response.status})`,status:response.status,code:result.code||'SOURCE_ERROR',...(Number.isFinite(result.retryAfterMs)?{retryAfterMs:result.retryAfterMs}:{})};
    return result;
  });
  window=new BrowserWindow({width:1320,height:900,minWidth:800,minHeight:600,title:'Гаргантюа',backgroundColor:'#11151b',webPreferences:{preload:path.join(__dirname,'mvp-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  closeCoordinator=createCloseCoordinator({
    send:detail=>window.webContents.send('mvp:before-close',detail),
    onAccepted:()=>{allowClose=true;window.close();},
    onBlocked:()=>dialog.showErrorBox('Сохранение не завершено','Приложение осталось открытым, чтобы не потерять позицию чтения. Повторите закрытие после завершения сохранения.')
  });
  ipcMain.on('mvp:ready-to-close',(event,detail)=>{
    if(event.sender.id===window.webContents.id&&event.senderFrame?.parent===null&&event.senderFrame.url.startsWith(ORIGIN+'/'))closeCoordinator.acknowledge(detail);
  });
  window.on('close',event=>{if(!allowClose){event.preventDefault();closeCoordinator.request();}});
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(({url})=>{openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(ORIGIN+'/')){event.preventDefault();openExternal(url);}});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  app.on('second-instance',()=>{if(window.isMinimized())window.restore();window.focus();});
  await window.loadURL(ORIGIN+'/');
});
app.on('window-all-closed',()=>app.quit());
