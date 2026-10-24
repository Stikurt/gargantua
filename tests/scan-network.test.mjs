import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once,getEventListeners} from 'node:events';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createScanner} from '../server/scan.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(handler,run,{now=Date.now,inspectClient}={}){
 const sockets=new Set(),server=net.createServer({allowHalfOpen:true},socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.once('end',()=>socket.end());socket.once('close',()=>sockets.delete(socket));handler(socket);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
 const scanner=createScanner({now,connect:()=>{const socket=net.createConnection({host:'127.0.0.1',port});inspectClient?.(socket);return socket;}});
 try{await run(scanner,sockets);}finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}
function protocol(socket,complete){
 let pending=Buffer.alloc(0),command=null,total=0;const chunks=[],digest=createHash('sha256');
 socket.on('data',bytes=>{
  pending=Buffer.concat([pending,bytes]);
  if(command===null){const end=pending.indexOf(0);if(end===-1)return;command=pending.subarray(0,end).toString();pending=pending.subarray(end+1);
   if(command==='zVERSION'){complete({command,total,chunks,digest:digest.digest('hex')});return;}
   assert.equal(command,'zINSTREAM');
  }
  while(pending.length>=4){const size=pending.readUInt32BE(0);assert.ok(size<=65536,'client frame is bounded');if(pending.length<size+4)return;
   pending=pending.subarray(4);if(!size){assert.equal(pending.length,0);complete({command,total,chunks,digest:digest.digest('hex')});return;}
   const chunk=pending.subarray(0,size);total+=size;chunks.push(size);digest.update(chunk);pending=pending.subarray(size);
  }
 });
}
async function socketsClosed(sockets){for(let n=0;n<100&&sockets.size;n++)await sleep(5);assert.equal(sockets.size,0,'scan must close the fixture socket');}

