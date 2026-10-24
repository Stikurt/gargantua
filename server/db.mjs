import { applyMigrations } from './migrations.mjs';
import pg from 'pg';
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6,connectionTimeoutMillis:10000,statement_timeout:15000 });
export const query = (sql, values = []) => pool.query(sql, values);
export const migrate = (database=pool) => applyMigrations(database);
export const audit = (actor, action, target, details = {}) => query('INSERT INTO audit(actor,action,target,details) VALUES($1,$2,$3,$4)', [actor, action, target, JSON.stringify(details)]);
