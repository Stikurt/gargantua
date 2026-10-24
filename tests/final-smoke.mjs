import fs from'node:fs/promises';
import{createHash}from'node:crypto';
import{execFileSync}from'node:child_process';
import assert from'node:assert/strict';
const creds=JSON.parse((await fs.readFile('.local/login.txt','utf8')).replace(/^\uFEFF/,''));let cookie='',csrf='';
async function call(route,options={}){const headers={'X-Cotology':'1','X-CSRF-Token':csrf,Cookie:cookie};if(options.body&&!(options.body instanceof FormData)){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}const r=await fetch('http://localhost:3080/api'+route,{...options,headers});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,body:await r.json()};}
await call('/login',{method:'POST',body:{login:creds.login,password:creds.password}});csrf=(await call('/me')).body.csrf;
const input='Проверка окончательной версии.\n\nХеш входа должен совпадать с результатом парсера.';
const form=new FormData();form.append('file',new Blob([input]),'final-smoke.txt');const response=await call('/imports/upload',{method:'POST',body:form});assert.equal(response.status,202);
let row;
for(let n=0;n<70;n++){row=(await call('/imports')).body.find(x=>x.id===response.body.id);if(['completed','error','blocked'].includes(row.status))break;await new Promise(r=>setTimeout(r,1000));}
assert.equal(row.status,'completed',row.error);assert.equal(row.report.sha256,createHash('sha256').update(input).digest('hex'));assert.equal((await call('/books/'+row.book_id)).status,200);
console.log('PASS: final pipeline publishes only matching input hash and parsed output');
const script=`import fs from'node:fs/promises';import path from'node:path';import{query,pool}from'./server/db.mjs';import{validId}from'./server/security.mjs';const id=validId(${JSON.stringify(row.book_id)});const b=(await query('SELECT title FROM books WHERE id=$1',[id])).rows[0];if(b.title!=='final-smoke')throw new Error('Not a test book');await query('DELETE FROM books WHERE id=$1',[id]);const root=path.resolve('/library/books'),target=path.resolve(root,id);if(path.dirname(target)!==root)throw new Error('Bad path');await fs.rm(target,{recursive:true,force:true});await pool.end();`;
execFileSync('docker',['compose','exec','-T','worker','node','--input-type=module','-e',script],{stdio:'pipe'});
console.log('PASS: only synthetic smoke book removed; demonstration library preserved');
