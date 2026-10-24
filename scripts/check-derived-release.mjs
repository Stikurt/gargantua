// Read-only authenticated release check; never print credentials or cookies.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),destination=new URL('.local/test-results/c2-release/derived-http.json',root);
const login=JSON.parse((await fs.readFile(new URL('.local/login.txt',root),'utf8')).replace(/^\uFEFF/,''));
const response=await fetch('http://localhost:3080/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Cotology':'1'},body:JSON.stringify({login:login.login,password:login.password})});
if(response.status!==200)throw Error('Release login failed without exposing credentials');
const cookie=response.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw Error('Session cookie missing');
const headers={Cookie:cookie};let csrf;
try{
 const get=async route=>{const result=await fetch('http://localhost:3080'+route,{headers});assert.equal(result.status,200,route);return result.json();};
 const me=await get('/api/me');csrf=me.csrf;
 const status=await get('/api/status');assert.equal(status.version,'0.2.0-core.9');assert.equal(status.storageVersion,10);
 const implementation=await get('/api/v2/implementation');assert.ok(implementation.implemented.includes('durable derived queue'));
 const profiles=await get('/api/derived/profiles');assert.equal(profiles.profiles.length,2);
 const requests=await get('/api/derived/requests');assert.ok(Array.isArray(requests));
 const books=await get('/api/books');for(const book of books){await get('/api/books/'+book.id);await get('/api/v2/publications/'+book.id+'?revision=1');}
 const report={status:'passed',checkedAt:new Date().toISOString(),version:status.version,storageVersion:status.storageVersion,originalBooksReadable:books.length,derivedProfiles:profiles.profiles.length,derivedRequests:requests.length,executor:status.statuses.find(row=>row.name==='derived-executor')?.value};
 await fs.writeFile(destination,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(csrf)await fetch('http://localhost:3080/api/logout',{method:'POST',headers:{...headers,'X-Cotology':'1','X-CSRF-Token':csrf}});}
