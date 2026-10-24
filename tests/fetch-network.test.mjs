import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import dns from 'node:dns/promises';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import {once,getEventListeners} from 'node:events';
import {isIP} from 'node:net';
import {performance} from 'node:perf_hooks';
import {createSafeFetcher,fetchSafe} from '../server/fetch.mjs';

const cert=await fs.readFile(new URL('./fixtures/fetch-tls/test-cert.pem',import.meta.url));
const key=await fs.readFile(new URL('./fixtures/fetch-tls/test-key.pem',import.meta.url));
const publicIPv4={address:'1.1.1.1',family:4},publicIPv6={address:'2606:4700:4700::1111',family:6};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
let server,port;const sockets=new Set(),seen=[];
before(async()=>{
 server=https.createServer({key,cert},(req,res)=>{
  seen.push({url:req.url,headers:req.headers});
  const url=new URL(req.url,'https://one.fixture.test');
  if(url.pathname==='/ok'){res.setHeader('Content-Type','application/octet-stream');res.end('synthetic book');return;}
  if(url.pathname==='/chunked'){res.write('1234');setTimeout(()=>res.end('56789'),10);return;}
  if(url.pathname==='/declared-big'){res.writeHead(200,{'Content-Length':'999999'});res.flushHeaders();return;}
  if(url.pathname==='/truncated'){res.writeHead(200,{'Content-Length':'99'});res.write('short');setTimeout(()=>res.destroy(),15);return;}
  if(url.pathname==='/close'){res.writeHead(200);res.write('partial');setTimeout(()=>res.socket?.destroy(),15);return;}
  if(url.pathname==='/headers-stall')return;
  if(url.pathname==='/body-stall'){res.writeHead(200);res.write('partial');return;}
  if(url.pathname==='/trickle'){res.writeHead(200);const timer=setInterval(()=>res.write('x'),15);res.once('close',()=>clearInterval(timer));return;}
  if(url.pathname==='/error'){res.writeHead(503);res.write('never-ending error body');return;}
  if(url.pathname==='/redirect'){
   res.writeHead(302,{Location:url.searchParams.get('to')||'/ok'});res.write('never-ending redirect body');return;
  }
  if(url.pathname==='/chain'){
   const count=Number(url.searchParams.get('n')||0),delay=Number(url.searchParams.get('delay')||0);
   setTimeout(()=>{if(res.destroyed)return;res.writeHead(302,{Location:count?`/chain?n=${count-1}&delay=${delay}`:'/ok'});res.end();},delay);return;
  }
  res.writeHead(404);res.end();
 });
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 server.on('tlsClientError',()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');port=server.address().port;
});
after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});

// Production checks always see public fixture answers. Only this injected
// transport routes a separately verified, pinned target to the local TLS port.
// It does not change process DNS, CA stores, or production address policy.
function fixture({resolve=async()=>[publicIPv4],createResolver}={}){
 const pins=[],requests=[];
 const request=(url,options,callback)=>{
  assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,true);assert.equal(options.autoSelectFamily,false);
  const host=url.hostname.replace(/^\[|\]$/g,''),local=new URL(url);local.hostname='one.fixture.test';local.port=String(port);
  requests.push(url.href);
  return https.request(local,{...options,family:4,ca:cert,servername:isIP(host)?'':host,
   checkServerIdentity:(_name,certificate)=>options.checkServerIdentity(host,certificate),
   lookup:(_hostname,_lookupOptions,cb)=>options.lookup(host,{all:false},(error,address,family)=>{
    if(error){cb(error);return;}pins.push({host,address,family});cb(null,'127.0.0.1',4);
   })
  },callback);
 };
 return {fetch:createSafeFetcher({...(createResolver?{createResolver}:{resolve}),request}),pins,requests};
}
async function noOpenSockets(){
 for(let n=0;n<50&&sockets.size;n++)await sleep(10);
 assert.equal(sockets.size,0,'Completed/failed acquisition must close its fixture sockets');
}
async function stalledDns(){
 const udp=dgram.createSocket('udp4'),received=gate();udp.on('message',()=>received.resolve());udp.bind(0,'127.0.0.1');await once(udp,'listening');
 let cancelled=0;
 const createResolver=()=>{const resolver=new dns.Resolver();resolver.setServers([`127.0.0.1:${udp.address().port}`]);const cancel=resolver.cancel.bind(resolver);resolver.cancel=()=>{cancelled++;cancel();};return resolver;};
 return {udp,received,createResolver,cancelled:()=>cancelled,close:()=>new Promise(resolve=>udp.close(resolve))};
}

