import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function applyMigrations(database) {
 const directory=new URL('./migrations/',import.meta.url),files=(await fs.readdir(directory)).filter(f=>/^\d{3}-[a-z0-9-]+\.sql$/.test(f)).sort();
 const client=await database.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(84627190)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  const applied=new Map((await client.query('SELECT version,sha256 FROM schema_migrations')).rows.map(r=>[r.version,r.sha256]));
  if([...applied.keys()].some(name=>!files.includes(name)))throw new Error('БД использует неизвестную версию схемы; откат приложения запрещён');
  for(const file of files){
   const bytes=await fs.readFile(new URL(file,directory)),sha=createHash('sha256').update(bytes).digest('hex');
   if(applied.has(file)){if(applied.get(file)!==sha)throw new Error(`Изменена применённая миграция ${file}`);continue;}
   await client.query(bytes.toString('utf8'));await client.query('INSERT INTO schema_migrations(version,sha256) VALUES($1,$2)',[file,sha]);
  }
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
