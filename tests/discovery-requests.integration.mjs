// Disposable schema only. No production migration, provider network or files.
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {assignBookModel,sealPublicationModel} from '../server/work-model.mjs';
import {packageDigest} from '../server/publication-files.mjs';
import {sha256} from '../server/publication-model.mjs';
import {canonicalJson} from '../server/publication-model.mjs';
import {claimImport,assertAttempt} from '../server/import-jobs.mjs';
import {createRanobeRequestInTransaction} from '../server/ranobe-store.mjs';
import {applyImportDecision} from '../server/import-decisions.mjs';
import {syncDiscoveryImports} from '../server/discovery-orchestrator.mjs';
import {createDiscoverySearch} from '../server/discovery-providers.mjs';
import {createDiscoveryRequest,getDiscoveryRequest,listDiscoveryRequests,decideDiscoveryRequest,claimDiscoveryRequest,renewDiscoveryRequest,finishDiscoveryRequest,failDiscoveryRequest,withDiscoveryAcquisition,withDiscoverySourceAcquisition,syncDiscoveryImport,completeDiscoveryFromLibrary} from '../server/discovery-requests.mjs';

const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(url.pathname))throw Error('Explicit isolated TEST_DATABASE_URL required; refusing production');
const schema='discovery_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href,max:1,statement_timeout:10000});
const isolated=new URL(url);isolated.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:isolated.href,max:12,statement_timeout:10000});let created=false;
const owner={id:randomUUID()},trusted={id:randomUUID()},reader={id:randomUUID()},other={id:randomUUID()};
const input=(query='Synthetic book',extra={})=>({idempotencyKey:randomUUID(),query,...extra});
const candidate=(extra={})=>({id:'dsc_'+'1'.repeat(32),kind:'book',title:'Synthetic book',identity:{provider:'gutendex',remoteId:'11'},availability:'fetchable',eligibleForAcquisition:true,downloadSelections:[{url:'https://gutenberg.pglaf.org/epub/11/pg11-images.epub',extension:'epub'}],...extra});
const plan=(c=candidate(),extra={})=>({status:'resolved',nextAction:'acquire',selectedCandidateId:c.id,candidates:[c],providerErrors:[],clarifications:[],...extra});
const metadataId=c=>`dsc_${createHash('sha256').update(JSON.stringify([c.identity.provider,c.kind,c.identity.remoteId])).digest('hex').slice(0,32)}`;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await applyMigrations(pool);});
beforeEach(async()=>{
 await pool.query('TRUNCATE profiles,works RESTART IDENTITY CASCADE');await pool.query('UPDATE settings SET imports_paused=false,serving_paused=false WHERE id=1');
 for(const [profile,role]of [[owner,'owner'],[trusted,'trusted-import'],[reader,'reader'],[other,'reader']])await pool.query('INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,$4)',[profile.id,'test-'+profile.id,'synthetic-no-login',role]);
});
after(async()=>{await pool.end();try{if(created){assert.match(schema,/^discovery_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}});
const count=async table=>Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
test('discovery persists an explicit bounded batch and keeps legacy idempotent retries intact',async()=>{
 const body=input('Batch book'),created=await createDiscoveryRequest(pool,owner,body);assert.deepEqual(created.request.input.chapterRange,{start:1,count:5});assert.equal((await createDiscoveryRequest(pool,owner,{...body,chapterRange:{start:1,count:5}})).idempotent,true);
 await assert.rejects(()=>createDiscoveryRequest(pool,owner,{...body,chapterRange:{start:6,count:5}}),{code:'DISCOVERY_IDEMPOTENCY'});await assert.rejects(()=>createDiscoveryRequest(pool,owner,input('Bad range',{chapterRange:{start:1,count:6}})),{code:'DERIVED_CHAPTER_RANGE'});
 const next=await createDiscoveryRequest(pool,reader,input('Batch book',{chapterRange:{start:6,count:5}}));assert.equal(next.request.status,'pending-approval');assert.deepEqual(next.request.input.chapterRange,{start:6,count:5});
 const legacyInput={query:'Legacy batch book',intent:'auto',language:'ru',audio:true,allowOriginal:false},legacyHash=sha256(Buffer.from(canonicalJson(legacyInput))),legacyId=randomUUID(),key=randomUUID();await pool.query("INSERT INTO discovery_requests(id,requested_by,body_hash,input,query_text,status,outputs) VALUES($1,$2,$3,$4,$5,'book-ready','{}')",[legacyId,owner.id,legacyHash,JSON.stringify(legacyInput),legacyInput.query]);await pool.query('INSERT INTO discovery_idempotency(profile_id,key,body_hash,request_id) VALUES($1,$2,$3,$4)',[owner.id,key,legacyHash,legacyId]);const old=await createDiscoveryRequest(pool,owner,{idempotencyKey:key,query:legacyInput.query});assert.equal(old.idempotent,true);assert.equal(old.request.id,legacyId);assert.equal(old.request.input.chapterRange,undefined);
});
async function selectedRequest(profile=owner,value=input()){
 await createDiscoveryRequest(pool,profile,value);const discovery=await claimDiscoveryRequest(pool);assert.equal(discovery.phase,'discovery');const planned=await finishDiscoveryRequest(pool,discovery,plan());assert.equal(planned.status,'selected');const acquisition=await claimDiscoveryRequest(pool);assert.equal(acquisition.phase,'acquisition');return acquisition;
}
async function insertImport(client,row){const importId=randomUUID();await client.query("INSERT INTO imports(id,requested_by,kind,filename,status,approved_by,decision_reason,options) VALUES($1,$2,'file','synthetic.txt','queued',$3,$4,$5)",[importId,row.requested_by,row.approved_by,row.decision_reason,JSON.stringify({discovery:{requestId:row.id}})]);return importId;}
async function seedBook(client,importId,requestedBy,language='en'){
 const book={title:'Synthetic existing library book',author:'Test',language,chapters:[{title:'One',blocks:[{type:'text',text:'Synthetic sealed content '+randomUUID()}]}],assets:{}},raw=Buffer.from(JSON.stringify(book)),checksum=sha256(raw),manifest={schemaVersion:1,files:[{path:'book.json',bytes:raw.length,sha256:checksum}]},model=await assignBookModel(client,book),bookId=randomUUID();
 const row=(await client.query('INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by,content_sha256,content_bytes,package_sha256,artifact_manifest,work_id,expression_id,edition_id) VALUES($1,$2,$3,$4,1,$5,$6,$7,$5,$8,$9,$10,$11,$12,$13) RETURNING *',[bookId,book.title,book.author,language,checksum,importId,requestedBy,raw.length,packageDigest(manifest),JSON.stringify(manifest),model.work_id,model.expression_id,model.edition_id])).rows[0];await sealPublicationModel(client,row,book);return bookId;
}
test('creation uses actual roles, default RU/audio and owner approval for readers',async()=>{
 const a=await createDiscoveryRequest(pool,owner,input()),b=await createDiscoveryRequest(pool,trusted,input()),c=await createDiscoveryRequest(pool,{...reader,role:'owner'},input());
 assert.equal(a.request.status,'queued');assert.equal(b.request.status,'queued');assert.equal(c.request.status,'pending-approval');assert.equal(c.request.approved_by,null);assert.equal(c.request.input.language,'ru');assert.equal(c.request.input.audio,true);assert.equal(c.request.outputs.audio.status,'pending-provider');
 await assert.rejects(()=>decideDiscoveryRequest(pool,reader,{id:c.request.id,action:'approve',expectedRevision:1}),{status:403});
 const approved=await decideDiscoveryRequest(pool,owner,{id:c.request.id,action:'approve',expectedRevision:1});assert.equal(approved.status,'queued');assert.equal(approved.approved_by,owner.id);assert.equal(approved.revision,2);
});
test('idempotency and active-query reuse remain profile-scoped and preserve audit provenance',async()=>{
 const value=input(),results=await Promise.all(Array.from({length:6},()=>createDiscoveryRequest(pool,reader,value)));assert.equal(new Set(results.map(r=>r.request.id)).size,1);assert.equal(await count('discovery_requests'),1);assert.equal(await count('discovery_idempotency'),1);assert.equal(await count('audit'),1);
 await assert.rejects(()=>createDiscoveryRequest(pool,reader,{...value,query:'Different book'}),{status:409,code:'DISCOVERY_IDEMPOTENCY'});
 const again=await createDiscoveryRequest(pool,reader,{...value,idempotencyKey:randomUUID()});assert.equal(again.reused,true);assert.equal(again.request.id,results[0].request.id);assert.equal(await count('discovery_idempotency'),2);
 const separate=await createDiscoveryRequest(pool,other,{...value,idempotencyKey:randomUUID()});assert.notEqual(separate.request.id,again.request.id);assert.equal(separate.request.requested_by,other.id);
});
test('raw URLs/unknown inputs are rejected before durable writes',async()=>{
 for(const value of [input('https://example.org/a.epub'),input('file:///x'),input('Valid title',{downloadUrl:'https://example.org/a'}),input('x'),input('Valid',{audio:'true'})])await assert.rejects(()=>createDiscoveryRequest(pool,owner,value),{status:400});assert.equal(await count('discovery_requests'),0);
});
test('own visibility and owner visibility never expose another reader request',async()=>{
 const a=await createDiscoveryRequest(pool,reader,input()),b=await createDiscoveryRequest(pool,other,input());await assert.rejects(()=>getDiscoveryRequest(pool,reader,b.request.id),{status:404});assert.equal((await listDiscoveryRequests(pool,reader)).length,1);assert.equal((await listDiscoveryRequests(pool,owner)).length,2);assert.equal((await getDiscoveryRequest(pool,owner,a.request.id)).id,a.request.id);
});
test('personal and global quotas serialize concurrent admission without rejecting active reuse',async()=>{
 const profiles=[reader,other,...Array.from({length:4},()=>({id:randomUUID()}))];for(const profile of profiles.slice(2))await pool.query("INSERT INTO profiles(id,login,password,role) VALUES($1,$2,'fixture','reader')",[profile.id,'quota-'+profile.id]);
 for(const profile of profiles)for(let n=0;n<5;n++)await createDiscoveryRequest(pool,profile,input('Quota book '+n));assert.equal(await count('discovery_requests'),30);
 await assert.rejects(()=>createDiscoveryRequest(pool,reader,input('Sixth personal')),{status:429});await assert.rejects(()=>createDiscoveryRequest(pool,owner,input('Global overflow')),{status:429});
 assert.equal((await createDiscoveryRequest(pool,reader,input('Quota book 0'))).reused,true);
 const first=(await listDiscoveryRequests(pool,reader))[0];await decideDiscoveryRequest(pool,reader,{id:first.id,expectedRevision:first.revision,action:'cancel'});assert.equal((await createDiscoveryRequest(pool,owner,input('Freed quota'))).request.status,'queued');
});
test('claims are exclusive, expired tokens are fenced, renew and finish honor pause',async()=>{
 const created=await createDiscoveryRequest(pool,owner,input()),claims=(await Promise.all(Array.from({length:8},()=>claimDiscoveryRequest(pool)))).filter(Boolean);assert.equal(claims.length,1);const old=claims[0];
 await pool.query("UPDATE discovery_requests SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[old.id]);const current=await claimDiscoveryRequest(pool);assert.notEqual(current.attempt_token,old.attempt_token);await assert.rejects(()=>renewDiscoveryRequest(pool,old),{code:'DISCOVERY_LEASE_LOST'});await assert.rejects(()=>finishDiscoveryRequest(pool,old,plan()),{code:'DISCOVERY_LEASE_LOST'});assert.equal((await failDiscoveryRequest(pool,old,new Error('late'))).stale,true);
 await pool.query('UPDATE settings SET imports_paused=true WHERE id=1');await assert.rejects(()=>renewDiscoveryRequest(pool,current),{code:'IMPORT_PAUSED'});await assert.rejects(()=>finishDiscoveryRequest(pool,current,plan()),{code:'IMPORT_PAUSED'});assert.equal(await claimDiscoveryRequest(pool),null);await pool.query('UPDATE settings SET imports_paused=false WHERE id=1');
 await renewDiscoveryRequest(pool,current);const result=await finishDiscoveryRequest(pool,current,plan());assert.equal(result.id,created.request.id);assert.equal(result.plan_revision,1);assert.equal(result.status,'selected');
});
test('role revocation before claim or during a lease requires a new owner decision',async()=>{
 const created=await createDiscoveryRequest(pool,trusted,input());await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[trusted.id]);assert.equal(await claimDiscoveryRequest(pool),null);let row=await getDiscoveryRequest(pool,trusted,created.request.id);assert.equal(row.status,'pending-approval');assert.equal(row.approved_by,null);
 await decideDiscoveryRequest(pool,owner,{id:row.id,expectedRevision:row.revision,action:'approve'});const claim=await claimDiscoveryRequest(pool);assert.ok(claim);await finishDiscoveryRequest(pool,claim,plan());
 const auto=await createDiscoveryRequest(pool,owner,input('New second job')),running=await claimDiscoveryRequest(pool); // selected first request may be claimed first
 if(running.id!==auto.request.id)await failDiscoveryRequest(pool,running,new Error('close fixture acquisition'));
 const active=running.id===auto.request.id?running:await claimDiscoveryRequest(pool);await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[owner.id]);await assert.rejects(()=>finishDiscoveryRequest(pool,active,plan()),{code:'DISCOVERY_APPROVAL_REQUIRED'});const pending=await failDiscoveryRequest(pool,active,{code:'DISCOVERY_APPROVAL_REQUIRED'});assert.equal(pending.status,'pending-approval');
});
test('manual selection is bound to persisted candidate IDs and exact revisions; no Ranobe chapter default',async()=>{
 await createDiscoveryRequest(pool,owner,input());const claim=await claimDiscoveryRequest(pool),preview=candidate({availability:'needs-preview',downloadSelections:[],eligibleForAcquisition:false}),row=await finishDiscoveryRequest(pool,claim,plan(preview,{nextAction:'needs_preview'}));assert.equal(row.status,'needs-review');
 await assert.rejects(()=>decideDiscoveryRequest(pool,owner,{id:row.id,action:'select',expectedRevision:row.revision,planRevision:0,candidateId:preview.id}),{status:409});await assert.rejects(()=>decideDiscoveryRequest(pool,owner,{id:row.id,action:'select',expectedRevision:row.revision,planRevision:1,candidateId:'not-in-plan'}),{status:409});
 const selected=await decideDiscoveryRequest(pool,owner,{id:row.id,action:'select',expectedRevision:row.revision,planRevision:1,candidateId:preview.id});assert.equal(selected.status,'needs-review');assert.equal(await claimDiscoveryRequest(pool),null);assert.equal(await count('imports'),0);
});
test('author and curated first-arc selections queue bounded metadata expansion',async()=>{
 for(const c of [candidate({kind:'author',identity:{provider:'openlibrary',remoteId:'OL2623461A'},availability:'metadata-only',downloadSelections:[]}),candidate({identity:{provider:'curated',remoteId:'warriors:tpc:1'},availability:'metadata-only',downloadSelections:[]})]){
  c.id=metadataId(c);
  await createDiscoveryRequest(pool,owner,input('Expansion '+randomUUID()));const claim=await claimDiscoveryRequest(pool),row=await finishDiscoveryRequest(pool,claim,plan(c,{status:'needs_clarification',selectedCandidateId:null,nextAction:'none'}));const chosen=await decideDiscoveryRequest(pool,owner,{id:row.id,action:'select',expectedRevision:row.revision,planRevision:row.plan_revision,candidateId:c.id});assert.equal(chosen.status,'queued');assert.equal(chosen.selected_candidate_id,c.id);const expanded=await claimDiscoveryRequest(pool);assert.equal(expanded.phase,'discovery');await failDiscoveryRequest(pool,expanded,new Error('Synthetic expansion ended'));
 }
});
test('plan bounds and invalid choices cannot mutate the durable revision',async()=>{
 await createDiscoveryRequest(pool,owner,input());const claim=await claimDiscoveryRequest(pool);for(const invalid of [plan(candidate(),{selectedCandidateId:'missing'}),plan(candidate(),{candidates:[candidate(),candidate()]}),plan(candidate(),{excess:'x'.repeat(130*1024)})])await assert.rejects(()=>finishDiscoveryRequest(pool,claim,invalid));assert.equal((await getDiscoveryRequest(pool,owner,claim.id)).plan_revision,0);
});
test('import creation, request link and audit commit atomically or all roll back',async()=>{
 const claim=await selectedRequest();
 await assert.rejects(()=>withDiscoveryAcquisition(pool,claim,async(client,row)=>{await insertImport(client,row);throw new Error('synthetic acquisition failure');}),/synthetic acquisition failure/);assert.equal(await count('imports'),0);assert.equal((await getDiscoveryRequest(pool,owner,claim.id)).status,'processing');
 await pool.query("CREATE FUNCTION fail_discovery_link_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='discovery.import-linked' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER fail_link BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION fail_discovery_link_audit()");
 try{await assert.rejects(()=>withDiscoveryAcquisition(pool,claim,insertImport),/synthetic audit failure/);assert.equal(await count('imports'),0);}finally{await pool.query('DROP TRIGGER fail_link ON audit;DROP FUNCTION fail_discovery_link_audit()');}
 const linked=await withDiscoveryAcquisition(pool,claim,insertImport);assert.equal(linked.status,'acquiring');assert.equal(await count('imports'),1);await assert.rejects(()=>withDiscoveryAcquisition(pool,claim,insertImport),{code:'DISCOVERY_LEASE_LOST'});assert.equal(await count('imports'),1);
});
test('cancelling a linked processing import invalidates both workers and commits both audits',async()=>{
 const claim=await selectedRequest(),linked=await withDiscoveryAcquisition(pool,claim,insertImport),imported=await claimImport(pool);assert.equal(imported.id,linked.import_id);
 const cancelled=await decideDiscoveryRequest(pool,owner,{id:linked.id,expectedRevision:linked.revision,action:'cancel'});assert.equal(cancelled.status,'cancelled');await assert.rejects(()=>assertAttempt(pool,imported),{code:'LEASE_LOST'});assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[imported.id])).rows[0].status,'cancelled');assert.equal((await failDiscoveryRequest(pool,claim,new Error('late result'))).stale,true);
});
test('book readiness leaves translation/audio independently pending and does not exhaust discovery quota',async()=>{
 const claim=await selectedRequest(),linked=await withDiscoveryAcquisition(pool,claim,insertImport),client=await pool.connect();let bookId;try{await client.query('BEGIN');bookId=await seedBook(client,linked.import_id,owner.id,'en');await client.query("UPDATE imports SET status='completed',book_id=$1 WHERE id=$2",[bookId,linked.import_id]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const ready=await syncDiscoveryImport(pool,linked.id);assert.equal(ready.status,'book-ready');assert.equal(ready.outputs.book.publicationId,bookId);assert.equal(ready.outputs.translation.status,'pending-provider');assert.equal(ready.outputs.audio.status,'pending-provider');assert.equal((await syncDiscoveryImport(pool,linked.id)).revision,ready.revision);
});
test('library completion is tied to the stored book ID, a passed seal and a verification callback',async()=>{
 const client=await pool.connect();let bookId;try{await client.query('BEGIN');const imported=await insertImport(client,{id:randomUUID(),requested_by:owner.id,approved_by:owner.id,decision_reason:'role-auto-approval'});bookId=await seedBook(client,imported,owner.id,'ru');await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const local=candidate({id:'local_'+bookId,identity:{provider:'library',remoteId:bookId},bookId,availability:'library',downloadSelections:[]});await createDiscoveryRequest(pool,owner,input());const metadata=await claimDiscoveryRequest(pool);await finishDiscoveryRequest(pool,metadata,plan(local,{nextAction:'reuse'}));const claim=await claimDiscoveryRequest(pool);
 await assert.rejects(()=>completeDiscoveryFromLibrary(pool,claim,bookId),{code:'DISCOVERY_VERIFICATION_REQUIRED'});await assert.rejects(()=>completeDiscoveryFromLibrary(pool,claim,randomUUID(),{verifyExisting:async()=>{}}),{code:'DISCOVERY_SELECTION'});let checked=0;
 await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[bookId]);await assert.rejects(()=>completeDiscoveryFromLibrary(pool,claim,bookId,{verifyExisting:async()=>{checked++;}}),{code:'DISCOVERY_LIBRARY_BLOCKED'});assert.equal(checked,0);await pool.query("UPDATE books SET security_state='passed' WHERE id=$1",[bookId]);
 const ready=await completeDiscoveryFromLibrary(pool,claim,bookId,{verifyExisting:async row=>{assert.equal(row.id,bookId);checked++;}});assert.equal(checked,1);assert.equal(ready.outputs.book.status,'ready');assert.equal(ready.outputs.translation.status,'not-required');assert.equal(ready.outputs.audio.status,'pending-provider');
});
test('linked import approval wait and resume update outputs once without replacing the import',async()=>{
 const claim=await selectedRequest(),linked=await withDiscoveryAcquisition(pool,claim,insertImport);
 await pool.query("UPDATE imports SET status='pending-approval',approved_by=NULL,decision_reason=NULL WHERE id=$1",[linked.import_id]);
 const waiting=await syncDiscoveryImport(pool,linked.id);assert.equal(waiting.status,'acquiring');assert.equal(waiting.outputs.book.status,'approval-required');assert.equal(waiting.error,'IMPORT_APPROVAL_REQUIRED');assert.equal(waiting.import_id,linked.import_id);
 assert.equal((await syncDiscoveryImport(pool,linked.id)).revision,waiting.revision);
 await pool.query("UPDATE imports SET status='queued',approved_by=$1,decision_reason='explicit-approval' WHERE id=$2",[owner.id,linked.import_id]);
 const resumed=await syncDiscoveryImport(pool,linked.id);assert.equal(resumed.status,'acquiring');assert.equal(resumed.outputs.book.status,'acquiring');assert.equal(resumed.error,null);assert.equal(resumed.import_id,linked.import_id);assert.equal(resumed.revision,waiting.revision+1);
 assert.equal((await syncDiscoveryImport(pool,linked.id)).revision,resumed.revision);assert.equal(await count('imports'),1);
});
const fullRanobe=(extra={})=>candidate({identity:{provider:'ranobelib',remoteId:'123'},availability:'ranobe-full',downloadSelections:[],sourceBinding:{provider:'ranobelib',remoteId:'123',slug:'123--synthetic',branchId:null,completeness:{verified:true}},...extra});
test('Ranobe acquisition requires a persisted explicit branch and verified identity; original cards expand preview',async()=>{
 const valid=fullRanobe(),invalid=[{...valid,sourceBinding:{...valid.sourceBinding,branchId:undefined}},{...valid,sourceBinding:{...valid.sourceBinding,completeness:{verified:false}}},{...valid,sourceBinding:{...valid.sourceBinding,remoteId:'999'}},{...valid,sourceBinding:{...valid.sourceBinding,slug:'999--other'}},{...valid,availability:'fetchable',downloadSelections:[{url:'https://example.org/book'}]}];
 for(const c of invalid){const value=await createDiscoveryRequest(pool,owner,input('Invalid full branch '+randomUUID())),metadata=await claimDiscoveryRequest(pool),row=await finishDiscoveryRequest(pool,metadata,plan(c));assert.equal(row.status,'needs-review');const chosen=await decideDiscoveryRequest(pool,owner,{id:row.id,action:'select',candidateId:c.id,expectedRevision:row.revision,planRevision:row.plan_revision});assert.equal(chosen.status,'needs-review');await decideDiscoveryRequest(pool,owner,{id:chosen.id,action:'cancel',expectedRevision:chosen.revision});assert.equal(value.request.import_id,null);}
 const preview=fullRanobe({availability:'needs-preview',eligibleForAcquisition:false,sourceBinding:{provider:'ranobelib',remoteId:'123',slug:'123--synthetic',requiresBranchSelection:true}});await createDiscoveryRequest(pool,owner,input('Original Ranobe card'));const metadata=await claimDiscoveryRequest(pool),row=await finishDiscoveryRequest(pool,metadata,plan(preview,{status:'needs_clarification',selectedCandidateId:null,nextAction:'none'}));const queued=await decideDiscoveryRequest(pool,owner,{id:row.id,action:'select',candidateId:preview.id,expectedRevision:row.revision,planRevision:row.plan_revision});assert.equal(queued.status,'queued');const expanded=await claimDiscoveryRequest(pool);assert.equal(expanded.phase,'discovery');assert.equal(expanded.selected_candidate_id,preview.id);
});
async function fullClaim(profile=owner){await createDiscoveryRequest(pool,profile,input('Full source '+randomUUID()));const metadata=await claimDiscoveryRequest(pool);assert.equal(metadata.requested_by,profile.id);const chosen=await finishDiscoveryRequest(pool,metadata,plan(fullRanobe()));assert.equal(chosen.status,'selected');return claimDiscoveryRequest(pool);}
const fullLink=(claim)=>withDiscoveryAcquisition(pool,claim,async(client,row)=>(await createRanobeRequestInTransaction(client,{id:row.requested_by},{url:'https://ranobelib.me/ru/book/123--synthetic',branch:null,language:'und',autoUpdate:false,force:false,idempotencyKey:randomUUID()},{checkCapacity:async()=>{}})).import.id);
test('explicit owner adapter retry resumes the same reviewed discovery link while keeping every gate',async()=>{
 const linked=await fullLink(await fullClaim());
 await pool.query("UPDATE imports SET status='source-review' WHERE id=$1",[linked.import_id]);
 const review=await syncDiscoveryImport(pool,linked.id);assert.equal(review.status,'needs-review');assert.equal(review.outputs.book.status,'identity-review');
 await assert.rejects(()=>applyImportDecision(pool,{id:linked.import_id,expectedStatus:'source-review',action:'retry',actor:reader.id}),{status:403});
 assert.equal((await syncDiscoveryImport(pool,linked.id)).revision,review.revision,'review is not bypassed before owner decision');
 await applyImportDecision(pool,{id:linked.import_id,expectedStatus:'source-review',action:'retry',actor:owner.id});
 await syncDiscoveryImports(pool);const resumed=await getDiscoveryRequest(pool,owner,linked.id);
 assert.equal(resumed.status,'acquiring');assert.equal(resumed.outputs.book.status,'acquiring');assert.equal(resumed.import_id,linked.import_id);
 assert.equal(await count('imports'),1);assert.equal(await count('discovery_requests'),1);assert.equal(await count('ranobe_feed_requests'),1);
 const attempt=await claimImport(pool);assert.equal(attempt.id,linked.import_id);assert.equal((await syncDiscoveryImport(pool,linked.id)).status,'acquiring');
});
test('shared full imports require feed-request provenance; cancelling a subscriber detaches only that discovery',async()=>{
 const first=await fullLink(await fullClaim(owner)),secondClaim=await fullClaim(trusted);
 await assert.rejects(()=>withDiscoveryAcquisition(pool,secondClaim,async()=>first.import_id),{code:'DISCOVERY_IMPORT'});assert.equal((await getDiscoveryRequest(pool,trusted,secondClaim.id)).import_id,null);
 const second=await fullLink(secondClaim);assert.equal(second.import_id,first.import_id);assert.equal((await pool.query('SELECT requested_by FROM imports WHERE id=$1',[first.import_id])).rows[0].requested_by,owner.id);assert.equal(await count('imports'),1);assert.equal(await count('ranobe_feed_requests'),2);
 const detached=await decideDiscoveryRequest(pool,trusted,{id:second.id,action:'cancel',expectedRevision:second.revision});assert.equal(detached.status,'cancelled');assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[first.import_id])).rows[0].status,'queued');assert.equal((await getDiscoveryRequest(pool,owner,first.id)).status,'acquiring');assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='discovery.import-detached'")).rows[0].n,1);
});
test('full completion exposes every sealed part and unknown-language translation remains pending; outputs stay bounded',async()=>{
 const linked=await fullLink(await fullClaim(owner)),shared=await fullLink(await fullClaim(trusted)),c=await pool.connect();let ids,runId,feedId;
 await pool.query("UPDATE imports SET status='source-review' WHERE id=$1",[linked.import_id]);
 for(const request of [linked,shared])assert.equal((await syncDiscoveryImport(pool,request.id)).status,'needs-review');
 await applyImportDecision(pool,{id:linked.import_id,expectedStatus:'source-review',action:'retry',actor:owner.id});
 try{await c.query('BEGIN');const imported=(await c.query('SELECT * FROM imports WHERE id=$1',[linked.import_id])).rows[0];feedId=imported.options.feedId;runId=randomUUID();await c.query('INSERT INTO ranobe_runs(id,feed_id,import_id,inventory_sha256,chapter_count,policy_version) VALUES($1,$2,$3,$4,2,$5)',[runId,feedId,linked.import_id,'a'.repeat(64),'synthetic-sync-fixture']);ids=[];
  for(let i=0;i<2;i++){const child=await insertImport(c,{id:randomUUID(),requested_by:owner.id,approved_by:owner.id,decision_reason:'role-auto-approval'}),bookId=await seedBook(c,child,owner.id,'und'),book=(await c.query('SELECT package_sha256 FROM books WHERE id=$1',[bookId])).rows[0];ids.push(bookId);await c.query("INSERT INTO ranobe_run_parts(id,run_id,ordinal,keys_sha256,source_keys,import_id,book_id,package_sha256,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready')",[randomUUID(),runId,i,String(i+1).repeat(64),JSON.stringify(['chapter-'+i]),child,bookId,book.package_sha256]);}
  await c.query("UPDATE ranobe_runs SET status='ready',activated_at=now() WHERE id=$1",[runId]);await c.query('UPDATE ranobe_feeds SET head_run_id=$1,active_import_id=NULL WHERE id=$2',[runId,feedId]);await c.query("UPDATE imports SET status='completed',book_id=$1,report=$2 WHERE id=$3",[ids[0],JSON.stringify({feedId,runId:'untrusted-report-value'}),linked.import_id]);await c.query('UPDATE ranobe_feed_requests SET result_run_id=$1 WHERE import_id=$2',[runId,linked.import_id]);await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 for(const request of [linked,shared]){const ready=await syncDiscoveryImport(pool,request.id);assert.equal(ready.status,'book-ready');assert.equal(ready.outputs.book.multipart,true);assert.equal(ready.outputs.book.publicationId,undefined);assert.deepEqual(ready.outputs.book.publicationIds,ids);assert.equal(ready.outputs.book.feedId,feedId);assert.equal(ready.outputs.book.snapshotId,runId);assert.equal(ready.outputs.translation.status,'pending-provider');assert.equal((await syncDiscoveryImport(pool,request.id)).revision,ready.revision);}
 const unchanged=await fullLink(await fullClaim(owner));assert.notEqual(unchanged.import_id,linked.import_id);await pool.query("UPDATE imports SET status='completed',security_state='passed',book_id=$1,report=$2 WHERE id=$3",[ids[0],JSON.stringify({runId:randomUUID()}),unchanged.import_id]);await pool.query('UPDATE ranobe_feed_requests SET result_run_id=$1 WHERE import_id=$2',[runId,unchanged.import_id]);const reused=await syncDiscoveryImport(pool,unchanged.id);assert.equal(reused.status,'book-ready');assert.equal(reused.outputs.book.snapshotId,runId);assert.deepEqual(reused.outputs.book.publicationIds,ids);assert.notEqual((await pool.query('SELECT import_id FROM ranobe_runs WHERE id=$1',[runId])).rows[0].import_id,unchanged.import_id);
 const row=await getDiscoveryRequest(pool,owner,linked.id),large={...row.outputs,book:{...row.outputs.book,publicationIds:Array.from({length:400},(_,i)=>ids[i%2])}};assert.ok(Buffer.byteLength(JSON.stringify(large))>8192);await pool.query('UPDATE discovery_requests SET outputs=$1 WHERE id=$2',[JSON.stringify(large),linked.id]);await assert.rejects(()=>pool.query('UPDATE discovery_requests SET outputs=$1 WHERE id=$2',[JSON.stringify({...large,extra:'x'.repeat(1048576)}),linked.id]),/outputs_check/);await assert.rejects(()=>pool.query('UPDATE discovery_requests SET outputs=$1 WHERE id=$2',[JSON.stringify({book:{status:'pending'},extra:'x'.repeat(9000)}),linked.id]),/outputs_check/);await assert.rejects(()=>pool.query('UPDATE discovery_requests SET outputs=$1 WHERE id=$2',[JSON.stringify({extra:'x'.repeat(9000)}),linked.id]),/outputs_check/);
});

test('active request reuse ignores letter case but preserves profile, options and punctuation distinctions',async()=>{
 const first=await createDiscoveryRequest(pool,owner,input('Свидание с Рамой'));
 const again=await createDiscoveryRequest(pool,owner,input('  СВИДАНИЕ   С РАМОЙ  '));assert.equal(again.request.id,first.request.id);assert.equal(again.reused,true);
 const changed=await createDiscoveryRequest(pool,owner,input('Свидание с Рамой',{allowOriginal:true}));assert.notEqual(changed.request.id,first.request.id);
 const a=await createDiscoveryRequest(pool,owner,input('C++ stories')),b=await createDiscoveryRequest(pool,owner,input('C# stories'));assert.notEqual(a.request.id,b.request.id);
});

test('transient retry deadlines survive a new claim, are bounded and fence every prior attempt',async()=>{
 await createDiscoveryRequest(pool,owner,input());let claim=await claimDiscoveryRequest(pool);
 for(const [index,seconds] of [5,30,120].entries()){
  const failed=await failDiscoveryRequest(pool,claim,Object.assign(new Error('Synthetic temporary source outage'),{code:'SOURCE_UNAVAILABLE'}));assert.equal(failed.status,'queued');assert.equal(failed.retry_count,index+1);assert.ok(failed.next_attempt_at instanceof Date);assert.ok(failed.next_attempt_at-Date.now()>=(seconds-1)*1000);assert.equal(await claimDiscoveryRequest(pool),null);
  const persisted=await getDiscoveryRequest(pool,owner,claim.id);assert.equal(persisted.next_attempt_at.getTime(),failed.next_attempt_at.getTime());assert.equal(persisted.retry_count,index+1);
  await pool.query("UPDATE discovery_requests SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[claim.id]);const next=await claimDiscoveryRequest(pool);assert.notEqual(next.attempt_token,claim.attempt_token);assert.equal(next.next_attempt_at,null);assert.equal((await failDiscoveryRequest(pool,claim,new Error('stale source result'))).stale,true);claim=next;
 }
 const terminal=await failDiscoveryRequest(pool,claim,Object.assign(new Error('Still unavailable'),{code:'FETCH_HTTP',httpStatus:503}));assert.equal(terminal.status,'error');assert.equal(terminal.retry_count,3);assert.equal(terminal.next_attempt_at,null);assert.equal(await claimDiscoveryRequest(pool),null);
 const retry=await decideDiscoveryRequest(pool,owner,{id:terminal.id,action:'retry',expectedRevision:terminal.revision});assert.equal(retry.status,'queued');assert.equal(retry.retry_count,0);assert.equal(retry.next_attempt_at,null);assert.equal(retry.attempt_token,null);assert.ok(await claimDiscoveryRequest(pool));
});

test('permission failures, unsafe URLs and permanent HTTP denials never auto-retry',async()=>{
 for(const failure of [{code:'FETCH_HTTP',httpStatus:403},{code:'FETCH_HTTP',httpStatus:404},{code:'FETCH_SSRF'},{code:'DISCOVERY_NEEDS_REVIEW'},{code:'UNRECOGNIZED'}]){
  await createDiscoveryRequest(pool,owner,input('Permanent '+randomUUID()));const claim=await claimDiscoveryRequest(pool),failed=await failDiscoveryRequest(pool,claim,failure);assert.equal(failed.status,'error');assert.equal(failed.retry_count,0);assert.equal(failed.next_attempt_at,null);
 }
 await createDiscoveryRequest(pool,trusted,input('Role retry'));const claim=await claimDiscoveryRequest(pool);await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[trusted.id]);const pending=await failDiscoveryRequest(pool,claim,{code:'DISCOVERY_APPROVAL_REQUIRED'});assert.equal(pending.status,'pending-approval');assert.equal(pending.next_attempt_at,null);assert.equal(pending.approved_by,null);
});

test('approval after acquisition-role revocation resumes the exact persisted choice instead of repeating discovery',async()=>{
 const claim=await selectedRequest(trusted),candidateId=claim.selected_candidate_id;await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[trusted.id]);await assert.rejects(()=>withDiscoveryAcquisition(pool,claim,insertImport),{code:'DISCOVERY_APPROVAL_REQUIRED'});
 const pending=await failDiscoveryRequest(pool,claim,{code:'DISCOVERY_APPROVAL_REQUIRED'});assert.equal(pending.status,'pending-approval');const approved=await decideDiscoveryRequest(pool,owner,{id:pending.id,action:'approve',expectedRevision:pending.revision});assert.equal(approved.status,'selected');assert.equal(approved.selected_candidate_id,candidateId);const resumed=await claimDiscoveryRequest(pool);assert.equal(resumed.phase,'acquisition');assert.equal(resumed.selected_candidate_id,candidateId);assert.equal(resumed.plan_revision,claim.plan_revision);assert.equal((await withDiscoveryAcquisition(pool,resumed,insertImport)).status,'acquiring');
});

