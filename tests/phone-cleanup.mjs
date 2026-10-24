// Remove only the synthetic file uploaded in the real-phone import check.
import fs from 'node:fs/promises';
import path from 'node:path';
import {query,pool} from '../server/db.mjs';
const id='c61dc861-0273-4599-9f28-6e679c75652b';
const row=(await query('SELECT b.title,b.sha256,i.filename,i.id FROM books b JOIN imports i ON i.id=b.import_id WHERE b.id=$1',[id])).rows[0];
if(row){
 if(row.title!=='Cotology-Phone-QA'||row.filename!=='Cotology-Phone-QA.txt'||row.sha256!=='d00ee497ce54570eb6b906e56338f1a850b33d18d8d85f42ccbf8862cbb3f375')throw new Error('Refusing to remove a non-test book');
 await query('DELETE FROM reading WHERE book_id=$1',[id]);
 await query('DELETE FROM bookmarks WHERE book_id=$1',[id]);
 await query('DELETE FROM books WHERE id=$1',[id]);
 const root=path.resolve(process.env.LIBRARY_DIR||'/library','books'),target=path.resolve(root,id);
 if(path.dirname(target)!==root)throw new Error('Unexpected test book path');
 await fs.rm(target,{recursive:true,force:true});
 await query('INSERT INTO audit(actor,action,target,details) VALUES(NULL,$1,$2,$3)',['qa-cleanup',id,JSON.stringify({reason:'Synthetic real-phone import check; report retained'})]);
}
await pool.end();console.log('Only the synthetic phone-import book removed; import security report retained.');
