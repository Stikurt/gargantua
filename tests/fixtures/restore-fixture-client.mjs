// Runs only in the opt-in isolated fixture container, never in the app/worker.
import fs from 'node:fs/promises';
import {migrate,pool} from '/app/server/db.mjs';
import {assignBookModel,sealPublicationModel} from '/app/server/work-model.mjs';
import {validateBook,packageDigest,digest,readPublication} from '/app/server/publication-files.mjs';
import {checkedPublicationView} from '/app/server/publication-model.mjs';
import {ranobeChapterFingerprint} from '/app/server/ranobe-store.mjs';

const mode=process.argv[2]||'seed';
const allowed=mode==='seed'?/^postgres:\/\/cotology_app:[a-f0-9]{32}@127\.0\.0\.1:5432\/library$/:mode==='verify'?/^postgres:\/\/postgres@127\.0\.0\.1:5432\/restore_check$/:null;
if(process.env.GARGANTUA_RESTORE_FIXTURE!=='1'||!allowed?.test(process.env.DATABASE_URL||''))throw Error('Isolated restore fixture environment required');
try{
 if(mode==='verify'){
  const client=await pool.connect();
  try{
   await client.query('BEGIN READ ONLY');
   const rows=(await client.query('SELECT * FROM books ORDER BY id')).rows;
   if(rows.length!==2)throw Error('Unexpected synthetic publication count');
   let resources=0,chapters=0;
   for(const row of rows){
    const publication=await readPublication('/fixture-library',row);
    const view=checkedPublicationView(row,publication.content);
    resources+=view.manifest.resources.length;chapters+=view.manifest.readingOrder.length;
   }
   if(resources!==1||chapters!==5)throw Error('Restored publication resources/chapters differ');
   await client.query('COMMIT');
   console.log(JSON.stringify({status:'PUBLICATIONS_VALIDATED',synthetic:true,books:rows.length,resources,chapters}));
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }else{
 await migrate();
 if(!(await pool.query("SELECT to_regclass('public.discovery_requests') IS NOT NULL AND to_regclass('public.discovery_attempts') IS NOT NULL AND to_regclass('public.discovery_idempotency') IS NOT NULL AND to_regclass('public.ranobe_scratch') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ranobe_feed_requests' AND column_name='result_run_id') AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='discovery_requests' AND column_name='acquisition_key') AS ready")).rows[0].ready)throw Error('This synthetic fixture requires a candidate image with migrations 004/005/006/007 result links and durable search');
 const expected=JSON.parse(await fs.readFile('/fixture-seed/expected.json','utf8'));
 const client=await pool.connect();
 try{
  await client.query(await fs.readFile('/fixture-seed/seed-before-books.sql','utf8'));
  await client.query('BEGIN');
  const rows=JSON.parse(await fs.readFile('/fixture-seed/books.json','utf8'));
  for(const [index,row] of rows.entries()){
   const raw=await fs.readFile(`/fixture-seed/books/${row.id}/book.json`),book=JSON.parse(raw);
   validateBook(book);
   if(digest(raw)!==row.content_sha256||packageDigest(row.artifact_manifest)!==row.package_sha256)throw Error('Synthetic publication bytes do not match their manifest');
   const source=index===0?{provider:'gutenberg',remoteId:'990001',variant:'gutenberg:990001:ru',kind:'unclassified'}:{provider:'openlibrary',remoteId:`fixture-book-${index+1}`,variant:'ru-synthetic-original',kind:'original'};
   const model=await assignBookModel(client,book,{source:{...source,label:'Synthetic restore fixture; not a real source record'}});
   const columns=[...Object.keys(row),...Object.keys(model)],values=[...Object.values(row),...Object.values(model)].map(value=>value&&typeof value==='object'?JSON.stringify(value):value);
   const inserted=(await client.query(`INSERT INTO books(${columns.join(',')}) VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,values)).rows[0];
   await sealPublicationModel(client,inserted,book);
  }
  await client.query('COMMIT');
  for(const checkpoint of expected.ranobeTables.ranobe_chapters){
   const content=checkpoint.prepared_book??JSON.parse(await fs.readFile(`/fixture-seed/books/${checkpoint.book_id}/book.json`,'utf8'));
   if(ranobeChapterFingerprint(content,checkpoint.prepared_book?0:checkpoint.chapter_index)!==checkpoint.content_sha256)throw Error('Synthetic chapter fingerprint differs from candidate implementation');
  }
  await client.query(await fs.readFile('/fixture-seed/seed-after-books.sql','utf8'));
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 console.log(JSON.stringify({status:'SEEDED',synthetic:true,books:expected.books.length,imports:expected.imports.length,attempts:expected.attempts.length,discoveryRequests:expected.discoveryRequests.length,discoveryAttempts:expected.discoveryAttempts.length,ranobeFeeds:expected.ranobeTables.ranobe_feeds.length,ranobeRuns:expected.ranobeTables.ranobe_runs.length}));
 }
}finally{await pool.end();}
