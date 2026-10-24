import {pool,migrate} from './db.mjs';
import {inspectLegacyPublication,readPublication,textForScan} from './publication-files.mjs';
import {scan,scannerVersion} from './scan.mjs';
import {sealPublicationModel} from './work-model.mjs';
import {checkedPublicationView} from './publication-model.mjs';

const root=process.env.LIBRARY_DIR||'/library';
const mode=process.argv[2];
if(!['seal-existing','verify','migrate'].includes(mode)){
 console.log('Storage maintenance: migrate | seal-existing | verify. Run after a verified backup, with import workers stopped. seal-existing scans the exact legacy bytes and adds integrity metadata; it never replaces books.');
 process.exitCode=mode?1:0;
}else try{
 await migrate();
 let verified=0,sealed=0;
 if(mode==='seal-existing'){
  // Also prevents an operator from accidentally sealing while a worker is active.
  const lock=await pool.connect();
  try{
   if(!(await lock.query('SELECT pg_try_advisory_lock(84627191) AS owned')).rows[0].owned)throw new Error('Сначала остановите обработчик импорта');
   const scanner=await scannerVersion();
   for(const row of (await pool.query("SELECT * FROM books WHERE security_state='passed' AND artifact_manifest IS NULL ORDER BY id")).rows){
    const checked=await inspectLegacyPublication(root,row);
    await scan(checked.raw);await scan(textForScan(checked.content));
    for(const [name,bytes]of checked.buffers)if(name!=='book.json')await scan(bytes);
    await scannerVersion();
    // Re-read after scanning: the scan verdict is bound to these exact hashes.
    await readPublication(root,{...row,artifact_manifest:checked.manifest,content_sha256:checked.contentSha256,content_bytes:checked.contentBytes,package_sha256:checked.packageSha256});
    await lock.query('BEGIN');
    try{
     const changed=await lock.query("UPDATE books SET artifact_manifest=$1,content_sha256=$2,content_bytes=$3,package_sha256=$4 WHERE id=$5 AND security_state='passed' AND artifact_manifest IS NULL",[JSON.stringify(checked.manifest),checked.contentSha256,checked.contentBytes,checked.packageSha256,row.id]);
     if(changed.rowCount){await lock.query("INSERT INTO audit(actor,action,target,details) VALUES(NULL,'publication.legacy-sealed',$1,$2)",[row.id,JSON.stringify({scanner,packageSha256:checked.packageSha256,policy:'prepared-v1',note:'Current legacy bytes revalidated; not a claim of original acquisition hash'})]);sealed++;}
     await lock.query('COMMIT');
    }catch(e){await lock.query('ROLLBACK').catch(()=>{});throw e;}
   }
   for(const row of (await pool.query("SELECT * FROM books WHERE security_state='passed' AND publication_manifest IS NULL ORDER BY id")).rows){
    const checked=await readPublication(root,row);
    await lock.query('BEGIN');try{await sealPublicationModel(lock,row,checked.content);await lock.query("INSERT INTO audit(actor,action,target) VALUES(NULL,'publication.model-sealed',$1)",[row.id]);await lock.query('COMMIT');}catch(e){await lock.query('ROLLBACK').catch(()=>{});throw e;}
   }
  }finally{await lock.query('SELECT pg_advisory_unlock(84627191)').catch(()=>{});lock.release();}
 }
 if(mode!=='migrate')for(const row of (await pool.query("SELECT * FROM books WHERE security_state='passed' ORDER BY id")).rows){const checked=await readPublication(root,row);checkedPublicationView(row,checked.content);verified++;}
 console.log(JSON.stringify({ok:true,mode,sealed,verified}));
}catch(e){console.error('Storage maintenance failed:',e.code||e.message);process.exitCode=1;}
finally{await pool.end();}