test('refinement clears obsolete plans, is revision-bound and requires new approval after reader changes the query',async()=>{
 const value=input('All books by Synthetic Author',{audio:false,allowOriginal:true}),created=await createDiscoveryRequest(pool,reader,value);
 const approved=await decideDiscoveryRequest(pool,owner,{id:created.request.id,action:'approve',expectedRevision:1}),claim=await claimDiscoveryRequest(pool),review=await finishDiscoveryRequest(pool,claim,plan(candidate({availability:'metadata-only',eligibleForAcquisition:false}),{status:'needs_clarification',selectedCandidateId:null,nextAction:'none'}));assert.equal(approved.approved_by,owner.id);
 await assert.rejects(()=>decideDiscoveryRequest(pool,reader,{id:review.id,action:'refine',expectedRevision:review.revision-1,query:'Synthetic corrected author',intent:'author'}),{code:'DISCOVERY_CONFLICT'});
 await assert.rejects(()=>decideDiscoveryRequest(pool,reader,{id:review.id,action:'refine',expectedRevision:review.revision,query:'https://unreviewed.example/file.epub'}),{status:400});
 const refined=await decideDiscoveryRequest(pool,reader,{id:review.id,action:'refine',expectedRevision:review.revision,query:'Synthetic corrected author',intent:'author'});assert.equal(refined.status,'pending-approval');assert.equal(refined.plan,null);assert.equal(refined.plan_revision,0);assert.equal(refined.selected_candidate_id,null);assert.equal(refined.phase,null);assert.equal(refined.approved_by,null);assert.equal(refined.input.audio,false);assert.equal(refined.input.allowOriginal,true);assert.equal(refined.input.intent,'author');assert.equal(refined.query_text,'Synthetic corrected author');assert.equal(refined.input.query,refined.query_text);assert.equal(await claimDiscoveryRequest(pool),null);
 const replay=await createDiscoveryRequest(pool,reader,value);assert.equal(replay.idempotent,true);assert.equal(replay.request.id,refined.id);assert.equal(replay.request.query_text,refined.query_text);assert.equal((await pool.query("SELECT details->'previousInput'->>'query' AS query FROM audit WHERE action='discovery.refine'")).rows[0].query,value.query);
 const ownerRefined=await decideDiscoveryRequest(pool,owner,{id:refined.id,action:'approve',expectedRevision:refined.revision});assert.equal(ownerRefined.status,'queued');
});

