import net from 'node:net';

const MAX_INPUT=24*1024*1024,MAX_REPLY=8192,CHUNK_BYTES=65536,DAY=86400000;
const failure=(message,code)=>Object.assign(new Error(message),{code});
const aborted=()=>Object.assign(failure('Проверка антивирусом отменена','ABORT_ERR'),{name:'AbortError'});
function optionsFor(options={}){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['signal','timeoutMs','idleTimeoutMs'].includes(key)))throw new TypeError('Недопустимые параметры проверки');
 const timeoutMs=options.timeoutMs??90000,idleTimeoutMs=options.idleTimeoutMs??timeoutMs,signal=options.signal;
 for(const value of [timeoutMs,idleTimeoutMs])if(!Number.isSafeInteger(value)||value<1||value>300000)throw new TypeError('Недопустимое время проверки');
 if(signal&&(typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))throw new TypeError('Нужен AbortSignal');
 return {timeoutMs,idleTimeoutMs,signal};
}
function writeBounded(socket,bytes){
 // One <=64KiB frame at a time. The write callback runs when that frame has
 // flushed, so a slow/paused peer cannot enqueue the rest of the input in JS.
 return new Promise((resolve,reject)=>{
  const closed=()=>done(failure('Сканер прервал приём данных','SCAN_TRUNCATED'));
  const failed=error=>done(error);
  let settled=false;
  function done(error){if(settled)return;settled=true;socket.removeListener('close',closed);socket.removeListener('error',failed);error?reject(error):resolve();}
  socket.once('close',closed);socket.once('error',failed);
  try{socket.write(bytes,done);}catch(error){done(error);}
 });
}
// Injection is for isolated local-socket fixtures. Production uses the fixed
// configured ClamAV service; callers cannot select another target per scan.
export function createScanner({connect=options=>net.createConnection(options),now=Date.now}={}){
 async function clamCommand(command,body,options={}){
  const settings=optionsFor(options);
  if(!['VERSION','INSTREAM'].includes(command))throw failure('Команда сканера запрещена','SCAN_COMMAND');
  if(command==='INSTREAM'&&(!Buffer.isBuffer(body)||body.length>MAX_INPUT))throw failure('Объект превышает лимит проверки','SCAN_INPUT');
  if(command==='VERSION'&&body!==undefined)throw failure('VERSION не принимает содержимое файла','SCAN_COMMAND');
  if(settings.signal?.aborted)throw aborted();
  return new Promise((resolve,reject)=>{
   let socket,finished=false,inputComplete=false,reply=Buffer.alloc(0);
   const parent=settings.signal,cancel=()=>finish(aborted());
   const finish=(error,value)=>{
    if(finished)return;finished=true;clearTimeout(timer);parent?.removeEventListener('abort',cancel);
    socket?.setTimeout(0);socket?.destroy();reply=Buffer.alloc(0);error?reject(error):resolve(value);
   };
   // This deadline starts before connection/DNS and never resets on progress.
   const timer=setTimeout(()=>finish(failure('Превышено общее время проверки антивирусом','SCAN_DEADLINE')),settings.timeoutMs);
   parent?.addEventListener('abort',cancel,{once:true});
   if(parent?.aborted){cancel();return;}
   try{
    const port=Number(process.env.CLAM_PORT||3310);if(!Number.isInteger(port)||port<1||port>65535)throw failure('Некорректный порт сканера','SCAN_CONFIG');
    socket=connect({host:process.env.CLAM_HOST||'clamav',port});socket.setNoDelay(true);
    socket.setTimeout(settings.idleTimeoutMs,()=>finish(failure('Антивирус не передаёт данные вовремя','SCAN_IDLE_TIMEOUT')));
    socket.on('error',error=>finish(failure(`Антивирус недоступен: ${error.code||'ошибка'}`,'SCAN_UNAVAILABLE')));
    socket.on('data',chunk=>{
     if(finished)return;
     if(reply.length+chunk.length>MAX_REPLY){finish(failure('Ответ сканера превышает лимит','SCAN_REPLY_LIMIT'));return;}
     // VERSION and one INSTREAM are single-record commands, using z framing.
     // Wait for EOF: a later second record must not turn a first OK into clean.
     reply=Buffer.concat([reply,chunk]);const nul=reply.indexOf(0);
     if((nul!==-1&&nul!==reply.length-1)||reply.includes(10)||reply.includes(13))finish(failure('Некорректное обрамление ответа сканера','SCAN_PROTOCOL'));
    });
    socket.once('end',()=>{
     if(finished)return;
     if(!inputComplete||!reply.length||reply.at(-1)!==0){finish(failure('Сканер вернул неполный ответ','SCAN_TRUNCATED'));return;}
     try{
      const value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(reply.subarray(0,-1));
      if(!value||/[\x00-\x1f\x7f]/.test(value))throw failure('Некорректный ответ сканера','SCAN_PROTOCOL');
      finish(null,value);
     }catch(error){finish(error.code==='SCAN_PROTOCOL'?error:failure('Некорректный UTF-8 ответа сканера','SCAN_PROTOCOL'));}
    });
    socket.once('close',()=>{if(!finished)finish(failure('Сканер закрыл соединение без полного ответа','SCAN_TRUNCATED'));});
    socket.once('connect',()=>{
     (async()=>{
      await writeBounded(socket,Buffer.from(`z${command}\0`));
      if(command==='INSTREAM'){
       for(let offset=0;offset<body.length;offset+=CHUNK_BYTES){
        if(finished)return;
        const chunk=body.subarray(offset,offset+CHUNK_BYTES),frame=Buffer.allocUnsafe(4+chunk.length);
        frame.writeUInt32BE(chunk.length);chunk.copy(frame,4);await writeBounded(socket,frame);
       }
       if(finished)return;await writeBounded(socket,Buffer.alloc(4));
      }
      inputComplete=true;
     })().catch(error=>finish(error.code?.startsWith('SCAN_')?error:failure('Сканер прервал приём данных','SCAN_UNAVAILABLE')));
    });
   }catch(error){finish(error);}
  });
 }
 async function scannerVersion(options={}){
  const version=await clamCommand('VERSION',undefined,options);
  const match=/^ClamAV [0-9][0-9A-Za-z.+~_-]{0,79}\/([1-9][0-9]{0,11})\/([^\x00-\x1f\x7f]{1,128})$/.exec(version);
  const date=match?Date.parse(match[2]):NaN,age=now()-date;
  if(!Number.isFinite(date)||!Number.isFinite(age)||age< -DAY||age>7*DAY)throw failure('Антивирусные базы отсутствуют или старше 7 дней','SCAN_STALE');
  return version;
 }
 async function scan(buffer,options={}){
  const answer=await clamCommand('INSTREAM',buffer,options);
  if(answer!=='stream: OK'){
   const threat=/^stream: .+ FOUND$/u.test(answer),error=failure(`Проверка не пройдена: ${answer.slice(0,300)}`,threat?'SCAN_THREAT':'SCAN_REJECTED');error.threat=threat;throw error;
  }
 }
 return {clamCommand,scannerVersion,scan};
}
const scanner=createScanner();
export const {clamCommand,scannerVersion,scan}=scanner;
