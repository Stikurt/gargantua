// Real disposable PostgreSQL only. The injected verifier tests the trust
// boundary; file/hash checks are exercised separately by route acceptance.
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {assignBookModel} from '../server/work-model.mjs';
import {applyReaderMutations,readerSnapshot,readerChanges,readerConflicts,readerCursor,parseReaderCursor,withReaderTransaction,appendReaderEntityChange,compactReaderJournal,READER_LIMITS} from '../server/reader-data.mjs';
import {CATALOG_ENTITY_ID,readerMutationIdV2,normalizeReaderMutation,canonicalReaderJson} from '../server/reader-data-model.mjs';
const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(url.pathname))throw Error('Explicit isolated TEST_DATABASE_URL required; refusing production');
const schema='reader_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href,max:1,statement_timeout:15000});
const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);const pool=new pg.Pool({connectionString:scoped.href,max:12,statement_timeout:15000});let owned=false;
const owner={id:randomUUID()},reader={id:randomUUID()},other={id:randomUUID()},book=randomUUID(),device=randomUUID();
const locator=(extra={})=>({publicationId:book,publicationRevision:1,chapterId:'first',blockId:'p1',offset:0,quote:{exact:'Текст'},progression:0,...extra});
const payload=(extra={})=>({publicationId:book,publicationRevision:1,locator:locator(),...extra});
const mutation=(extra={})=>({mutationId:randomUUID(),deviceId:device,counter:1,entityType:'reading',entityId:book,baseRevision:0,operation:'upsert',payload:payload(),...extra});
const verifier={verifyPublication:async(id,loc,context)=>{assert.equal(id,book);assert.equal(context.publicationRevision,1);assert.ok(context.client);if(loc.type==='legacy'){if(loc.chapter!==0)throw Object.assign(new Error('Missing chapter'),{code:'ANCHOR_MISSING',status:400});}else if(loc.chapterId!=='first'||loc.blockId!=='p1'||loc.offset>5||loc.quote?.exact!=='Текст')throw Object.assign(new Error('Wrong real anchor'),{code:'ANCHOR_MISSING',status:400});}};
const apply=(who,input,services=verifier)=>applyReaderMutations(pool,who,{mutations:Array.isArray(input)?input:[input]},services);
const mutationV2=(extra={})=>{const input=mutation({protocolVersion:2,...extra});input.mutationId=readerMutationIdV2(reader,input.deviceId,input.counter);return input;};
const count=async(table,where='',values=[])=>Number((await pool.query(`SELECT count(*) AS n FROM ${table} ${where}`,values)).rows[0].n);
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);owned=true;await applyMigrations(pool);});
beforeEach(async()=>{
 await pool.query('TRUNCATE profiles,works RESTART IDENTITY CASCADE');
 for(const [profile,role]of [[owner,'owner'],[reader,'reader'],[other,'reader']])await pool.query('INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,$4)',[profile.id,'fixture-'+profile.id,'unused',role]);
 const imported=randomUUID();await pool.query("INSERT INTO imports(id,requested_by,kind,status) VALUES($1,$2,'file','completed')",[imported,owner.id]);
 const model=await assignBookModel(pool,{title:'Fixture',author:'Author',language:'ru',chapters:[{title:'First'}]});
 await pool.query("INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by,work_id,expression_id,edition_id) VALUES($1,'Fixture','Author','ru',1,$2,$3,$4,$5,$6,$7)",[book,'a'.repeat(64),imported,owner.id,model.work_id,model.expression_id,model.edition_id]);
});
after(async()=>{await pool.end();try{if(owned){assert.match(schema,/^reader_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}});

async function budgetMatches(){
 const actual=(await pool.query('SELECT rows,bytes FROM reader_journal_measure()')).rows[0],stored=(await pool.query('SELECT rows,bytes FROM reader_journal_budget WHERE singleton')).rows[0];
 assert.deepEqual(stored,actual);return stored;
}
async function seedAccepted({version=2,count:total=1003,entityType='reading',entityId=book,data=payload()}={}){
 const client=await pool.connect(),date='2020-01-01T00:00:00.000Z',rows=[];
 for(let counter=1;counter<=total;counter++){
  const input=normalizeReaderMutation(mutation({mutationId:version===2?readerMutationIdV2(reader,device,counter):randomUUID(),counter,baseRevision:counter-1,entityType,entityId,payload:data,...(version===2?{protocolVersion:2}:{})}));
  const canonical=canonicalReaderJson(input),entity={entityType,entityId,revision:counter,deleted:false,payload:input.payload,updatedAt:date};
  rows.push({mutation_id:input.mutationId,counter,body_sha256:createHash('sha256').update(canonical).digest('hex'),body:input,canonical_body:canonical,result:{mutationId:input.mutationId,status:'accepted',entity},entity_type:entityType,entity_id:entityId,accepted_revision:counter});
 }
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(84627193)');
  await client.query('INSERT INTO reader_profiles(profile_id,revision,min_revision) VALUES($1,$2,$2)',[reader.id,total]);
  await client.query('INSERT INTO reader_devices(profile_id,device_id,last_counter,protocol_version) VALUES($1,$2,$3,$4)',[reader.id,device,total,version]);
  await client.query('INSERT INTO reader_entities(profile_id,entity_type,entity_id,revision,payload,modern_write) VALUES($1,$2,$3,$4,$5,true)',[reader.id,entityType,entityId,total,JSON.stringify(rows[0].body.payload)]);
  await client.query(`INSERT INTO reader_mutations(profile_id,mutation_id,device_id,counter,body_sha256,body,canonical_body,result,entity_type,entity_id,accepted_revision,created_at)
   SELECT $1,r.mutation_id,$2,r.counter,r.body_sha256,r.body,r.canonical_body,r.result,r.entity_type,r.entity_id,r.accepted_revision,
    '2020-01-01T00:00:00Z'::timestamptz+(r.counter*interval '1 microsecond')
   FROM jsonb_to_recordset($3::jsonb) AS r(mutation_id uuid,counter bigint,body_sha256 text,body jsonb,canonical_body text,result jsonb,entity_type text,entity_id uuid,accepted_revision integer)`,[reader.id,device,JSON.stringify(rows)]);
  await client.query('COMMIT');return rows;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

test('empty snapshot is profile bound and missing authenticated profile fails closed',async()=>{
 const snapshot=await readerSnapshot(pool,reader);assert.deepEqual(snapshot.entities,[]);assert.equal(parseReaderCursor(reader,snapshot.cursor),0);
 await assert.rejects(()=>readerSnapshot(pool,{id:randomUUID()}),{code:'READER_PROFILE',status:404});
});
test('v2 devices keep a permanent protocol, deterministic identities and private counter snapshots',async()=>{
 const input=mutationV2();await apply(reader,input);
 assert.deepEqual((await readerSnapshot(pool,reader)).devices,[{deviceId:device,lastCounter:1,protocolVersion:2,compactedThrough:0,compactedCount:0}]);
 assert.deepEqual((await readerSnapshot(pool,other)).devices,[]);
 await assert.rejects(()=>apply(reader,mutation({counter:2,baseRevision:1})),{code:'READER_PROTOCOL'});
 await assert.rejects(()=>apply(reader,{...input,counter:2}),{code:'READER_MUTATION_ID',status:400});
 await assert.rejects(()=>apply(other,input),{code:'READER_MUTATION_ID',status:400});
 await budgetMatches();
});
test('v2 accepted GC keeps conflicts, fences old effects and preserves modern ownership',async()=>{
 const seeded=await seedAccepted(),conflict=mutationV2({counter:1004,baseRevision:0});
 const result=await apply(reader,conflict);assert.equal(result.results[0].status,'conflict');
 assert.equal(await count('reader_mutations'),1001);assert.equal(await count('reader_mutations',"WHERE result->>'status'='conflict'"),1);
 const old=seeded[0].body;await assert.rejects(()=>apply(reader,old),error=>error.code==='READER_RECEIPT_COMPACTED'&&error.consumed===true&&error.snapshotRequired===true&&error.expectedCounter===1005);
 await assert.rejects(()=>apply(reader,{...old,counter:1005}),{code:'READER_MUTATION_ID'});
 const snapshot=await readerSnapshot(pool,reader);assert.equal(snapshot.devices[0].compactedThrough,3);assert.equal(snapshot.devices[0].compactedCount,3);assert.equal(snapshot.entities[0].revision,1003);
 await assert.rejects(()=>withReaderTransaction(pool,reader,(client,id,head)=>appendReaderEntityChange(client,id,head,{entityType:'reading',entityId:book,operation:'upsert',payload:payload()},verifier)),{code:'READER_UPGRADE_REQUIRED'});
 assert.deepEqual(await apply(reader,conflict),result);await budgetMatches();
});
test('v1 compacted receipts retain permanent identity and reject another body forever',async()=>{
 const seeded=await seedAccepted({version:1});await withReaderTransaction(pool,reader,(client,id)=>compactReaderJournal(client,id));
 assert.equal(await count('reader_mutations'),1003);assert.equal(await count('reader_mutations','WHERE compacted'),3);
 const input=seeded[0].body,result=(await apply(reader,input)).results[0];assert.deepEqual(result,{mutationId:input.mutationId,status:'accepted',compacted:true,entityType:'reading',entityId:book,revision:1,snapshotRequired:true});
 await assert.rejects(()=>apply(reader,{...input,payload:payload({shelf:'finished'})}),{code:'READER_IDEMPOTENCY'});
 assert.equal((await readerSnapshot(pool,reader)).devices[0].compactedCount,0);await budgetMatches();
});
test('receipt retention also observes actual bytes for large catalog operations',async()=>{
 const data={catalogs:[{id:randomUUID(),title:'Large catalog',parent:null,items:Array.from({length:45},()=>({id:randomUUID(),scope:'device',title:'T'.repeat(200),author:'A'.repeat(200)}))}]};
 await seedAccepted({count:200,entityType:'catalog',entityId:CATALOG_ENTITY_ID,data});
 await withReaderTransaction(pool,reader,(client,id)=>compactReaderJournal(client,id));
 const full=(await pool.query("SELECT count(*) AS n,COALESCE(sum(reader_journal_row_bytes('reader_mutations',to_jsonb(t))),0) AS bytes FROM reader_mutations t WHERE NOT compacted AND result->>'status'='accepted'")).rows[0];
 assert.ok(Number(full.n)<200);assert.ok(Number(full.bytes)<=READER_LIMITS.retainedReceiptBytes);await budgetMatches();
});
test('quota defers admission until pruning, while failed writes leave reads and counters intact',async()=>{
 const input=mutationV2();await apply(reader,input);const baseline=await readerSnapshot(pool,reader),size=await budgetMatches();
 const original=(await pool.query("SELECT pg_get_functiondef('reader_journal_enforce()'::regprocedure) AS definition")).rows[0].definition;
 const constrained=original.replace('bytes > 100663296',`bytes > ${Number(size.bytes)+100}`).replace('bytes>100663296',`bytes>${Number(size.bytes)+100}`);assert.notEqual(constrained,original);
 await pool.query(constrained);
 try{
  await assert.rejects(()=>apply(reader,mutationV2({counter:2,baseRevision:1,payload:payload({shelf:'paused'})})),{code:'READER_STORAGE_FULL',status:429});
  assert.deepEqual(await readerSnapshot(pool,reader),baseline);
  assert.deepEqual((await readerSnapshot(pool,other)).entities,[]);assert.equal(await count('reader_profiles','WHERE profile_id=$1',[other.id]),0);
  assert.equal((await readerChanges(pool,reader,{cursor:readerCursor(reader,0)})).changes.length,1);
  await budgetMatches();
 }finally{await pool.query(original);}
});
test('budget accounting is UTC stable and reflects updates deletes and transaction rollback',async()=>{
 await apply(reader,mutation());const baseline=await budgetMatches();
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query("SET LOCAL TIME ZONE 'Asia/Almaty'");await client.query("UPDATE reader_devices SET updated_at='2026-10-23T16:01:02.123456Z' WHERE profile_id=$1",[reader.id]);await client.query('COMMIT');await budgetMatches();
  await client.query('BEGIN');await client.query('DELETE FROM reader_mutations WHERE profile_id=$1',[reader.id]);await client.query('ROLLBACK');await budgetMatches();
 }finally{client.release();}
 assert.equal((await pool.query('SELECT rows FROM reader_journal_budget')).rows[0].rows,baseline.rows);
});
test('deferred budget accepts a final compacted state despite a temporarily larger batch',async()=>{
 await seedAccepted({count:1000});
 await pool.query(`INSERT INTO reader_changes(profile_id,change_revision,entity_type,entity_id,record)
  SELECT $1,n,'reading',$2,jsonb_build_object('entityType','reading','entityId',$2::uuid,'revision',n,'deleted',false,'payload',$3::jsonb,'updatedAt','2020-01-01T00:00:00.000Z')
  FROM generate_series(1,5000) n`,[reader.id,book,JSON.stringify(payload())]);
 await pool.query('UPDATE reader_profiles SET revision=5000,min_revision=0 WHERE profile_id=$1',[reader.id]);await pool.query('UPDATE reader_entities SET revision=5000 WHERE profile_id=$1',[reader.id]);
 const baseline=await budgetMatches(),original=(await pool.query("SELECT pg_get_functiondef('reader_journal_enforce()'::regprocedure) AS definition")).rows[0].definition;
 const threshold=Number(baseline.bytes)+1024,constrained=original.replace('bytes > 100663296',`bytes > ${threshold}`).replace('bytes>100663296',`bytes>${threshold}`);assert.notEqual(constrained,original);await pool.query(constrained);
 await pool.query('CREATE TABLE retention_budget_peak(bytes bigint)');
 await pool.query('CREATE FUNCTION retention_budget_peak() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO retention_budget_peak(bytes) VALUES(NEW.bytes);RETURN NULL;END $$');
 await pool.query('CREATE TRIGGER retention_budget_peak AFTER UPDATE ON reader_journal_budget FOR EACH ROW EXECUTE FUNCTION retention_budget_peak()');
 try{
  const result=await apply(reader,mutationV2({counter:1001,baseRevision:5000,payload:payload({shelf:'paused'})}));assert.equal(result.results[0].status,'accepted');
  const final=await budgetMatches();assert.ok(Number(final.bytes)<=threshold);assert.ok(Number((await pool.query('SELECT max(bytes) AS n FROM retention_budget_peak')).rows[0].n)>threshold);assert.equal(await count('reader_mutations'),1000);assert.equal(await count('reader_changes'),5000);
 }finally{await pool.query('DROP TRIGGER retention_budget_peak ON reader_journal_budget');await pool.query('DROP FUNCTION retention_budget_peak()');await pool.query('DROP TABLE retention_budget_peak');await pool.query(original);}
});
test('streaming fingerprints preserve duplicate multiplicity and ignore row insertion order',async()=>{
 const client=await pool.connect();
 try{
  await client.query('CREATE TEMPORARY TABLE fingerprint_sample(value text)');
  const fingerprint=async()=>(await client.query("SELECT gargantua_table_fingerprint_v2('fingerprint_sample'::regclass) AS proof")).rows[0].proof;
  const empty=await fingerprint();assert.equal(empty.count,0);assert.equal(empty.algorithm,'sha256-sorted-fold-v2');assert.match(empty.fingerprint,/^[a-f0-9]{64}$/);
  await client.query("INSERT INTO fingerprint_sample VALUES('two'),('one'),('one')");const first=await fingerprint();assert.equal(first.count,3);
  await client.query('TRUNCATE fingerprint_sample');await client.query("INSERT INTO fingerprint_sample VALUES('one'),('two'),('one')");assert.deepEqual(await fingerprint(),first);
  await client.query("DELETE FROM fingerprint_sample WHERE ctid IN (SELECT ctid FROM fingerprint_sample WHERE value='one' LIMIT 1)");assert.notEqual((await fingerprint()).fingerprint,first.fingerprint);
  const config=(await client.query("SELECT proconfig,prosecdef FROM pg_proc WHERE oid='gargantua_table_fingerprint_v2(regclass)'::regprocedure")).rows[0];assert.equal(config.prosecdef,false);assert.ok(config.proconfig.includes('search_path=pg_catalog, public'));
 }finally{await client.query('DROP TABLE IF EXISTS fingerprint_sample');client.release();}
});
test('change feed compacts by bytes without losing the live object or cursor fence',async()=>{
 const data={catalogs:[{id:randomUUID(),title:'Large feed',parent:null,items:Array.from({length:45},()=>({id:randomUUID(),scope:'device',title:'T'.repeat(200),author:'A'.repeat(200)}))}]};
 await seedAccepted({count:1,entityType:'catalog',entityId:CATALOG_ENTITY_ID,data});
 await pool.query(`INSERT INTO reader_changes(profile_id,change_revision,entity_type,entity_id,record)
  SELECT $1,n,'catalog',$2,jsonb_build_object('entityType','catalog','entityId',$2::uuid,'revision',n,'deleted',false,'payload',$3::jsonb,'updatedAt','2020-01-01T00:00:00.000Z')
  FROM generate_series(2,501) n`,[reader.id,CATALOG_ENTITY_ID,JSON.stringify(data)]);
 await pool.query('UPDATE reader_profiles SET revision=501 WHERE profile_id=$1',[reader.id]);await pool.query('UPDATE reader_entities SET revision=501 WHERE profile_id=$1',[reader.id]);
 await apply(reader,mutationV2({counter:2,entityType:'catalog',entityId:CATALOG_ENTITY_ID,baseRevision:501,payload:data}),{});
 const head=(await pool.query('SELECT revision,min_revision FROM reader_profiles WHERE profile_id=$1',[reader.id])).rows[0];assert.equal(Number(head.revision),502);assert.ok(Number(head.min_revision)>1);
 const feed=(await pool.query("SELECT count(*) AS n,sum(reader_journal_row_bytes('reader_changes',to_jsonb(t))) AS bytes FROM reader_changes t WHERE profile_id=$1",[reader.id])).rows[0];assert.ok(Number(feed.n)<500);assert.ok(Number(feed.bytes)<=READER_LIMITS.retainedChangeBytes);
 await assert.rejects(()=>readerChanges(pool,reader,{cursor:readerCursor(reader,1)}),{code:'READER_SNAPSHOT_REQUIRED'});assert.equal((await readerSnapshot(pool,reader)).entities[0].revision,502);await budgetMatches();
});
test('compaction and device checkpoints roll back if a later operation fails',async()=>{
 await seedAccepted();await assert.rejects(()=>apply(reader,mutationV2({counter:1004,baseRevision:1003,payload:payload({locator:locator({offset:6})})})),{code:'ANCHOR_MISSING'});
 assert.equal(await count('reader_mutations'),1003);assert.equal((await readerSnapshot(pool,reader)).devices[0].compactedCount,0);await budgetMatches();
});
test('accepted receipt GC never removes a deleted bookmark or allows stale resurrection',async()=>{
 const id=randomUUID();await seedAccepted({entityType:'bookmark',entityId:id,data:payload({note:'keep my deletion'})});
 await apply(reader,mutationV2({counter:1004,entityType:'bookmark',entityId:id,baseRevision:1003,operation:'delete',payload:undefined}));
 const stale=await apply(reader,mutationV2({counter:1005,entityType:'bookmark',entityId:id,payload:payload({note:'stale offline text'})}));
 assert.equal(stale.results[0].status,'conflict');assert.equal(stale.results[0].current.deleted,true);assert.equal((await readerSnapshot(pool,reader)).entities[0].payload.note,'keep my deletion');await budgetMatches();
});
test('accepted operation and exact replay have one durable entity, counter, audit and event',async()=>{
 const input=mutation(),first=await apply(reader,input),again=await apply(reader,input);assert.deepEqual(again,first);assert.equal(first.results[0].entity.revision,1);
 for(const table of ['reader_entities','reader_devices','reader_mutations','reader_changes'])assert.equal(await count(table),1);
 assert.equal(await count('audit',"WHERE action='reader.changed'"),1);
});
test('same mutation ID with another body is rejected before checking or consuming counter',async()=>{
 const input=mutation();await apply(reader,input);await assert.rejects(()=>apply(reader,{...input,payload:payload({shelf:'finished'})}),{code:'READER_IDEMPOTENCY'});
 assert.equal((await pool.query('SELECT last_counter FROM reader_devices')).rows[0].last_counter,'1');
 assert.equal((await readerSnapshot(pool,reader)).entities[0].payload.shelf,'reading');
});
test('parallel identical retransmissions return the same receipt and one visible effect',async()=>{
 const input=mutation(),results=await Promise.all([apply(reader,input),apply(reader,input),apply(reader,input)]);
 assert.deepEqual(results[0],results[1]);assert.deepEqual(results[1],results[2]);assert.equal(await count('reader_changes'),1);
});
test('parallel devices preserve the losing position as a consumed CAS conflict',async()=>{
 const [one,two]=await Promise.all([apply(reader,mutation()),apply(reader,mutation({deviceId:randomUUID(),payload:payload({shelf:'finished'})}))]);
 assert.deepEqual([one.results[0].status,two.results[0].status].sort(),['accepted','conflict']);assert.equal(await count('reader_mutations'),2);assert.equal(await count('reader_changes'),1);
 const {conflicts}=await readerConflicts(pool,reader);assert.equal(conflicts.length,1);assert.ok(conflicts[0].proposed.payload);assert.equal(conflicts[0].current.revision,1);
 assert.deepEqual((await readerConflicts(pool,owner)).conflicts,[]);
});
test('identical entity/mutation/device IDs in another profile never share data or receipts',async()=>{
 const id=randomUUID(),shared=mutation({entityType:'bookmark',entityId:id,payload:payload({note:'private A'})});await apply(reader,shared);await apply(other,{...shared,payload:payload({note:'private B'})});
 assert.equal((await readerSnapshot(pool,reader)).entities[0].payload.note,'private A');assert.equal((await readerSnapshot(pool,other)).entities[0].payload.note,'private B');assert.deepEqual((await readerSnapshot(pool,owner)).entities,[]);
});
test('device counter gaps and reuse under a new ID do not consume anything',async()=>{
 await assert.rejects(()=>apply(reader,mutation({counter:2})),error=>error.code==='READER_COUNTER'&&error.expectedCounter===1);assert.equal(await count('reader_devices'),0);
 await apply(reader,mutation());await assert.rejects(()=>apply(reader,mutation()),error=>error.code==='READER_COUNTER'&&error.expectedCounter===2);assert.equal(await count('reader_mutations'),1);
});
test('conflict replay stays a conflict and explicit reconciliation consumes the next counter',async()=>{
 await apply(reader,mutation());const conflict=mutation({deviceId:randomUUID(),payload:payload({shelf:'paused'})}),result=await apply(reader,conflict);
 assert.equal(result.results[0].status,'conflict');assert.deepEqual(await apply(reader,conflict),result);
 const resolved=await apply(reader,{...conflict,mutationId:randomUUID(),counter:2,baseRevision:1});assert.equal(resolved.results[0].entity.revision,2);assert.equal(resolved.results[0].entity.payload.shelf,'paused');
});
test('deletion retains a tombstone; old upsert cannot silently resurrect a bookmark',async()=>{
 const id=randomUUID();await apply(reader,mutation({entityType:'bookmark',entityId:id,payload:payload({note:'recoverable'})}));
 const deleted=await apply(reader,mutation({entityType:'bookmark',entityId:id,counter:2,baseRevision:1,operation:'delete',payload:undefined}));assert.equal(deleted.results[0].entity.deleted,true);assert.equal(deleted.results[0].entity.payload.note,'recoverable');
 const stale=await apply(reader,mutation({entityType:'bookmark',entityId:id,counter:3,payload:payload({note:'stale offline'})}));assert.equal(stale.results[0].status,'conflict');assert.equal(stale.results[0].current.deleted,true);
 const restored=await apply(reader,mutation({entityType:'bookmark',entityId:id,counter:4,baseRevision:2,payload:payload({note:'explicitly restored'})}));assert.equal(restored.results[0].entity.deleted,false);assert.equal(restored.results[0].entity.revision,3);
});
test('delete-before-create creates a tombstone instead of permitting later stale resurrection',async()=>{
 const id=randomUUID(),deletion=mutation({entityType:'bookmark',entityId:id,operation:'delete',payload:undefined});const result=await apply(reader,deletion);assert.equal(result.results[0].entity.payload,null);
 const stale=await apply(reader,mutation({entityType:'bookmark',entityId:id,counter:2,payload:payload()}));assert.equal(stale.results[0].status,'conflict');
});
test('snapshot cursor and paged changes form a consistent sequence with no skipped revisions',async()=>{
 const initial=await readerSnapshot(pool,reader);await apply(reader,[mutation(),mutation({counter:2,entityType:'bookmark',entityId:randomUUID(),payload:payload({note:'mark'})})]);
 const first=await readerChanges(pool,reader,{cursor:initial.cursor,limit:1});assert.equal(first.changes.length,1);assert.equal(first.changes[0].changeRevision,1);assert.equal(first.hasMore,true);
 const second=await readerChanges(pool,reader,{cursor:first.cursor,limit:1});assert.equal(second.changes[0].changeRevision,2);assert.equal(second.hasMore,false);
 assert.equal((await readerChanges(pool,reader,{cursor:second.cursor})).changes.length,0);assert.equal(parseReaderCursor(reader,(await readerSnapshot(pool,reader)).cursor),2);
});
test('retention compaction keeps tombstones and demands snapshot for too-old cursor',async()=>{
 await apply(reader,mutation());const entity=(await readerSnapshot(pool,reader)).entities[0];
 await pool.query('DELETE FROM reader_changes WHERE profile_id=$1',[reader.id]);await pool.query('INSERT INTO reader_changes(profile_id,change_revision,entity_type,entity_id,record) SELECT $1,n,\'reading\',$2,$3 FROM generate_series(1,5000) n',[reader.id,book,JSON.stringify(entity)]);await pool.query('UPDATE reader_profiles SET revision=5000 WHERE profile_id=$1',[reader.id]);
 await apply(reader,mutation({counter:2,baseRevision:1,operation:'delete',payload:undefined}));assert.equal(await count('reader_changes'),5000);
 await assert.rejects(()=>readerChanges(pool,reader,{cursor:readerCursor(reader,0)}),{code:'READER_SNAPSHOT_REQUIRED',status:409});
 const page=await readerChanges(pool,reader,{cursor:readerCursor(reader,1),limit:1});assert.equal(page.changes[0].changeRevision,2);assert.equal((await readerSnapshot(pool,reader)).entities[0].deleted,true);
});
test('foreign or future cursors never enumerate another profile or advance the current one',async()=>{
 await assert.rejects(()=>readerChanges(pool,reader,{cursor:readerCursor(other,0)}),{code:'READER_CURSOR'});
 await assert.rejects(()=>readerChanges(pool,reader,{cursor:readerCursor(reader,1)}),{code:'READER_CURSOR'});
});
test('publication verifier failure rolls back entity, counter, receipt and feed',async()=>{
 await assert.rejects(()=>apply(reader,mutation({payload:payload({locator:locator({offset:6})})})),{code:'ANCHOR_MISSING'});
 for(const table of ['reader_entities','reader_devices','reader_mutations','reader_changes'])assert.equal(await count(table),0);
 await apply(reader,mutation());assert.equal(await count('reader_entities'),1);
});
test('security block cannot be bypassed by an owner or a permissive verifier; deletion remains possible',async()=>{
 await apply(owner,mutation());await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[book]);let called=false;
 await assert.rejects(()=>apply(owner,mutation({counter:2,baseRevision:1}),{verifyPublication:async()=>{called=true;}}),{code:'READER_PUBLICATION_BLOCKED',status:423});assert.equal(called,false);
 const result=await apply(owner,mutation({counter:2,baseRevision:1,operation:'delete',payload:undefined}));assert.equal(result.results[0].entity.deleted,true);
});
test('missing verifier fails closed while metadata-only catalog needs no book upload',async()=>{
 await assert.rejects(()=>apply(reader,mutation(),{}),{code:'READER_VERIFIER_MISSING',status:503});
 const unknown=randomUUID(),catalog=randomUUID(),result=await apply(reader,mutation({entityType:'catalog',entityId:CATALOG_ENTITY_ID,payload:{catalogs:[{id:catalog,title:'Local series',parent:null,items:[{id:unknown,scope:'device',title:'Only metadata',author:'Writer'}]}]}}),{});
 assert.equal(result.results[0].entity.payload.catalogs[0].items[0].id,unknown);assert.equal(await count('books'),1);
});
test('audit failure rolls back all mutation effects and permits a safe retry',async()=>{
 await pool.query("ALTER TABLE audit ADD CONSTRAINT reader_fixture_failure CHECK(action<>'reader.changed') NOT VALID");const input=mutation();
 try{await assert.rejects(()=>apply(reader,input),{code:'23514'});assert.equal(await count('reader_mutations'),0);assert.equal(await count('reader_entities'),0);assert.equal(await count('reader_devices'),0);}finally{await pool.query('ALTER TABLE audit DROP CONSTRAINT reader_fixture_failure');}
 assert.equal((await apply(reader,input)).results[0].status,'accepted');
});
test('batch validation or a later verifier failure never commits an earlier operation',async()=>{
 await assert.rejects(()=>apply(reader,[mutation(),mutation({counter:2,baseRevision:1,payload:payload({locator:locator({offset:6})})})]),{code:'ANCHOR_MISSING'});assert.equal(await count('reader_mutations'),0);assert.equal(await count('reader_entities'),0);
 const input=mutation(),duplicate=await apply(reader,[input,input]);assert.equal(duplicate.results.length,2);assert.deepEqual(duplicate.results[0],duplicate.results[1]);assert.equal(await count('reader_changes'),1);
});
test('live bookmark quota is atomic and an explicit deletion frees one live slot',async()=>{
 const data=JSON.stringify({...payload(),note:'fixture'});await pool.query("INSERT INTO reader_entities(profile_id,entity_type,entity_id,revision,deleted,payload) SELECT $1,'bookmark',gen_random_uuid(),1,false,$2 FROM generate_series(1,2000)",[reader.id,data]);
 const inputs=[mutation({entityType:'bookmark',entityId:randomUUID(),payload:payload()}),mutation({deviceId:randomUUID(),entityType:'bookmark',entityId:randomUUID(),payload:payload()})],attempts=await Promise.allSettled(inputs.map(input=>apply(reader,input)));
 assert.ok(attempts.every(value=>value.status==='rejected'&&value.reason.code==='READER_QUOTA'));assert.equal(await count('reader_mutations'),0);
 const row=(await pool.query("SELECT entity_id FROM reader_entities WHERE profile_id=$1 LIMIT 1",[reader.id])).rows[0];await apply(reader,mutation({entityType:'bookmark',entityId:row.entity_id,baseRevision:1,operation:'delete',payload:undefined}));
 assert.equal((await apply(reader,{...inputs[0],counter:2})).results[0].status,'accepted');assert.equal(await count('reader_entities'),2001);
});
test('legacy bridge commits the same revisions and rejects blind overwrite after modern sync',async()=>{
 const change={entityType:'reading',entityId:book,operation:'upsert',payload:payload({locator:{type:'legacy',chapter:0,position:.3}})};
 const first=await withReaderTransaction(pool,reader,(client,id,head)=>appendReaderEntityChange(client,id,head,change,verifier));assert.equal(first.entity.revision,1);assert.equal(await count('reader_mutations'),0);
 await apply(reader,mutation({baseRevision:1}));
 await assert.rejects(()=>withReaderTransaction(pool,reader,(client,id,head)=>appendReaderEntityChange(client,id,head,change,verifier)),{code:'READER_UPGRADE_REQUIRED',status:409});
 assert.equal((await readerSnapshot(pool,reader)).entities[0].revision,2);
});
test('projection hook is inside the same transaction and failure rolls back receipt/feed/counter',async()=>{
 const input=mutation(),services={...verifier,projectEntity:async(client,id,entity,prior)=>{assert.equal(id,reader.id);assert.equal(prior,null);assert.equal(entity.entityType,'reading');await client.query("INSERT INTO audit(actor,action,target) VALUES($1,'fixture.projection',$2)",[id,entity.entityId]);throw Object.assign(new Error('projection unavailable'),{code:'PROJECTION_FAILURE'});}};
 await assert.rejects(()=>apply(reader,input,services),{code:'PROJECTION_FAILURE'});
 for(const table of ['reader_entities','reader_devices','reader_mutations','reader_changes','audit'])assert.equal(await count(table),0);
 assert.equal((await apply(reader,input)).results[0].status,'accepted');
});
test('a legacy catalog baseline at revision zero is preserved and can advance by CAS',async()=>{
 const catalogPayload={catalogs:[{id:randomUUID(),title:'Baseline zero',parent:null,items:[]}]};
 await pool.query("INSERT INTO reader_entities(profile_id,entity_type,entity_id,revision,payload) VALUES($1,'catalog',$2,0,$3)",[reader.id,CATALOG_ENTITY_ID,JSON.stringify(catalogPayload)]);
 const snapshot=await readerSnapshot(pool,reader);assert.equal(snapshot.entities[0].revision,0);assert.equal(snapshot.entities[0].payload.catalogs[0].title,'Baseline zero');
 const changed=await apply(reader,mutation({entityType:'catalog',entityId:CATALOG_ENTITY_ID,payload:catalogPayload}),{});assert.equal(changed.results[0].entity.revision,1);
});
test('conflict pagination preserves PostgreSQL microseconds and UUID tie ordering',async()=>{
 await apply(reader,mutation());
 const ids=['00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000014'];
 const times=['2026-10-23 12:00:00.123456+00','2026-10-23 12:00:00.123455+00','2026-10-23 12:00:00.123455+00','2026-10-23 12:00:00.123000+00'];
 for(let index=0;index<ids.length;index++){
  await apply(reader,mutation({mutationId:ids[index],deviceId:randomUUID()}));await pool.query('UPDATE reader_mutations SET created_at=$3::timestamptz WHERE profile_id=$1 AND mutation_id=$2',[reader.id,ids[index],times[index]]);
 }
 let cursor;const found=[];
 for(let page=0;page<4;page++){
  const result=await readerConflicts(pool,reader,{limit:1,cursor});found.push(...result.conflicts.map(item=>item.mutationId));
  if(page===0)assert.equal(JSON.parse(Buffer.from(result.cursor,'base64url').toString('utf8')).createdAt,'2026-10-23 12:00:00.123456+00');
  assert.equal(result.hasMore,page<3);cursor=result.cursor;
 }
 assert.equal(cursor,null);assert.deepEqual(found,ids);
});
test('newer inserts do not shift already paged conflicts or repeat older records',async()=>{
 await apply(reader,mutation());const ids=[];
 for(let index=0;index<3;index++){
  const input=mutation({deviceId:randomUUID()});ids.push(input.mutationId);await apply(reader,input);await pool.query('UPDATE reader_mutations SET created_at=$3::timestamptz WHERE profile_id=$1 AND mutation_id=$2',[reader.id,input.mutationId,`2020-01-01 00:00:0${3-index}.000001+00`]);
 }
 const first=await readerConflicts(pool,reader,{limit:1});await apply(reader,mutation({deviceId:randomUUID()}));
 const remaining=await readerConflicts(pool,reader,{limit:100,cursor:first.cursor});assert.deepEqual([...first.conflicts,...remaining.conflicts].map(item=>item.mutationId),ids);assert.equal(remaining.hasMore,false);
 assert.equal((await readerConflicts(pool,reader)).conflicts.length,4);
});
test('conflict page cursors reject another profile, malformed calendar, unknown fields and invalid ID',async()=>{
 await apply(reader,mutation());await apply(reader,mutation({deviceId:randomUUID()}));await apply(reader,mutation({deviceId:randomUUID()}));
 const first=await readerConflicts(pool,reader,{limit:1}),data=JSON.parse(Buffer.from(first.cursor,'base64url').toString('utf8'));
 await assert.rejects(()=>readerConflicts(pool,other,{cursor:first.cursor}),{code:'READER_CURSOR',status:400});
 for(const extra of [{createdAt:'2026-02-31 00:00:00+00'},{createdAt:'2026-10-23 25:00:00+00'},{mutationId:'not-uuid'},{private:'x'},{schemaVersion:2}]){
  const cursor=Buffer.from(JSON.stringify({...data,...extra})).toString('base64url');await assert.rejects(()=>readerConflicts(pool,reader,{cursor}),{code:'READER_CURSOR',status:400});
 }
 assert.deepEqual((await readerConflicts(pool,other)).conflicts,[]);
});
test('conflict cursor format stays UTC ISO even with another database session locale',async()=>{
 await apply(reader,mutation());await apply(reader,mutation({deviceId:randomUUID()}));await apply(reader,mutation({deviceId:randomUUID()}));
 const client=await pool.connect(),borrowed={query:(...args)=>client.query(...args),release(){}};
 try{
  await client.query("SET DateStyle TO 'German, DMY'");await client.query("SET TIME ZONE 'Asia/Almaty'");
  const first=await readerConflicts({connect:async()=>borrowed},reader,{limit:1});
  const value=JSON.parse(Buffer.from(first.cursor,'base64url').toString('utf8'));assert.match(value.createdAt,/^\d{4}-\d\d-\d\d .*\+00$/);
  const second=await readerConflicts({connect:async()=>borrowed},reader,{cursor:first.cursor,limit:1});assert.equal(second.conflicts.length,1);assert.equal(second.hasMore,false);
 }finally{await client.query('RESET DateStyle');await client.query('RESET TIME ZONE');client.release();}
});