test('retry/refine cannot bypass a linked import review or active request quota',async()=>{
 const claim=await selectedRequest(),linked=await withDiscoveryAcquisition(pool,claim,insertImport);await pool.query("UPDATE imports SET status='source-review' WHERE id=$1",[linked.import_id]);const review=await syncDiscoveryImport(pool,linked.id);
 for(const action of ['retry','refine'])await assert.rejects(()=>decideDiscoveryRequest(pool,owner,{id:review.id,action,expectedRevision:review.revision,...(action==='refine'?{query:'Different title'}:{})}),{code:'DISCOVERY_RESTART_REQUIRED'});assert.equal(await count('imports'),1);
 await createDiscoveryRequest(pool,owner,input('Failed quota request'));const pending=await claimDiscoveryRequest(pool),failed=await failDiscoveryRequest(pool,pending,new Error('Fixture terminal error'));
 for(let n=0;n<4;n++)await createDiscoveryRequest(pool,owner,input('Active quota '+n));
 await assert.rejects(()=>decideDiscoveryRequest(pool,owner,{id:failed.id,action:'retry',expectedRevision:failed.revision}),{code:'DISCOVERY_QUOTA'});
});

test('selected OpenLibrary works expand by fixed identity, while blocked/attempted metadata requires refinement',async()=>{
 for(const [candidateExtra,expected] of [[{},'queued'],[{sourceResolutionAttempted:true},'needs-review'],[{blockedReason:'SOURCE_REVIEW'},'needs-review'],[{conflictingMetadata:true},'needs-review']]){
  const c=candidate({identity:{provider:'openlibrary',remoteId:'OL123W'},availability:'metadata-only',eligibleForAcquisition:false,downloadSelections:[],...candidateExtra});c.id=metadataId(c);await createDiscoveryRequest(pool,owner,input('Work expansion '+randomUUID()));const claim=await claimDiscoveryRequest(pool),review=await finishDiscoveryRequest(pool,claim,plan(c,{status:'needs_clarification',selectedCandidateId:null,nextAction:'none'}));const chosen=await decideDiscoveryRequest(pool,owner,{id:review.id,action:'select',expectedRevision:review.revision,planRevision:review.plan_revision,candidateId:c.id});assert.equal(chosen.status,expected);await decideDiscoveryRequest(pool,owner,{id:chosen.id,action:'cancel',expectedRevision:chosen.revision});
 }
});

