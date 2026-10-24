// Remove only explicitly recorded synthetic demo/profile data from this run.
import fs from 'node:fs/promises';
import path from 'node:path';
import {query,pool}from'../server/db.mjs';
import {validId}from'../server/security.mjs';
try{
 if(process.env.OLD_DEMO_ID){
   const id=validId(process.env.OLD_DEMO_ID);
   const row=(await query("SELECT title FROM books WHERE id=$1",[id])).rows[0];
   if(row?.title!=='Путеводитель по тихой библиотеке')throw new Error('Отказ: это не демонстрационная книга');
   await query('DELETE FROM bookmarks WHERE book_id=$1',[id]);await query('DELETE FROM reading WHERE book_id=$1',[id]);await query('DELETE FROM books WHERE id=$1',[id]);
   const root=path.resolve(process.env.LIBRARY_DIR||'/library','books'),target=path.resolve(root,id);
   if(path.dirname(target)!==root)throw new Error('Неверный каталог');
   await fs.rm(target,{recursive:true,force:true});
 }
 // Synthetic bad inputs have distinctive filenames; erase bytes, retain reports.
 for(const row of(await query("SELECT id FROM imports WHERE status IN ('blocked','error') AND filename IN ('not-a-book.txt','unsafe.fb2','antivirus-test.txt','scanner-unavailable.txt','resource-check.txt','book.txt')")).rows){
   validId(row.id);await fs.unlink(path.join(process.env.QUARANTINE_DIR||'/quarantine','incoming',row.id)).catch(e=>{if(e.code!=='ENOENT')throw e;});
 }
}finally{await pool.end();}
