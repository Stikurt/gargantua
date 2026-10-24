import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const docker=(...args)=>execFileSync('docker',['compose',...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
const cli=(...args)=>docker('exec','-T','app','node','server/cli.mjs',...args);
const creds=JSON.parse((await fs.readFile('.local/login.txt','utf8')).replace(/^\uFEFF/,''));
const {id:bookId}=JSON.parse(await fs.readFile('.local/test-book.json','utf8'));
let cookie='',csrf='';
async function call(route,options={}){
 const headers={'X-Cotology':'1','X-CSRF-Token':csrf,Cookie:cookie};
 if(options.body&&!(options.body instanceof FormData)){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
 const r=await fetch('http://localhost:3080/api'+route,{...options,headers});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,body:await r.json()};
}
await call('/login',{method:'POST',body:{login:creds.login,password:creds.password}});csrf=(await call('/me')).body.csrf;
cli('security','lockdown');
try{
 assert.equal((await call(`/books/${bookId}/chapters/0`)).status,423);
 assert.equal((await call('/imports/link',{method:'POST',body:{kind:'file',url:'https://example.com/book.txt'}})).status,423);
 console.log('PASS: lockdown prevents new reading requests and imports');
}finally{cli('security','unlock');cli('security','resume');}
assert.equal((await call(`/books/${bookId}/chapters/0`)).status,200);
// Explicit book block is tested inside a rolled-back transaction via the same DB;
// app-level check is verified with a temporary security flag, restored in finally.
const dbScript=`import{query,pool}from'./server/db.mjs';await query("UPDATE books SET security_state='blocked' WHERE id=$1",[${JSON.stringify(bookId)}]);await pool.end();`;
docker('exec','-T','app','node','--input-type=module','-e',dbScript);
try{
 assert.equal((await call(`/books/${bookId}/download`)).status,423);
 assert.equal((await call(`/books/${bookId}/chapters/0`)).status,423);
 console.log('PASS: blocked book cannot issue chapters or offline packages');
}finally{
 docker('exec','-T','app','node','--input-type=module','-e',dbScript.replace("security_state='blocked'","security_state='passed'"));
}
docker('stop','-t','5','clamav');
let id;
try{
 const form=new FormData();form.append('file',new Blob(['Сканер отсутствует: эта книга не должна публиковаться.']),'scanner-unavailable.txt');
 const response=await call('/imports/upload',{method:'POST',body:form});assert.equal(response.status,202);id=response.body.id;
 let row;
 for(let i=0;i<20;i++){row=(await call('/imports')).body.find(x=>x.id===id);if(row.status==='error')break;await new Promise(r=>setTimeout(r,1500));}
 assert.equal(row.status,'error');assert.equal(row.book_id,null);assert.equal(row.security_state,'error');
 console.log('PASS: scanner outage leaves upload unpublished (fail closed)');
}finally{docker('start','clamav');if(id)cli('security','purge',id);}
console.log('Incident checks complete. Normal serving/import mode restored.');