test('real provider metadata candidates can resolve an unknown/original language without authorizing a file acquisition',async()=>{
 const cases=[
  {query:'автор Synthetic Author',authors:[{key:'OL123A',name:'Synthetic Author'}],provider:'openlibrary',kind:'author',reason:'SOURCE_LANGUAGE_UNKNOWN'},
  {query:'Коты-воители',provider:'curated',kind:'book',reason:'SOURCE_LANGUAGE_UNKNOWN'},
  {query:'Unknown Metadata Book',open:[{key:'/works/OL123W',title:'Unknown Metadata Book',author_name:['Synthetic Author'],author_key:['OL123A'],language:[]}],provider:'openlibrary',kind:'book',reason:'SOURCE_LANGUAGE_UNKNOWN'},
  {query:'Original Metadata Book',open:[{key:'/works/OL124W',title:'Original Metadata Book',author_name:['Synthetic Author'],author_key:['OL123A'],language:['eng']}],provider:'openlibrary',kind:'book',reason:'ORIGINAL_NOT_ALLOWED'},
  {query:'Synthetic Source Card',ranobe:[{slug_url:'123--synthetic-source-card',name:'Synthetic Source Card',rus_name:'Synthetic Source Card'}],provider:'ranobelib',kind:'book',reason:'SOURCE_LANGUAGE_UNKNOWN'}
 ];
 for(const fixture of cases){
  let now=0;const search=createDiscoverySearch({clock:()=>now,sleep:async ms=>{now+=ms;},fetchSafe:async url=>{
   const parsed=new URL(url),value=parsed.pathname==='/search/authors.json'?{docs:fixture.authors??[],numFound:fixture.authors?.length??0}:parsed.pathname==='/search.json'?{docs:fixture.open??[],numFound:fixture.open?.length??0}:parsed.hostname==='gutendex.com'?{results:[],count:0,next:null}:{data:fixture.ranobe??[]};return {buffer:Buffer.from(JSON.stringify(value)),type:'application/json',url};
  }}),result=await search(fixture.query),c=result.candidates.find(item=>item.kind===fixture.kind&&item.identity.provider===fixture.provider);assert.ok(c,fixture.query);assert.equal(c.blockedReason,fixture.reason);assert.equal(c.eligibleForAcquisition,false);assert.deepEqual(c.downloadSelections,[]);
  await createDiscoveryRequest(pool,owner,input(fixture.query));const claim=await claimDiscoveryRequest(pool),review=await finishDiscoveryRequest(pool,claim,result);assert.equal(review.status,'needs-review');const chosen=await decideDiscoveryRequest(pool,owner,{id:review.id,action:'select',expectedRevision:review.revision,planRevision:review.plan_revision,candidateId:c.id});assert.equal(chosen.status,'queued',fixture.query);const expansion=await claimDiscoveryRequest(pool);assert.equal(expansion.phase,'discovery');assert.equal(expansion.selected_candidate_id,c.id);await failDiscoveryRequest(pool,expansion,new Error('Synthetic metadata expansion ended'));assert.equal(await count('imports'),0);
 }
});

