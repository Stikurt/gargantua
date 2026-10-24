import{execFileSync}from'node:child_process';
import assert from'node:assert/strict';
const cli=(...args)=>execFileSync('docker',['compose','exec','-T','app','node','server/cli.mjs',...args],{encoding:'utf8'});
const login=`test-role-${Date.now()}`;
const account=JSON.parse(cli('profiles','create',login));
let cookie='',csrf='';
async function call(route,options={}){
 const headers={'X-Cotology':'1','X-CSRF-Token':csrf,Cookie:cookie};
 if(options.body&&!(options.body instanceof FormData)){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
 const r=await fetch('http://localhost:3080/api'+route,{...options,headers});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,body:await r.json()};
}
try{
 await call('/login',{method:'POST',body:{login:account.login,password:account.password}});csrf=(await call('/me')).body.csrf;
 const first=await call('/imports/link',{method:'POST',body:{kind:'file',url:'https://example.invalid/test.txt'}});assert.equal(first.status,202);
 assert.equal((await call('/imports')).body.find(x=>x.id===first.body.id).status,'pending-approval');console.log('PASS: reader request requires approval');
 cli('roles','grant',account.id,'trusted-import');
 const second=await call('/imports/link',{method:'POST',body:{kind:'file',url:'https://example.invalid/test.txt'}});assert.equal(second.status,202);
 assert.ok(['queued','processing','error'].includes((await call('/imports')).body.find(x=>x.id===second.body.id).status));console.log('PASS: role grants automatic approval without re-login');
 cli('roles','revoke',account.id,'trusted-import');
 const third=await call('/imports/link',{method:'POST',body:{kind:'file',url:'https://example.invalid/test.txt'}});assert.equal(third.status,202);
 assert.equal((await call('/imports')).body.find(x=>x.id===third.body.id).status,'pending-approval');console.log('PASS: role revocation takes effect immediately');
}finally{
 const source=`import{query,pool}from'./server/db.mjs'; const id=${JSON.stringify(account.id)}; const n=Number((await query('SELECT count(*) FROM books WHERE requested_by=$1',[id])).rows[0].count);if(n)throw new Error('Unexpected published test book');await query('DELETE FROM imports WHERE requested_by=$1',[id]);await query('DELETE FROM sessions WHERE profile_id=$1',[id]);await query('UPDATE audit SET actor=NULL WHERE actor=$1',[id]);await query('DELETE FROM profiles WHERE id=$1',[id]);await pool.end();`;
 execFileSync('docker',['compose','exec','-T','app','node','--input-type=module','-e',source],{stdio:'pipe'});
}
