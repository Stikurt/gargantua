// Local verification of the private HTTPS route. No credentials are printed.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const connection=JSON.parse((await fs.readFile('.local/server-connection.json','utf8')).replace(/^\uFEFF/,''));
const credentials=JSON.parse((await fs.readFile('.local/login.txt','utf8')).replace(/^\uFEFF/,''));
assert.match(connection.url,/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/);
let cookie='',csrf='';
async function call(route,options={}){
 const headers={'X-Cotology':'1','Origin':'http://localhost:3080','X-CSRF-Token':csrf};if(cookie)headers.Cookie=cookie;
 if(options.body){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
 const result=await fetch(connection.url+'/api'+route,{...options,headers,redirect:'error',signal:AbortSignal.timeout(30000)});
 const setCookie=result.headers.getSetCookie().find(value=>value.startsWith('cotology='));if(setCookie)cookie=setCookie.split(';')[0];return result;
}
try{
 assert.equal((await call('/health')).status,200);
 assert.equal((await call('/books')).status,401);
 assert.equal((await call('/login',{method:'POST',body:credentials})).status,200);
 const profile=await(await call('/me')).json();csrf=profile.csrf;assert.ok(csrf);
 const books=await(await call('/books')).json();const book=books.find(b=>b.title==='Путеводитель по тихой библиотеке');assert.ok(book);
 const packet=await(await call(`/books/${book.id}/download`)).json();assert.equal(packet.chapters.length,3);
 assert.equal((await call('/logout',{method:'POST'})).status,200);cookie='';
 console.log('Private HTTPS: health, anonymous denial, login, profile, prepared package and logout passed.');
}finally{if(cookie)await call('/logout',{method:'POST'}).catch(()=>{});}