test('truncated identity metadata cannot become an automatic or manual acquisition',async()=>{
 const c=candidate({identityEvidenceIncomplete:true});await createDiscoveryRequest(pool,owner,input('Truncated source metadata'));const claim=await claimDiscoveryRequest(pool),review=await finishDiscoveryRequest(pool,claim,plan(c));assert.equal(review.status,'needs-review');const selected=await decideDiscoveryRequest(pool,owner,{id:review.id,action:'select',expectedRevision:review.revision,planRevision:review.plan_revision,candidateId:c.id});assert.equal(selected.status,'needs-review');assert.equal(await claimDiscoveryRequest(pool),null);assert.equal(await count('imports'),0);
});

test('more queues only a stored bounded continuation, survives interruption and excludes client offsets',async()=>{
 const author=candidate({kind:'author',identity:{provider:'openlibrary',remoteId:'OL123A'}});author.id=metadataId(author);
 await createDiscoveryRequest(pool,owner,input('All books by Synthetic Author'));const claim=await claimDiscoveryRequest(pool),review=await finishDiscoveryRequest(pool,claim,plan(candidate(),{status:'needs_clarification',selectedCandidateId:null,nextAction:'none',hasMore:true,plan:{kind:'author',authorCandidateId:author.id,title:'Synthetic Author',continuation:{provider:'openlibrary',kind:'author-works',remoteId:'OL123A',offset:19}}}));
 await assert.rejects(()=>decideDiscoveryRequest(pool,owner,{id:review.id,action:'more',expectedRevision:review.revision,offset:999}),{status:400});await assert.rejects(()=>decideDiscoveryRequest(pool,owner,{id:review.id,action:'more',expectedRevision:review.revision,planRevision:0}),{code:'DISCOVERY_CONTINUATION'});
 const next=await decideDiscoveryRequest(pool,owner,{id:review.id,action:'more',expectedRevision:review.revision,planRevision:review.plan_revision});assert.equal(next.status,'queued');assert.equal(next.plan.continuationRequested,true);assert.equal(next.selected_candidate_id,null);assert.equal(next.plan.selectedCandidateId,null);assert.equal(next.plan.plan.continuation.offset,19);assert.equal(next.plan_revision,review.plan_revision+1);
 await assert.rejects(()=>decideDiscoveryRequest(pool,owner,{id:review.id,action:'more',expectedRevision:review.revision}),{code:'DISCOVERY_CONFLICT'});
 const running=await claimDiscoveryRequest(pool);assert.equal(running.phase,'discovery');assert.equal(running.plan.continuationRequested,true);const paused=await failDiscoveryRequest(pool,running,{code:'WORKER_STOPPING'});assert.equal(paused.status,'queued');const resumed=await claimDiscoveryRequest(pool);assert.equal(resumed.plan.plan.continuation.offset,19);
 const completed=await finishDiscoveryRequest(pool,resumed,plan(candidate({id:'dsc_'+'2'.repeat(32)}),{status:'needs_clarification',selectedCandidateId:null,nextAction:'none',hasMore:false,plan:{kind:'author',authorCandidateId:author.id,title:'Synthetic Author'}}));assert.equal(completed.plan.continuationRequested,undefined);assert.equal(completed.plan.plan.continuation,undefined);await assert.rejects(()=>decideDiscoveryRequest(pool,owner,{id:completed.id,action:'more',expectedRevision:completed.revision}),{code:'DISCOVERY_CONTINUATION'});assert.equal(await count('imports'),0);
});

