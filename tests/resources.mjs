import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
// Call with Windows monitor stopped; restore its previously observed state even
// if assertions fail. This test changes only the local metrics handshake file.
const statePath='.local/runtime/resources.json';
const original=JSON.parse((await fs.readFile(statePath,'utf8')).replace(/^\uFEFF/,''));
const creds=JSON.parse((await fs.readFile('.local/login.txt','utf8')).replace(/^\uFEFF/,''));
let cookie='',csrf='';
async function call(route,options={}){
 const headers={'X-Cotology':'1','X-CSRF-Token':csrf,Cookie:cookie};
 if(options.body&&!(options.body instanceof FormData)){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
 const r=await fetch('http://localhost:3080/api'+route,{...options,headers});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,body:await r.json()};
}
await call('/login',{method:'POST',body:{login:creds.login,password:creds.password}});csrf=(await call('/me')).body.csrf;
let testId;
try{
 await fs.writeFile(statePath,JSON.stringify({...original,updatedAt:Date.now(),allowHeavy:false,message:'Тест: очередь ждёт ресурсы'}));
 const f=new FormData();f.append('file',new Blob(['Синтетический тест ожидания ресурсов.']),'resource-check.txt');
 const response=await call('/imports/upload',{method:'POST',body:f});assert.equal(response.status,202);testId=response.body.id;
 let row;
 for(let i=0;i<15;i++){row=(await call('/imports')).body.find(x=>x.id===testId);if(row.stage==='Ожидание свободных ресурсов ПК')break;await new Promise(r=>setTimeout(r,1000));}
 assert.equal(row.stage,'Ожидание свободных ресурсов ПК');assert.equal(row.book_id,null);console.log('PASS: low resource signal suspends heavy processing before scan');
 const {id:bookId}=JSON.parse(await fs.readFile('.local/test-book.json','utf8'));
 assert.equal((await call(`/books/${bookId}/chapters/0`)).status,200);console.log('PASS: reading continues while heavy queue waits');
 // Reject the synthetic task by pausing imports; no extra book is published.
 const {execFileSync}=await import('node:child_process');
 execFileSync('docker',['compose','exec','-T','app','node','server/cli.mjs','security','pause'],{stdio:'pipe'});
 for(let i=0;i<10;i++){row=(await call('/imports')).body.find(x=>x.id===testId);if(row.status==='error')break;await new Promise(r=>setTimeout(r,1000));}
 assert.equal(row.status,'error');console.log('PASS: administrative pause interrupts a waiting job safely');
}finally{
 await fs.writeFile(statePath,JSON.stringify({...original,updatedAt:Date.now()}));
 const {execFileSync}=await import('node:child_process');
 execFileSync('docker',['compose','exec','-T','app','node','server/cli.mjs','security','resume'],{stdio:'pipe'});
 if(testId)execFileSync('docker',['compose','exec','-T','app','node','server/cli.mjs','security','purge',testId],{stdio:'pipe'});
}
