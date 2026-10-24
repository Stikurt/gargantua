import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import {X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';
import {validateHeaderName,validateHeaderValue} from 'node:http';
import ipaddr from 'ipaddr.js';

const MiB=1024*1024,MAX_BYTES=20*MiB,MAX_REDIRECTS=3;
const failure=(message,code)=>Object.assign(new Error(message),{code});
const aborted=()=>Object.assign(failure('Загрузка отменена','ABORT_ERR'),{name:'AbortError'});
const hostname=url=>url.hostname.replace(/^\[|\]$/g,'');
export function publicAddress(address){
 try{let ip=ipaddr.parse(address);if(ip.kind()==='ipv6'&&ip.isIPv4MappedAddress())ip=ip.toIPv4Address();return ip.range()==='unicast';}catch{return false;}
}
export function checkUrl(value){
 const url=new URL(value);
 if(url.href.length>8192||url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||url.hash)throw failure('Нужна HTTPS-ссылка без пароля, фрагмента и нестандартного порта','FETCH_URL');
 if(url.hostname.length>253||url.hostname==='localhost')throw failure('Локальные адреса запрещены','FETCH_SSRF');
 return url;
}
function integer(value,fallback,min,max,name){
 value=value??fallback;if(!Number.isSafeInteger(value)||value<min||value>max)throw new TypeError(`Недопустимый параметр ${name}`);return value;
}
function requestOptions(maxOrOptions,redirects,legacyHeaders){
 const options=typeof maxOrOptions==='number'?{maxBytes:maxOrOptions,redirects,headers:legacyHeaders}:maxOrOptions;
 if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('Нужны параметры загрузки');
 const keys=new Set(['maxBytes','headers','signal','parentAbortSignal','timeoutMs','idleTimeoutMs','maxRedirects','redirects']);
 if(Object.keys(options).some(key=>!keys.has(key)))throw new TypeError('Неизвестный параметр загрузки');
 const maxBytes=integer(options.maxBytes,MAX_BYTES,1,MAX_BYTES,'maxBytes');
 const maxRedirects=integer(options.maxRedirects,MAX_REDIRECTS,0,MAX_REDIRECTS,'maxRedirects');
 const usedRedirects=integer(options.redirects,0,0,maxRedirects,'redirects');
 const timeoutMs=integer(options.timeoutMs,45000,1,120000,'timeoutMs');
 const idleTimeoutMs=integer(options.idleTimeoutMs,20000,1,120000,'idleTimeoutMs');
 if(options.signal&&options.parentAbortSignal&&options.signal!==options.parentAbortSignal)throw new TypeError('Передайте только один сигнал отмены');
 const signal=options.signal??options.parentAbortSignal;
 if(signal&&(typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))throw new TypeError('Нужен AbortSignal');
 const explicit=options.headers??{};
 if(!explicit||typeof explicit!=='object'||Array.isArray(explicit)||Object.keys(explicit).length>64)throw new TypeError('Недопустимые заголовки');
 const headers={'user-agent':'Cotology-Personal-Library/0.1',accept:'application/octet-stream, application/json;q=0.8'};
 const forbidden=new Set(['host','connection','content-length','transfer-encoding','upgrade','proxy-authorization','proxy-connection','expect','te','trailer']);
 let bytes=0;
 for(const [name,value] of Object.entries(explicit)){
  validateHeaderName(name);if(typeof value!=='string')throw new TypeError('Значение заголовка должно быть строкой');validateHeaderValue(name,value);
  const key=name.toLowerCase();if(forbidden.has(key))throw new TypeError('Служебный заголовок запрещён');
  bytes+=Buffer.byteLength(name)+Buffer.byteLength(value);if(bytes>16384)throw new TypeError('Слишком много заголовков');headers[key]=value;
 }
 return {maxBytes,maxRedirects,usedRedirects,timeoutMs,idleTimeoutMs,signal,headers,explicitHeaders:Object.keys(explicit).length>0};
}
// A resolver belongs to one hop, so cancel never affects another acquisition.
// Unlike OS getaddrinfo/dns.lookup, c-ares queries can actually be cancelled.
async function resolveAddresses(host,{signal},createResolver){
 const family=isIP(host);if(family)return [{address:host,family}];
 const resolver=createResolver(),cancel=()=>resolver.cancel();
 signal.throwIfAborted();signal.addEventListener('abort',cancel,{once:true});
 try{
  const answers=await Promise.allSettled([resolver.resolve4(host),resolver.resolve6(host)]);
  signal.throwIfAborted();const addresses=[];
  for(let i=0;i<answers.length;i++){
   const answer=answers[i];
   if(answer.status==='fulfilled')addresses.push(...answer.value.map(address=>({address,family:i===0?4:6})));
   else if(!['ENODATA','ENOTFOUND'].includes(answer.reason?.code))throw failure('Не удалось разрешить DNS-имя источника','FETCH_DNS');
  }
  return addresses;
 }finally{signal.removeEventListener('abort',cancel);}
}
function abortable(operation,signal){
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
  const cancel=()=>finish(signal.reason);
  if(signal.aborted){cancel();return;}
  signal.addEventListener('abort',cancel,{once:true});
  // Both handlers remain attached if an injected or OS resolver finishes late.
  Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}).then(value=>finish(null,value),error=>finish(error));
 });
}
function verifyIdentity(host,certificate){
 if(!isIP(host))return tls.checkServerIdentity(host,certificate);
 // Check an IP SAN directly. Some Node 24 releases pass bare IPv6 through
 // domainToASCII in checkServerIdentity, which rejects an otherwise valid SAN.
 // CA/chain/expiry validation remains enabled in the HTTPS/TLS transport.
 try{if(new X509Certificate(certificate.raw).checkIP(host))return;}catch{}
 return failure('Сертификат не соответствует IP-адресу источника','ERR_TLS_CERT_ALTNAME_INVALID');
}
function fetchHop(request,url,selected,options,signal){
 return new Promise((resolve,reject)=>{
  let req,res,settled=false,ended=false,size=0,chunks=[];
  const finish=(error,value,destroy=false)=>{
   if(settled)return;settled=true;signal.removeEventListener('abort',cancel);req?.setTimeout(0);
   if(destroy){res?.destroy();req?.destroy();}chunks=[];error?reject(error):resolve(value);
  };
  const cancel=()=>finish(signal.reason,undefined,true);
  if(signal.aborted){cancel();return;}signal.addEventListener('abort',cancel,{once:true});
  const host=hostname(url);
  const lookup=(requested,lookupOptions,callback)=>{
   if(requested!==host){callback(failure('Изменился адрес соединения','FETCH_SSRF'));return;}
   queueMicrotask(()=>lookupOptions?.all?callback(null,[{...selected}]):callback(null,selected.address,selected.family));
  };
  try{
   req=request(url,{method:'GET',headers:options.headers,agent:false,lookup,family:selected.family,autoSelectFamily:false,rejectUnauthorized:true,servername:isIP(host)?'':host,checkServerIdentity:(_name,certificate)=>verifyIdentity(host,certificate),maxHeaderSize:16384},response=>{
    res=response;if(settled){res.destroy();return;}
    const broken=()=>finish(failure('Источник прервал передачу файла','FETCH_TRUNCATED'),undefined,true);
    res.on('error',error=>finish(error,undefined,true));res.once('aborted',broken);
    res.once('close',()=>{if(!ended&&!settled)broken();});
    if([301,302,303,307,308].includes(res.statusCode)){
     try{
      if(options.usedRedirects>=options.maxRedirects||!res.headers.location)throw failure('Слишком много перенаправлений','FETCH_REDIRECT_LIMIT');
      const next=checkUrl(new URL(res.headers.location,url));
      if(options.explicitHeaders&&next.origin!==url.origin)throw failure('Смена домена API запрещена','FETCH_REDIRECT_ORIGIN');
      // Do not drain an unbounded redirect body. Close it before the next DNS.
      finish(null,{redirect:next},true);
     }catch(error){finish(error,undefined,true);}return;
    }
    if(res.statusCode!==200){finish(Object.assign(failure(`Источник ответил HTTP ${res.statusCode}`,'FETCH_HTTP'),{httpStatus:res.statusCode}),undefined,true);return;}
    const rawLength=res.headers['content-length'];let length=null;
    if(rawLength!==undefined){
     if(typeof rawLength!=='string'||!/^\d+$/.test(rawLength)||!Number.isSafeInteger(Number(rawLength))){finish(failure('Недопустимая длина ответа','FETCH_RESPONSE'),undefined,true);return;}
     length=Number(rawLength);if(length>options.maxBytes){finish(failure('Файл превышает допустимый размер','FETCH_TOO_LARGE'),undefined,true);return;}
    }
    res.on('data',chunk=>{
     if(settled)return;size+=chunk.length;
     if(size>options.maxBytes){finish(failure('Превышен лимит загрузки','FETCH_TOO_LARGE'),undefined,true);return;}chunks.push(chunk);
    });
    res.once('end',()=>{
     ended=true;if(!res.complete||(length!==null&&length!==size)){broken();return;}
     finish(null,{buffer:Buffer.concat(chunks,size),type:String(res.headers['content-type']||''),url:url.href});
    });
   });
   req.on('error',error=>finish(error,undefined,true));req.maxHeadersCount=100;
   req.setTimeout(options.idleTimeoutMs,()=>finish(failure('Источник не передаёт данные вовремя','FETCH_IDLE_TIMEOUT'),undefined,true));req.end();
  }catch(error){finish(error,undefined,true);}
 });
}
// Dependencies are injectable for local TLS/fault fixtures. There is no URL or
// address-policy override: exported fetchSafe always uses these public rules.
export function createSafeFetcher({resolve,request=https.request,createResolver=()=>new dns.Resolver()}={}){
 const resolveHop=resolve??((host,options)=>resolveAddresses(host,options,createResolver));
 return async function safeFetch(value,maxOrOptions=MAX_BYTES,redirects=0,headers={}){
  const options=requestOptions(maxOrOptions,redirects,headers),controller=new AbortController();
  const parent=options.signal,cancel=()=>controller.abort(aborted());
  if(parent?.aborted)throw aborted();parent?.addEventListener('abort',cancel,{once:true});
  // One timer includes DNS, TLS, every redirect and the complete bounded body.
  const timer=setTimeout(()=>controller.abort(failure('Превышено время загрузки','FETCH_DEADLINE')),options.timeoutMs);
  try{
   let url=checkUrl(value);
   for(;;){
    controller.signal.throwIfAborted();
    const addresses=await abortable(()=>resolveHop(hostname(url),{signal:controller.signal}),controller.signal);
    if(!Array.isArray(addresses)||!addresses.length||addresses.length>64||addresses.some(item=>!item||isIP(item.address)!==item.family||!publicAddress(item.address)))throw failure('Источник указывает на непубличный адрес','FETCH_SSRF');
    const result=await fetchHop(request,url,addresses[0],options,controller.signal);
    if(!result.redirect)return result;
    url=result.redirect;options.usedRedirects++;
   }
  }finally{clearTimeout(timer);parent?.removeEventListener('abort',cancel);}
 };
}
export const fetchSafe=createSafeFetcher();