test('more rejects malformed/provider-mismatched continuations and rechecks actual approval',async()=>{
 const author=candidate({kind:'author',identity:{provider:'openlibrary',remoteId:'OL123A'}});author.id=metadataId(author);
 for(const continuation of [{provider:'openlibrary',kind:'author-works',remoteId:'OL123A',offset:10001},{provider:'openlibrary',kind:'author-works',remoteId:'OL999A',offset:19},{provider:'openlibrary',kind:'author-works',remoteId:'OL123A',offset:19,url:'https://unreviewed.example/next'},{provider:'openlibrary',kind:'series-search',term:'Different Series',offset:19}]){
  await createDiscoveryRequest(pool,owner,input('Invalid continuation '+randomUUID()));const claim=await claimDiscoveryRequest(pool),review=await finishDiscoveryRequest(pool,claim,plan(candidate(),{status:'needs_clarification',selectedCandidateId:null,nextAction:'none',plan:{kind:'author',authorCandidateId:author.id,continuation}}));await assert.rejects(()=>decideDiscoveryRequest(pool,owner,{id:review.id,action:'more',expectedRevision:review.revision}),{code:'DISCOVERY_CONTINUATION'});await decideDiscoveryRequest(pool,owner,{id:review.id,action:'cancel',expectedRevision:review.revision});
 }
 await createDiscoveryRequest(pool,trusted,input('Continuation role'));const claim=await claimDiscoveryRequest(pool),review=await finishDiscoveryRequest(pool,claim,plan(candidate(),{status:'needs_clarification',selectedCandidateId:null,nextAction:'none',plan:{kind:'author',authorCandidateId:author.id,continuation:{provider:'openlibrary',kind:'author-works',remoteId:'OL123A',offset:19}}}));await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[trusted.id]);await assert.rejects(()=>decideDiscoveryRequest(pool,trusted,{id:review.id,action:'more',expectedRevision:review.revision}),{code:'DISCOVERY_APPROVAL_REQUIRED'});assert.equal((await getDiscoveryRequest(pool,trusted,review.id)).status,'needs-review');
});

