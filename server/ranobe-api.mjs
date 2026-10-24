import {z} from 'zod';
import {rateLimit} from 'express-rate-limit';
import {createRanobeRequest,getRanobeFeed,getRanobeRun,getRanobeParts,configureRanobeFeed} from './ranobe-store.mjs';
import {withImportAdmission,checkImportCapacity} from './import-admission.mjs';
const uuid=z.string().uuid();
const request=z.object({idempotencyKey:uuid,url:z.string().max(2000),branch:z.number().int().nonnegative().nullable(),language:z.string().regex(/^[a-z]{2}$/).default('ru'),autoUpdate:z.boolean().default(true),force:z.boolean().default(false)}).strict();
export function ranobeRoutes(app,{auth,wrap,pool,quarantine,library}){
 const missing=()=>Object.assign(new Error('Книга или версия не найдена'),{status:404});
 const visible=async(profile,id)=>{const feed=await getRanobeFeed(pool,id);if(!feed)throw missing();if(profile.role!=='owner'&&!feed.head_run_id&&feed.requested_by!==profile.id&&!(await pool.query('SELECT 1 FROM ranobe_feed_requests WHERE feed_id=$1 AND profile_id=$2 LIMIT 1',[id,profile.id])).rowCount)throw missing();return feed;};
 const limit=rateLimit({windowMs:60000,limit:12,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Подождите минуту перед следующим запросом RanobeLib'}});
 app.post('/api/ranobe/requests',auth,limit,wrap(async(req,res)=>{
  const input=request.parse(req.body),result=await withImportAdmission(pool,req,res,()=>createRanobeRequest(pool,req.profile,input,{checkCapacity:client=>checkImportCapacity(client,quarantine,library)}));res.status(result.idempotent||result.reused?200:202).json(result);
 }));
 app.get('/api/ranobe/feeds',auth,wrap(async(req,res)=>res.json((await pool.query("SELECT f.* FROM ranobe_feeds f WHERE $1::boolean OR f.head_run_id IS NOT NULL OR f.requested_by=$2 OR EXISTS(SELECT 1 FROM ranobe_feed_requests r WHERE r.feed_id=f.id AND r.profile_id=$2) ORDER BY f.updated_at DESC LIMIT 100",[req.profile.role==='owner',req.profile.id])).rows)));
 app.get('/api/ranobe/feeds/:id',auth,wrap(async(req,res)=>{
  const feed=await visible(req.profile,uuid.parse(req.params.id));const progress=feed.active_import_id?(await pool.query('SELECT id,status,stage,error,book_id,report FROM imports WHERE id=$1',[feed.active_import_id])).rows[0]:null;res.json({feed,progress});
 }));
 app.get('/api/ranobe/feeds/:id/snapshots/:snapshot',auth,wrap(async(req,res)=>{
  const feed=await visible(req.profile,uuid.parse(req.params.id)),run=await getRanobeRun(pool,uuid.parse(req.params.snapshot));if(!run||run.feed_id!==feed.id)throw missing();
  if(run.status!=='ready'&&req.profile.role!=='owner'&&feed.requested_by!==req.profile.id)throw missing();
  const parts=await getRanobeParts(pool,run.id);if(parts.length&&(await pool.query("SELECT 1 FROM ranobe_run_parts p JOIN books b ON b.id=p.book_id WHERE p.run_id=$1 AND b.security_state<>'passed' LIMIT 1",[run.id])).rowCount)throw Object.assign(new Error('Выдача версии приостановлена для проверки безопасности'),{status:423});
  res.json({feedId:feed.id,snapshotId:run.id,status:run.status,branch:feed.branch_key==='default'?null:feed.branch_key,language:feed.language,coverage:'source-inventory-snapshot',originalWorkComplete:false,chapterCount:run.chapter_count,inventorySha256:run.inventory_sha256,parts:parts.map(part=>({id:part.id,status:part.status,firstChapter:part.ordinal+1,chapterKeys:part.source_keys,publicationId:part.book_id,revision:1,packageSha256:part.package_sha256}))});
 }));
 app.post('/api/ranobe/feeds/:id/settings',auth,limit,wrap(async(req,res)=>{
  const settings=z.object({autoUpdate:z.boolean(),expectedRevision:z.number().int().positive()}).strict().parse(req.body);res.json(await configureRanobeFeed(pool,req.profile,uuid.parse(req.params.id),settings));
 }));
}
