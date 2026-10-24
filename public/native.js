/* Restricted Android message bridge. No effect in the Windows or web client. */
(()=>{
 if(!window.CotologyAndroid)return;
 let sequence=0;const pending=new Map();
 window.CotologyAndroid.onmessage=event=>{const r=JSON.parse(event.data),p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(new Error(r.error)):p.resolve(r.value);};
 const call=(method,args=[])=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Приложение не ответило вовремя'));},120000);pending.set(id,{resolve,reject,timer});window.CotologyAndroid.postMessage(JSON.stringify({id,method,args}));});
 const native={platform:'android',get:key=>call('get',[key]),put:(key,value)=>call('put',[key,value]),remove:key=>call('remove',[key]),keys:prefix=>call('keys',[prefix]),entries:prefix=>call('entries',[prefix]),configure:()=>call('configure')};
 for(const method of ['audioRegister','audioList','audioGet','audioDownload','audioCancel','audioRemove','audioPositionGet','audioPositionPut','audioUrl','audioPlayback','audioPlaybackStatus'])native[method]=spec=>call(method,spec===undefined?[]:[spec]);
 native.request=async(url,options)=>{
  const request={url,method:options.method||'GET',headers:options.headers||{}};
  if(options.body instanceof FormData){
   const file=options.body.get('file');if(!file||file.size>20*1024*1024)throw new Error('Файл должен быть не больше 20 МБ');
   const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
   request.file={name:file.name,data:btoa(binary)};
  }else if(options.body)request.body=options.body;
  return call('request',[request]);
 };
 Object.defineProperty(window,'cotologyNative',{value:Object.freeze(native),writable:false});
})();