function exactSourceCandidate(extra={}){
 const expected={provider:'gutenberg',remoteId:'11',title:'Synthetic book',authors:['Synthetic Author'],language:'en',languages:['en']};
 const download={url:'https://gutenberg.pglaf.org/cache/epub/11/pg11-images.epub',originalUrl:'https://www.gutenberg.org/cache/epub/11/pg11-images.epub',mimeType:'application/epub+zip',extension:'epub',maxRedirects:0,requiresQuarantine:true,expected};
 return candidate({authors:[{name:'Synthetic Author'}],sourceBinding:{provider:'gutenberg',remoteId:'11',copyright:false},downloadSelections:[download],...extra});
}
async function exactSourceClaim(profile=owner,c=exactSourceCandidate()){
 await createDiscoveryRequest(pool,profile,input('Exact source '+randomUUID()));const metadata=await claimDiscoveryRequest(pool);assert.equal(metadata.requested_by,profile.id);await finishDiscoveryRequest(pool,metadata,plan(c));return claimDiscoveryRequest(pool);
}
async function insertSourceImport(client,row){
 const c=row.plan.candidates.find(item=>item.id===row.selected_candidate_id),selection=c.downloadSelections[0],importId=randomUUID();
 const options={discovery:{requestId:row.id,expected:selection.expected,download:{url:selection.url,originalUrl:selection.originalUrl,mimeType:selection.mimeType,maxRedirects:0}}};
 await client.query("INSERT INTO imports(id,requested_by,kind,filename,source_url,status,approved_by,decision_reason,options) VALUES($1,$2,'file',$3,$4,'queued',$5,$6,$7)",[importId,row.requested_by,'gutenberg-'+c.identity.remoteId+'.'+selection.extension,selection.url,row.approved_by,row.decision_reason,JSON.stringify(options)]);return importId;
}

