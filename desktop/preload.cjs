const {contextBridge,ipcRenderer}=require('electron');
let closeWaiters=null;
contextBridge.exposeInMainWorld('cotologyNative',{
 platform:'windows',
 serverIdentity:process.argv.find(value=>value.startsWith('--cotology-server-identity='))?.slice('--cotology-server-identity='.length)||'http://127.0.0.1:3080',
 request:(path,options)=>ipcRenderer.invoke('api:request',path,options),
 get:key=>ipcRenderer.invoke('store:get',key),
 put:(key,value)=>ipcRenderer.invoke('store:put',key,value),
 remove:key=>ipcRenderer.invoke('store:remove',key),
 keys:prefix=>ipcRenderer.invoke('store:keys',prefix),
 entries:prefix=>ipcRenderer.invoke('store:entries',prefix),
 apply:operations=>ipcRenderer.invoke('store:apply',operations),
 flush:()=>ipcRenderer.invoke('store:flush'),
 backupLibrary:()=>ipcRenderer.invoke('store:backupLibrary'),
 waitUntilClose:promise=>{if(!closeWaiters)throw new Error('Сохранение при закрытии сейчас не запрошено');if(closeWaiters.length>=1000)throw new Error('Слишком много задач закрытия');closeWaiters.push(Promise.resolve(promise));},
 ...Object.fromEntries(['audioCapabilities','audioRegister','audioList','audioGet','audioDownload','audioCancel','audioRemove','audioPositionGet','audioPositionPut','audioUrl'].map(name=>[name,value=>ipcRenderer.invoke('audio:'+name,value)])),
 ...(process.argv.includes('--cotology-self-check')?{selfCheckDiscovery:process.argv.includes('--cotology-discovery-self-check'),selfCheckMedia:process.argv.includes('--cotology-media-self-check'),selfCheckReader:process.argv.includes('--cotology-reader-self-check'),selfCheckAudio:process.argv.includes('--cotology-audio-self-check'),selfCheckMobile:process.argv.includes('--cotology-audio-self-check-mobile'),selfCheckOffline:process.argv.includes('--cotology-self-check-offline'),selfCheckReport:result=>ipcRenderer.invoke('self-check:report',result),...(process.argv.includes('--cotology-audio-self-check')?{selfCheckCapture:name=>ipcRenderer.invoke('self-check:capture',name)}:{})}:{})
});
ipcRenderer.on('cotology:before-close',async(_event,detail)=>{
 if(closeWaiters||!detail||typeof detail.attemptId!=='string'||!/^[a-f0-9-]{36}$/.test(detail.attemptId))return;
 const attemptId=detail.attemptId;closeWaiters=[];
 try{
  contextBridge.executeInMainWorld({func:()=>{
   let accepting=true;
   const detail={waitUntil:promise=>{if(!accepting)throw new Error('waitUntil нужно вызывать во время события закрытия');window.cotologyNative.waitUntilClose(promise);}};
   window.dispatchEvent(new CustomEvent('cotology-before-close',{detail}));accepting=false;
  }});
  const pending=closeWaiters;closeWaiters=null;const results=await Promise.allSettled(pending);
  await ipcRenderer.invoke('store:flush');
  ipcRenderer.send('cotology:ready-to-close',{attemptId,rejectedPromises:results.filter(result=>result.status==='rejected').length,flushFailed:false});
 }catch{closeWaiters=null;ipcRenderer.send('cotology:ready-to-close',{attemptId,flushFailed:true});}
});