test('INSTREAM has exact network-order chunks, zero terminator and original bytes',async()=>{
 const bytes=Buffer.alloc(65536*2+17,0x61);let submitted;
 await fixture(socket=>protocol(socket,value=>{submitted=value;socket.end('stream: OK\0');}),async(scanner,sockets)=>{
  await scanner.scan(bytes,{timeoutMs:1000});assert.equal(submitted.command,'zINSTREAM');assert.equal(submitted.total,bytes.length);assert.deepEqual(submitted.chunks,[65536,65536,17]);assert.equal(submitted.digest,createHash('sha256').update(bytes).digest('hex'));await socketsClosed(sockets);
 });
});
test('empty buffer still transmits the final zero-length chunk',async()=>{
 let submitted;await fixture(socket=>protocol(socket,value=>{submitted=value;socket.end('stream: OK\0');}),async scanner=>{await scanner.scan(Buffer.alloc(0));assert.equal(submitted.total,0);assert.deepEqual(submitted.chunks,[]);});
});
test('a split but complete NUL-terminated reply succeeds only after EOF',async()=>{
 await fixture(socket=>protocol(socket,()=>{socket.write('str');setTimeout(()=>socket.end('eam: OK\0'),15);}),async scanner=>{await scanner.scan(Buffer.from('synthetic fixture'),{timeoutMs:1000});});
});
test('OK substring, whitespace, wrong delimiter and malformed records never mean clean',async()=>{
 for(const answer of ['prefix stream: OK\0','stream: NOT OK\0','stream: OK suffix\0',' stream: OK\0','stream: OK \0','stream: OK\n','stream: OK\0stream: Synthetic FOUND\0','stream: OK\0garbage',Buffer.from([0xff,0])]){
  await fixture(socket=>protocol(socket,()=>socket.end(answer)),async scanner=>{await assert.rejects(()=>scanner.scan(Buffer.from('fixture'),{timeoutMs:1000}),error=>error.code?.startsWith('SCAN_')&&error.threat!==true);});
 }
});
test('a delayed second reply record after OK is rejected instead of accepting the first frame',async()=>{
 await fixture(socket=>protocol(socket,()=>{socket.write('stream: OK\0');setTimeout(()=>socket.end('stream: Synthetic FOUND\0'),20);}),async scanner=>{await assert.rejects(()=>scanner.scan(Buffer.from('fixture'),{timeoutMs:1000}),{code:'SCAN_PROTOCOL'});});
});
test('FOUND verdict is marked as a threat; unrelated FOUND substring is a scanner rejection',async()=>{
 for(const [answer,threat,code] of [['stream: Synthetic-Test FOUND\0',true,'SCAN_THREAT'],['stream: FOUNDATION ERROR\0',false,'SCAN_REJECTED'],['INSTREAM size limit exceeded. ERROR\0',false,'SCAN_REJECTED']]){
  await fixture(socket=>protocol(socket,()=>socket.end(answer)),async scanner=>{await assert.rejects(()=>scanner.scan(Buffer.from('fixture'),{timeoutMs:1000}),error=>error.code===code&&error.threat===threat);});
 }
});
test('partial, empty and unterminated EOF replies cannot be returned as clean',async()=>{
 for(const answer of ['', 'stream:', 'stream: OK'])await fixture(socket=>protocol(socket,()=>socket.end(answer)),async scanner=>{await assert.rejects(()=>scanner.scan(Buffer.from('fixture'),{timeoutMs:1000}),{code:'SCAN_TRUNCATED'});});
});
test('oversized response is bounded in bytes and destroys the connection',async()=>{
 await fixture(socket=>protocol(socket,()=>socket.write(Buffer.alloc(8193,0x61))),async(scanner,sockets)=>{await assert.rejects(()=>scanner.scan(Buffer.from('fixture'),{timeoutMs:1000}),{code:'SCAN_REPLY_LIMIT'});await socketsClosed(sockets);});
});
test('partial trickle response cannot reset the total deadline',async()=>{
 await fixture(socket=>protocol(socket,()=>{const timer=setInterval(()=>socket.write('x'),15);socket.once('close',()=>clearInterval(timer));}),async(scanner,sockets)=>{
  const started=performance.now();await assert.rejects(()=>scanner.scan(Buffer.from('fixture'),{timeoutMs:120,idleTimeoutMs:80}),{code:'SCAN_DEADLINE'});assert.ok(performance.now()-started<1500);await socketsClosed(sockets);
 });
});
test('a complete frame without EOF is still bounded by the total deadline',async()=>{
 await fixture(socket=>protocol(socket,()=>socket.write('stream: OK\0')),async(scanner,sockets)=>{await assert.rejects(()=>scanner.scan(Buffer.from('fixture'),{timeoutMs:100}),{code:'SCAN_DEADLINE'});await socketsClosed(sockets);});
});
test('idle peer is cancelled and cannot produce a clean result',async()=>{
 await fixture(socket=>protocol(socket,()=>{}),async(scanner,sockets)=>{await assert.rejects(()=>scanner.scan(Buffer.from('fixture'),{timeoutMs:1000,idleTimeoutMs:60}),{code:'SCAN_IDLE_TIMEOUT'});await socketsClosed(sockets);});
});
test('deadline includes a connection that never completes',async()=>{
 let socket;const scanner=createScanner({connect:()=>{socket=new net.Socket();return socket;}});
 await assert.rejects(()=>scanner.clamCommand('VERSION',undefined,{timeoutMs:60}),{code:'SCAN_DEADLINE'});assert.equal(socket.destroyed,true);
});
test('pre-abort opens no socket, and abort during connection destroys the pending socket',async()=>{
 let opened=0,socket;const scanner=createScanner({connect:()=>{opened++;socket=new net.Socket();return socket;}}),pre=new AbortController();pre.abort();
 await assert.rejects(()=>scanner.scannerVersion({signal:pre.signal}),{code:'ABORT_ERR'});assert.equal(opened,0);
 const parent=new AbortController(),pending=scanner.scannerVersion({signal:parent.signal,timeoutMs:1000});parent.abort();await assert.rejects(pending,{code:'ABORT_ERR'});assert.equal(socket.destroyed,true);assert.equal(getEventListeners(parent.signal,'abort').length,0);
});
test('abort after a partial response promptly destroys the socket without claiming clean',async()=>{
 const partial=gate(),parent=new AbortController();
 await fixture(socket=>protocol(socket,()=>{socket.write('stream: O');partial.resolve();}),async(scanner,sockets)=>{
  const pending=scanner.scan(Buffer.from('fixture'),{signal:parent.signal,timeoutMs:2000});await partial.promise;const started=performance.now();parent.abort('private reason is not exposed');
  await assert.rejects(pending,error=>error.code==='ABORT_ERR'&&!error.message.includes('private'));assert.ok(performance.now()-started<500);assert.equal(getEventListeners(parent.signal,'abort').length,0);await socketsClosed(sockets);
 });
});
test('a paused peer cannot enqueue a whole book and abort cancels blocked backpressure',async()=>{
 let client,maxQueued=0,writes=0;const connected=gate(),parent=new AbortController();
 await fixture(socket=>{socket.pause();connected.resolve();},async(scanner,sockets)=>{
  const pending=scanner.scan(Buffer.alloc(24*1024*1024,0x61),{signal:parent.signal,timeoutMs:2000});await connected.promise;
  for(let n=0;n<100&&!client.writableNeedDrain;n++)await sleep(5);
  assert.equal(client.writableNeedDrain,true,'fixture must actually stall the writer');assert.ok(maxQueued<=65540,`queued ${maxQueued} bytes`);assert.ok(writes<385,'the whole input was not blindly queued');
  parent.abort();await assert.rejects(pending,{code:'ABORT_ERR'});assert.equal(client.destroyed,true);
  // The paused server may not observe FIN/RST until it resumes reading.
  for(const socket of sockets)socket.resume();await socketsClosed(sockets);
 },{inspectClient:socket=>{client=socket;const write=socket.write.bind(socket);socket.write=(...args)=>{writes++;const accepted=write(...args);maxQueued=Math.max(maxQueued,socket.writableLength);return accepted;};}});
});
test('socket reset while sending cannot leave an unresolved writer or clean result',async()=>{
 await fixture(socket=>socket.destroy(),async scanner=>{await assert.rejects(()=>scanner.scan(Buffer.alloc(2*1024*1024),{timeoutMs:1000}),error=>['SCAN_UNAVAILABLE','SCAN_TRUNCATED'].includes(error.code));});
});
test('freshness requires ClamAV version, nonzero database number and a bounded valid timestamp',async()=>{
 const now=Date.parse('2026-10-22T12:00:00.000Z'),day=86400000;
 const cases=[
  [`ClamAV 1.5.1/28000/${new Date(now).toISOString()}`,true],
  [`ClamAV 1.5.1/28000/${new Date(now-7*day).toISOString()}`,true],
  [`ClamAV 1.5.1/28000/${new Date(now-7*day-1).toISOString()}`,false],
  [`ClamAV 1.5.1/28000/${new Date(now+day).toISOString()}`,true],
  [`ClamAV 1.5.1/28000/${new Date(now+day+1).toISOString()}`,false],
  [`OtherScanner 1.5.1/28000/${new Date(now).toISOString()}`,false],
  [`ClamAV 1.5.1/0/${new Date(now).toISOString()}`,false],
  ['ClamAV 1.5.1/28000/not-a-date',false],
  ['COMMAND UNAVAILABLE',false]
 ];
 for(const [version,valid] of cases)await fixture(socket=>protocol(socket,({command})=>{assert.equal(command,'zVERSION');socket.end(version+'\0');}),async scanner=>{
  if(valid)assert.equal(await scanner.scannerVersion({timeoutMs:1000}),version);else await assert.rejects(()=>scanner.scannerVersion({timeoutMs:1000}),{code:'SCAN_STALE'});
 },{now:()=>now});
});
test('successful VERSION/scan remove parent listeners; invalid commands/options never connect',async()=>{
 const parent=new AbortController(),version=`ClamAV 1.5.1/28000/${new Date().toISOString()}`;
 await fixture(socket=>protocol(socket,({command})=>socket.end(command==='zVERSION'?version+'\0':'stream: OK\0')),async scanner=>{
  await scanner.scannerVersion({signal:parent.signal});await scanner.scan(Buffer.from('fixture'),{signal:parent.signal});assert.equal(getEventListeners(parent.signal,'abort').length,0);
 });
 let opened=0;const scanner=createScanner({connect:()=>{opened++;throw new Error('must not connect');}});
 for(const command of ['SHUTDOWN','VERSION\0SHUTDOWN','INSTREAM\nVERSION'])await assert.rejects(()=>scanner.clamCommand(command),{code:'SCAN_COMMAND'});
 await assert.rejects(()=>scanner.clamCommand('VERSION',Buffer.from('unexpected')),{code:'SCAN_COMMAND'});
 await assert.rejects(()=>scanner.scan('not bytes'),{code:'SCAN_INPUT'});await assert.rejects(()=>scanner.scan(Buffer.alloc(24*1024*1024+1)),{code:'SCAN_INPUT'});
 await assert.rejects(()=>scanner.scan(Buffer.alloc(0),{timeoutMs:Infinity}));assert.equal(opened,0);
});