test('exact-source concurrent acquisitions share one import across profiles and subscriber cancellation detaches',async()=>{
 const c=exactSourceCandidate(),first=await exactSourceClaim(owner,c),second=await exactSourceClaim(trusted,c),results=await Promise.all([first,second].map(claim=>withDiscoverySourceAcquisition(pool,claim,c.downloadSelections[0],insertSourceImport)));
 assert.equal(results[0].import_id,results[1].import_id);assert.equal(await count('imports'),1);assert.equal(results[0].acquisition_key,results[1].acquisition_key);assert.match(results[0].acquisition_key,/^[a-f0-9]{64}$/);assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='discovery.source-shared'")).rows[0].n,1);
 const peer={id:randomUUID()};await pool.query("INSERT INTO profiles(id,login,password,role) VALUES($1,$2,'fixture','trusted-import')",[peer.id,'source-subscriber-'+peer.id]);const subscriber=await withDiscoverySourceAcquisition(pool,await exactSourceClaim(peer,c),c.downloadSelections[0],insertSourceImport);assert.equal(subscriber.import_id,results[0].import_id);
 await decideDiscoveryRequest(pool,peer,{id:subscriber.id,action:'cancel',expectedRevision:subscriber.revision});assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[subscriber.import_id])).rows[0].status,'queued');assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='discovery.import-detached'")).rows[0].n,1);
 assert.deepEqual(new Set(results.map(row=>row.requested_by)),new Set([owner.id,trusted.id]));
});

test('source sharing is exact: changed metadata/format and foreign imports cannot be attached',async()=>{
 const c=exactSourceCandidate(),first=await exactSourceClaim(owner,c),linked=await withDiscoverySourceAcquisition(pool,first,c.downloadSelections[0],insertSourceImport),second=await exactSourceClaim(trusted,c),selection=c.downloadSelections[0];
 await assert.rejects(()=>withDiscoverySourceAcquisition(pool,second,{...selection,expected:{...selection.expected,title:'Unpersisted title'}},insertSourceImport),{code:'DISCOVERY_SELECTION'});assert.equal((await getDiscoveryRequest(pool,trusted,second.id)).acquisition_key,null);
 await assert.rejects(()=>withDiscoveryAcquisition(pool,second,async()=>linked.import_id),{code:'DISCOVERY_IMPORT'});
 const different=exactSourceCandidate({title:'Different metadata'});different.downloadSelections[0].expected.title='Different metadata';const third=await exactSourceClaim(owner,different);await withDiscoverySourceAcquisition(pool,third,different.downloadSelections[0],insertSourceImport);assert.equal(await count('imports'),2);
 await withDiscoverySourceAcquisition(pool,second,selection,insertSourceImport);assert.equal(await count('imports'),2);
 const malformed=await exactSourceClaim(owner,exactSourceCandidate({identity:{provider:'gutendex',remoteId:'12'},sourceBinding:{provider:'gutenberg',remoteId:'12',copyright:false}}));await assert.rejects(()=>withDiscoverySourceAcquisition(pool,malformed,selection,insertSourceImport),{code:'DISCOVERY_SELECTION'});
});

test('source import creation and source key roll back when provenance or audit validation fails',async()=>{
 const c=exactSourceCandidate(),claim=await exactSourceClaim(owner,c);
 await assert.rejects(()=>withDiscoverySourceAcquisition(pool,claim,c.downloadSelections[0],insertImport),{code:'DISCOVERY_IMPORT'});assert.equal(await count('imports'),0);assert.equal((await getDiscoveryRequest(pool,owner,claim.id)).acquisition_key,null);
 await pool.query("CREATE FUNCTION fail_source_link_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='discovery.import-linked' THEN RAISE EXCEPTION 'synthetic source audit failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER fail_source_link BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION fail_source_link_audit()");
 try{await assert.rejects(()=>withDiscoverySourceAcquisition(pool,claim,c.downloadSelections[0],insertSourceImport),/synthetic source audit failure/);assert.equal(await count('imports'),0);assert.equal((await getDiscoveryRequest(pool,owner,claim.id)).acquisition_key,null);}finally{await pool.query('DROP TRIGGER fail_source_link ON audit;DROP FUNCTION fail_source_link_audit()');}
});

test('completed-source race reuse needs exact persisted proof, passed seal and actual package verification',async()=>{
 const c=exactSourceCandidate(),first=await exactSourceClaim(owner,c),linked=await withDiscoverySourceAcquisition(pool,first,c.downloadSelections[0],insertSourceImport),client=await pool.connect();let bookId;
 try{await client.query('BEGIN');bookId=await seedBook(client,linked.import_id,owner.id,'en');await client.query("UPDATE imports SET status='completed',book_id=$1,report=$2 WHERE id=$3",[bookId,JSON.stringify({sha256:'a'.repeat(64),identityVerification:{verified:true,inputSha256:'a'.repeat(64)}}),linked.import_id]);await client.query('COMMIT');}catch(failure){await client.query('ROLLBACK');throw failure;}finally{client.release();}
 const second=await exactSourceClaim(trusted,c);let verified=0,created=0;
 const ready=await withDiscoverySourceAcquisition(pool,second,c.downloadSelections[0],async()=>{created++;throw Error('Should reuse the verified source');},{verifyExisting:async book=>{assert.equal(book.id,bookId);verified++;}});assert.equal(ready.status,'book-ready');assert.equal(ready.import_id,null);assert.equal(ready.outputs.book.publicationId,bookId);assert.equal(ready.outputs.translation.status,'pending-provider');assert.equal(verified,1);assert.equal(created,0);assert.equal(await count('imports'),1);assert.equal((await pool.query("SELECT actor FROM audit WHERE action='discovery.source-reused'")).rows[0].actor,trusted.id);
 const third=await exactSourceClaim(owner,c);await pool.query("UPDATE imports SET report=$1 WHERE id=$2",[JSON.stringify({sha256:'a'.repeat(64),identityVerification:{verified:true,inputSha256:'b'.repeat(64)}}),linked.import_id]);const newLink=await withDiscoverySourceAcquisition(pool,third,c.downloadSelections[0],insertSourceImport,{verifyExisting:async()=>{throw Error('Invalid hash proof must not reuse');}});assert.equal(newLink.status,'acquiring');assert.notEqual(newLink.import_id,linked.import_id);assert.equal(await count('imports'),2);
});

test('a revoked subscriber receives the legitimate shared result informationally but cannot start new automatic work',async()=>{
 const c=exactSourceCandidate(),first=await withDiscoverySourceAcquisition(pool,await exactSourceClaim(owner,c),c.downloadSelections[0],insertSourceImport),second=await withDiscoverySourceAcquisition(pool,await exactSourceClaim(trusted,c),c.downloadSelections[0],insertSourceImport);assert.equal(first.import_id,second.import_id);await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[trusted.id]);
 const client=await pool.connect();let bookId;try{await client.query('BEGIN');bookId=await seedBook(client,first.import_id,owner.id);await client.query("UPDATE imports SET status='completed',book_id=$1 WHERE id=$2",[bookId,first.import_id]);await client.query('COMMIT');}catch(failure){await client.query('ROLLBACK');throw failure;}finally{client.release();}
 const ready=await syncDiscoveryImport(pool,second.id);assert.equal(ready.status,'book-ready');assert.equal(ready.outputs.book.publicationId,bookId);assert.equal(await count('imports'),1);const fresh=await createDiscoveryRequest(pool,trusted,input('Another automatic book'));assert.equal(fresh.request.status,'pending-approval');assert.equal(fresh.request.approved_by,null);assert.equal(await claimDiscoveryRequest(pool),null);
});
