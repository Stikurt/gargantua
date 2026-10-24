// Disposable local UI-check profile. Never run against a shared/public instance.
import{query,pool,migrate}from'../server/db.mjs';
import{passwordHash}from'../server/security.mjs';
await migrate();const id='10000000-0000-4000-8000-000000000001';
try{
 if(process.argv[2]==='create')await query("INSERT INTO profiles(id,login,password,role) VALUES($1,'qa-preview',$2,'reader') ON CONFLICT(id) DO UPDATE SET password=$2",[id,await passwordHash('Local-preview-only-2026!')]);
 else if(process.argv[2]==='remove'){
   for(const table of['sessions','bookmarks','reading'])await query(`DELETE FROM ${table} WHERE profile_id=$1`,[id]);
   await query('UPDATE audit SET actor=NULL WHERE actor=$1',[id]);
   await query('DELETE FROM profiles WHERE id=$1',[id]);
 }
}finally{await pool.end();}
