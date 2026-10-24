import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {saveCatalogs} from '../server/catalog-api.mjs';
const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(url.pathname))throw new Error('Explicit isolated database required');
const schema='catalog_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href,max:1});
const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);const pool=new pg.Pool({connectionString:scoped.href,max:4});
const profile=randomUUID(),other=randomUUID();let owned=false;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);owned=true;await applyMigrations(pool);await pool.query("INSERT INTO profiles(id,login,password) VALUES($1,'catalog-fixture','unused'),($2,'other-fixture','unused')",[profile,other]);});
after(async()=>{await pool.end();try{if(owned){assert.match(schema,/^catalog_test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}});
test('catalog audit failure rolls back both the first row and revision',async()=>{
 await pool.query("ALTER TABLE audit ADD CONSTRAINT fixture_audit_failure CHECK(action<>'catalogs.saved') NOT VALID");
 try{await assert.rejects(()=>saveCatalogs(pool,profile,{revision:0,catalogs:[]}),{code:'23514'});assert.equal((await pool.query('SELECT count(*)::int AS n FROM profile_catalogs')).rows[0].n,0);}
 finally{await pool.query('ALTER TABLE audit DROP CONSTRAINT fixture_audit_failure');}
});
test('parallel base revisions accept one write; another profile remains independent',async()=>{
 const result=await Promise.allSettled([saveCatalogs(pool,profile,{revision:0,catalogs:[]}),saveCatalogs(pool,profile,{revision:0,catalogs:[]})]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.find(r=>r.status==='rejected').reason.status,409);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='catalogs.saved' AND actor=$1",[profile])).rows[0].n,1);
 await saveCatalogs(pool,other,{revision:0,catalogs:[]});assert.equal((await pool.query('SELECT revision FROM profile_catalogs WHERE profile_id=$1',[profile])).rows[0].revision,1);
});
