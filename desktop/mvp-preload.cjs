const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('gargantua',Object.freeze({
  version:'0.9.0',request:path=>ipcRenderer.invoke('mvp:request',path),
  onBeforeClose:callback=>{
    const listener=async(_event,detail)=>{
      try{await callback();ipcRenderer.send('mvp:ready-to-close',{attemptId:detail.attemptId,flushFailed:false,rejectedPromises:0});}
      catch{ipcRenderer.send('mvp:ready-to-close',{attemptId:detail.attemptId,flushFailed:true,rejectedPromises:1});}
    };
    ipcRenderer.on('mvp:before-close',listener);
    return ()=>ipcRenderer.removeListener('mvp:before-close',listener);
  }
}));