test('local TLS fixture returns bounded bytes with the legacy argument adapter and pinned public DNS',async()=>{
 const f=fixture(),r=await f.fetch('https://one.fixture.test/ok',64,0,{'Site-Id':'3'});
 assert.equal(r.buffer.toString(),'synthetic book');assert.equal(r.url,'https://one.fixture.test/ok');assert.equal(r.type,'application/octet-stream');
 assert.deepEqual(f.pins,[{host:'one.fixture.test',...publicIPv4}]);assert.equal(seen.at(-1).headers['site-id'],'3');await noOpenSockets();
});
test('IPv6 bracket normalization pins family 6 and verifies the IP certificate identity',async()=>{
 let resolved;const f=fixture({resolve:async host=>{resolved=host;return [publicIPv6];}});
 await f.fetch('https://[2606:4700:4700::1111]/ok',{timeoutMs:1000});assert.equal(resolved,'2606:4700:4700::1111');assert.equal(f.pins[0].family,6);await noOpenSockets();
});
test('TLS identity verification rejects wrong DNS and IP SANs despite a trusted fixture CA',async()=>{
 for(const host of ['wrong.fixture.test','1.0.0.1','[2606:4700:4700::1001]']){
  const f=fixture({resolve:async()=>[publicIPv4]});
  await assert.rejects(()=>f.fetch(`https://${host}/ok`,{timeoutMs:1000}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
 }await noOpenSockets();
});
test('public IPv4 with no AAAA records succeeds, while an incomplete DNS family error fails closed',async()=>{
 const f=fixture({createResolver:()=>({resolve4:async()=>['1.1.1.1'],resolve6:async()=>{throw Object.assign(new Error(),{code:'ENODATA'});},cancel(){}})});
 await f.fetch('https://one.fixture.test/ok',{timeoutMs:1000});
 const broken=fixture({createResolver:()=>({resolve4:async()=>['1.1.1.1'],resolve6:async()=>{throw Object.assign(new Error(),{code:'ESERVFAIL'});},cancel(){}})});
 await assert.rejects(()=>broken.fetch('https://one.fixture.test/ok'),{code:'FETCH_DNS'});assert.equal(broken.requests.length,0);await noOpenSockets();
});
test('empty, mixed public/private and malformed DNS answers are rejected before TLS',async()=>{
 for(const answers of [[],[publicIPv4,{address:'10.0.0.1',family:4}],[publicIPv4,{address:'::ffff:127.0.0.1',family:6}],[{address:'1.1.1.1',family:6}]]){
  const f=fixture({resolve:async()=>answers});await assert.rejects(()=>f.fetch('https://one.fixture.test/ok'),{code:'FETCH_SSRF'});assert.equal(f.requests.length,0);
 }
});
test('production entry rejects literal numeric, mapped and IPv6 private targets',async()=>{
 for(const url of ['https://127.1/x','https://0x7f000001/x','https://2130706433/x','https://[::ffff:127.0.0.1]/x','https://[::1]/x'])await assert.rejects(()=>fetchSafe(url,{timeoutMs:1000}),{code:'FETCH_SSRF'});
});
test('pre-aborted parent does not resolve DNS or open a connection',async()=>{
 let resolves=0;const controller=new AbortController();controller.abort();const f=fixture({resolve:async()=>{resolves++;return [publicIPv4];}});
 await assert.rejects(()=>f.fetch('https://one.fixture.test/ok',{signal:controller.signal}),{code:'ABORT_ERR'});assert.equal(resolves,0);assert.equal(f.requests.length,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('a real nonresponsive DNS socket consumes the same deadline and is cancelled',async()=>{
 const dnsFixture=await stalledDns();try{
  const f=fixture({createResolver:dnsFixture.createResolver}),started=performance.now();
  await assert.rejects(()=>f.fetch('https://one.fixture.test/ok',{timeoutMs:100}),{code:'FETCH_DEADLINE'});
  assert.ok(performance.now()-started<1500);assert.equal(dnsFixture.cancelled(),1);assert.equal(f.requests.length,0);
 }finally{await dnsFixture.close();}
});
test('parent abort cancels real stalled DNS and removes its listener',async()=>{
 const dnsFixture=await stalledDns(),controller=new AbortController();try{
  const f=fixture({createResolver:dnsFixture.createResolver}),pending=f.fetch('https://one.fixture.test/ok',{parentAbortSignal:controller.signal,timeoutMs:2000});
  await dnsFixture.received.promise;controller.abort('reason is intentionally not exposed');await assert.rejects(pending,{code:'ABORT_ERR'});
  assert.equal(dnsFixture.cancelled(),1);assert.equal(f.requests.length,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);
 }finally{await dnsFixture.close();}
});
test('late noncooperative DNS completion after cancellation never starts HTTPS',async()=>{
 const lookup=gate(),started=gate(),controller=new AbortController();const f=fixture({resolve:async()=>{started.resolve();return lookup.promise;}});
 const pending=f.fetch('https://one.fixture.test/ok',{signal:controller.signal,timeoutMs:2000});await started.promise;controller.abort();await assert.rejects(pending,{code:'ABORT_ERR'});
 lookup.resolve([publicIPv4]);await sleep(20);assert.equal(f.requests.length,0);
});
test('relative redirects succeed and redirect/error bodies are destroyed instead of drained',async()=>{
 const f=fixture();const r=await f.fetch('https://one.fixture.test/redirect',{timeoutMs:1000});assert.equal(r.buffer.toString(),'synthetic book');assert.equal(f.requests.length,2);await noOpenSockets();
  await assert.rejects(()=>f.fetch('https://one.fixture.test/error',{timeoutMs:1000}),e=>e.code==='FETCH_HTTP'&&e.httpStatus===503);await noOpenSockets();
});
test('redirect budget is shared, including the legacy already-used count',async()=>{
 const f=fixture();await assert.rejects(()=>f.fetch('https://one.fixture.test/chain?n=4',{timeoutMs:1500,maxRedirects:2}),{code:'FETCH_REDIRECT_LIMIT'});assert.equal(f.requests.length,3);
 const legacy=fixture();await assert.rejects(()=>legacy.fetch('https://one.fixture.test/redirect',64,3),{code:'FETCH_REDIRECT_LIMIT'});assert.equal(legacy.requests.length,1);await noOpenSockets();
});
test('redirects and active trickle bytes cannot restart the acquisition deadline',async()=>{
 const f=fixture(),started=performance.now();await assert.rejects(()=>f.fetch('https://one.fixture.test/chain?n=2&delay=70',{timeoutMs:120,idleTimeoutMs:1000}),{code:'FETCH_DEADLINE'});
 assert.ok(performance.now()-started<1000);assert.ok(f.requests.length<=2);await noOpenSockets();
 const trickle=fixture();await assert.rejects(()=>trickle.fetch('https://one.fixture.test/trickle',{maxBytes:1024,timeoutMs:120,idleTimeoutMs:80}),{code:'FETCH_DEADLINE'});await noOpenSockets();
});
test('private redirect answers and URL-policy changes are rejected before a second connection',async()=>{
 const f=fixture({resolve:async host=>host==='two.fixture.test'?[{address:'192.168.1.5',family:4}]:[publicIPv4]});
 await assert.rejects(()=>f.fetch('https://one.fixture.test/redirect?to='+encodeURIComponent('https://two.fixture.test/ok')),{code:'FETCH_SSRF'});assert.equal(f.requests.length,1);
 for(const target of ['http://two.fixture.test/ok','https://user:pass@two.fixture.test/ok','https://two.fixture.test:444/ok','https://two.fixture.test/ok#x']){
  const isolated=fixture();await assert.rejects(()=>isolated.fetch('https://one.fixture.test/redirect?to='+encodeURIComponent(target)),{code:'FETCH_URL'});assert.equal(isolated.requests.length,1);
 }await noOpenSockets();
});
test('cross-origin explicit headers are never forwarded; no-header cross-origin redirect remains supported',async()=>{
 const target='https://two.fixture.test/ok',url='https://one.fixture.test/redirect?to='+encodeURIComponent(target),f=fixture();
 await assert.rejects(()=>f.fetch(url,{headers:{Authorization:'synthetic-fixture-token'},timeoutMs:1000}),{code:'FETCH_REDIRECT_ORIGIN'});assert.equal(f.requests.length,1);
 const normal=fixture();assert.equal((await normal.fetch(url,{timeoutMs:1000})).url,target);assert.equal(normal.requests.length,2);assert.equal(seen.at(-1).headers.authorization,undefined);await noOpenSockets();
});
test('declared oversize and chunked limit+1 are rejected and close their sockets',async()=>{
 for(const pathname of ['/declared-big','/chunked']){const f=fixture();await assert.rejects(()=>f.fetch('https://one.fixture.test'+pathname,{maxBytes:8,timeoutMs:1000}),{code:'FETCH_TOO_LARGE'});await noOpenSockets();}
 const exact=fixture();assert.equal((await exact.fetch('https://one.fixture.test/chunked',{maxBytes:9,timeoutMs:1000})).buffer.length,9);await noOpenSockets();
});
test('truncated content-length and premature close cannot resolve as a partial book',async()=>{
 for(const pathname of ['/truncated','/close']){const f=fixture();await assert.rejects(()=>f.fetch('https://one.fixture.test'+pathname,{timeoutMs:1000}),{code:'FETCH_TRUNCATED'});await noOpenSockets();}
});
test('idle body/header stalls are destroyed before their larger overall deadline',async()=>{
 for(const pathname of ['/headers-stall','/body-stall']){const f=fixture();await assert.rejects(()=>f.fetch('https://one.fixture.test'+pathname,{timeoutMs:1000,idleTimeoutMs:60}),{code:'FETCH_IDLE_TIMEOUT'});await noOpenSockets();}
});
test('parent abort after headers closes the live response and restores listener count',async()=>{
 const controller=new AbortController(),f=fixture(),start=seen.length,pending=f.fetch('https://one.fixture.test/body-stall',{signal:controller.signal,timeoutMs:2000});
 for(let n=0;n<100&&seen.length===start;n++)await sleep(5);assert.ok(seen.length>start);controller.abort();await assert.rejects(pending,{code:'ABORT_ERR'});
 assert.equal(getEventListeners(controller.signal,'abort').length,0);await noOpenSockets();
 const completed=new AbortController();await f.fetch('https://one.fixture.test/ok',{signal:completed.signal,timeoutMs:1000});assert.equal(getEventListeners(completed.signal,'abort').length,0);await noOpenSockets();
});
test('header overrides, unlimited budgets and conflicting signals fail before network activity',async()=>{
 const f=fixture();for(const options of [{maxBytes:21*1024*1024},{timeoutMs:Infinity},{maxRedirects:4},{headers:{Host:'localhost'}},{headers:{Authorization:'x\r\ny'}},{signal:new AbortController().signal,parentAbortSignal:new AbortController().signal}])await assert.rejects(()=>f.fetch('https://one.fixture.test/ok',options));
 assert.equal(f.requests.length,0);
});
