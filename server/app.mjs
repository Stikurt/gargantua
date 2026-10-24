import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { pool, query, migrate, audit } from './db.mjs';
import { hash, token, validId, passwordHash, verifyPassword, safeName, fileType } from './security.mjs';
import { checkUrl } from './fetch.mjs';
import { resolveRanobe, ranobeSlug, searchRanobe } from './ranobe.mjs';
import {catalogRoutes} from './catalog-api.mjs';
import {readPublication} from './publication-files.mjs';
import {withImportAdmission,assertImportRequestActive,checkImportCapacity} from './import-admission.mjs';
import {assertUploadRetryable} from './upload-lifecycle.mjs';
import {applyImportDecision,canRetryImport} from './import-decisions.mjs';
import {publicationRoutes} from './publication-api.mjs';
import {discoveryRoutes} from './discovery-api.mjs';
import {ranobeRoutes} from './ranobe-api.mjs';
import {derivedRoutes} from './derived-api.mjs';
import {assertDerivedPublication} from './derived-jobs.mjs';
import {readerRoutes} from './reader-api.mjs';
import {publicationWork} from './publication-admission.mjs';
import {saveLegacyReading,saveLegacyBookmark,deleteLegacyBookmark} from './reader-legacy.mjs';
import {listSerialGroups,withSerialMembership} from './serial-groups.mjs';

await migrate();
const app=express(), qdir=process.env.QUARANTINE_DIR || '/quarantine', clean=process.env.LIBRARY_DIR || '/library';
const origin=process.env.APP_ORIGIN || 'http://localhost:3080';
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'","data:"],connectSrc:["'self'"],objectSrc:["'none'"],frameSrc:["'none'"],frameAncestors:["'none'"],upgradeInsecureRequests:null}}}));
app.use(cookieParser());
// Only the authenticated metadata-import routes accept a larger raw body.
// Book imports retain their separate quarantine and multipart limits.
app.use(express.json({limit:'32kb',type:req=>!['/api/v2/reader/import','/api/v2/reader/import/preview'].includes(req.path)&&!!req.is('application/json')}));
app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
app.use('/api',rateLimit({windowMs:60000,limit:240,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Слишком много запросов, подождите минуту'}}));
app.use('/api',(req,res,next)=>{
  if(['POST','PUT','PATCH','DELETE'].includes(req.method) && (req.get('X-Cotology')!=='1' || (req.get('Origin') && req.get('Origin')!==origin))) return res.status(403).json({error:'Запрос отклонён: источник или защитный заголовок'});
  next();
});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const heavy=fn=>publicationWork(wrap,fn);
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const auth=wrap(async(req,res,next)=>{
  const value=req.cookies.cotology;
  if(typeof value!=='string' || value.length!==64) throw error('Войдите в библиотеку',401);
  const result=await query('SELECT p.id,p.login,p.role,s.csrf FROM sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.token_hash=$1 AND s.expires_at>now()',[hash(value)]);
  if(!result.rows[0]) throw error('Сессия завершена. Войдите снова',401);
  req.profile=result.rows[0];
  if(['POST','PUT','PATCH','DELETE'].includes(req.method) && req.get('X-CSRF-Token')!==req.profile.csrf) throw error('Обновите страницу и повторите действие',403);
  next();
});
const owner=(req,_res,next)=>req.profile.role==='owner'?next():next(error('Действие доступно владельцу',403));
const withAdmission=fn=>wrap((req,res)=>withImportAdmission(pool,req,res,assertActive=>fn(req,res,assertActive)));
catalogRoutes(app,{auth,wrap,error,query,audit,pool});
readerRoutes(app,{auth,wrap,pool});
discoveryRoutes(app,{auth,wrap,pool});
ranobeRoutes(app,{auth,wrap,pool,quarantine:qdir,library:clean});
derivedRoutes(app,{auth,wrap,error,pool,library:clean});
app.get('/api/sources/ranobe/search',auth,rateLimit({windowMs:60000,limit:12,message:{error:'Поиск: не чаще 12 раз в минуту'}}),wrap(async(req,res)=>{
 const title=z.string().trim().min(2).max(150).parse(req.query.q);res.json(await searchRanobe(title));
}));
const sessionCookie={httpOnly:true,sameSite:'strict',secure:origin.startsWith('https:'),maxAge:7*86400000,path:'/'};
const dummy=await passwordHash(token());
app.post('/api/login',rateLimit({windowMs:15*60000,limit:12,message:{error:'Слишком много попыток входа. Подождите 15 минут'}}),wrap(async(req,res)=>{
  const {login,password}=z.object({login:z.string().min(1).max(60),password:z.string().max(256)}).parse(req.body);
  const {rows}=await query('SELECT * FROM profiles WHERE login=$1',[login]); const profile=rows[0];
  if(!await verifyPassword(password,profile?.password || dummy) || !profile) throw error('Неверный логин или пароль',401);
  const value=token(),csrf=token();
  await query('INSERT INTO sessions(token_hash,profile_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval \'7 days\')',[hash(value),profile.id,csrf]);
  res.cookie('cotology',value,sessionCookie).json({ok:true});
}));
app.get('/api/me',auth,(req,res)=>res.json(req.profile));
app.post('/api/logout',auth,wrap(async(req,res)=>{await query('DELETE FROM sessions WHERE token_hash=$1',[hash(req.cookies.cotology)]);res.clearCookie('cotology',sessionCookie).json({ok:true});}));
app.post('/api/password',auth,wrap(async(req,res)=>{
  const {current,password}=z.object({current:z.string().max(256),password:z.string().min(12).max(256)}).parse(req.body);
  const {rows}=await query('SELECT password FROM profiles WHERE id=$1',[req.profile.id]);
  if(!await verifyPassword(current,rows[0].password)) throw error('Текущий пароль неверен');
  await query('UPDATE profiles SET password=$1 WHERE id=$2',[await passwordHash(password),req.profile.id]);
  await query('DELETE FROM sessions WHERE profile_id=$1',[req.profile.id]);
  await audit(req.profile.id,'password.changed',req.profile.id);res.clearCookie('cotology',sessionCookie).json({ok:true});
}));
app.get('/api/status',auth,wrap(async(req,res)=>{
  const settings=(await query('SELECT * FROM settings WHERE id=1')).rows[0];
  const statuses=(await query('SELECT * FROM system_status')).rows;
  res.json({settings,statuses,version:'0.2.0-core.14',storageVersion:10,supported:['epub','fb2','txt'],localOnly:true});
}));
app.get('/api/books',auth,wrap(async(req,res)=>{
  const {rows}=await query(`SELECT b.*,p.login AS initiator,r.chapter,r.position,r.shelf,r.updated_at AS reading_updated FROM books b JOIN profiles p ON p.id=b.requested_by LEFT JOIN reading r ON r.book_id=b.id AND r.profile_id=$1 ORDER BY b.created_at DESC`,[req.profile.id]);res.json(await withSerialMembership(pool,rows));
}));
app.get('/api/library/serial-groups',auth,wrap(async(req,res)=>res.json(await listSerialGroups(pool,req.profile))));
async function readable(id) {
  validId(id);
  const {rows}=await query('SELECT b.*,s.serving_paused FROM books b CROSS JOIN settings s WHERE b.id=$1',[id]);
  if(!rows[0]) throw error('Книга не найдена',404);
  if(rows[0].security_state!=='passed' || rows[0].serving_paused) throw error('Выдача приостановлена: проверка безопасности или аварийная остановка',423);
  await assertDerivedPublication(pool,id);
  return rows[0];
}
async function verifiedPublication(book){
  try{return await readPublication(clean,book);}
  catch(e){
    console.error('Publication integrity check failed:',book.id,e.code||e.name);
    throw error('Книга временно недоступна: файлы не прошли проверку целостности. Владелец должен проверить или восстановить копию.',423);
  }
}
publicationRoutes(app,{auth,wrap:heavy,error,readable,verifiedPublication});
app.get('/api/books/:id',auth,heavy(async(req,res)=>{
  const book=(await withSerialMembership(pool,[await readable(req.params.id)]))[0];
  const {content}=await verifiedPublication(book);
  const reading=(await query('SELECT * FROM reading WHERE profile_id=$1 AND book_id=$2',[req.profile.id,book.id])).rows[0]||null;
  const marks=(await query('SELECT * FROM bookmarks WHERE profile_id=$1 AND book_id=$2 ORDER BY created_at DESC',[req.profile.id,book.id])).rows;
  res.json({book,chapters:content.chapters.map((c,i)=>({title:c.title,index:i})),reading,bookmarks:marks});
}));
app.get('/api/books/:id/chapters/:chapter',auth,heavy(async(req,res)=>{
  const book=await readable(req.params.id);const index=Number(req.params.chapter);
  if(!Number.isInteger(index) || index<0 || index>=book.chapter_count) throw error('Глава не найдена',404);
  const {content}=await verifiedPublication(book);res.json(content.chapters[index]);
}));
app.get('/api/books/:id/assets/:name',auth,heavy(async(req,res)=>{
  const book=await readable(req.params.id);
  if(!/^image-\d{1,3}\.png$/.test(req.params.name)) throw error('Изображение не найдено',404);
  const {buffers}=await verifiedPublication(book),bytes=buffers.get(req.params.name);
  if(!bytes)throw error('Изображение не найдено',404);
  res.type('png').set('Content-Security-Policy',"default-src 'none'").send(bytes);
}));
app.get('/api/books/:id/download',auth,heavy(async(req,res)=>{
  const book=await readable(req.params.id);
  const {raw}=await verifiedPublication(book);
  await audit(req.profile.id,'book.package.issued',book.id);
  res.set('X-Content-SHA256',book.content_sha256).type('application/json').send(raw);
}));
app.put('/api/books/:id/reading',auth,heavy(async(req,res)=>{
  const book=await readable(req.params.id);
  const data=z.object({chapter:z.number().int().min(0).max(book.chapter_count-1),position:z.number().min(0).max(1),shelf:z.enum(['reading','planned','finished','paused','dropped','favorite']).default('reading')}).parse(req.body);
  res.json(await saveLegacyReading(pool,req.profile,book,data));
}));
app.post('/api/books/:id/bookmarks',auth,heavy(async(req,res)=>{
  const book=await readable(req.params.id);
  const data=z.object({id:z.string().uuid().optional(),chapter:z.number().int().min(0).max(book.chapter_count-1),position:z.number().min(0).max(1),note:z.string().max(500)}).parse(req.body);
  res.json(await saveLegacyBookmark(pool,req.profile,book,data));
}));
app.delete('/api/bookmarks/:id',auth,wrap(async(req,res)=>{res.json(await deleteLegacyBookmark(pool,req.profile,validId(req.params.id)));}));
async function capacity() {
  return checkImportCapacity(pool,qdir,clean);
}
const storage=multer.diskStorage({destination:path.join(qdir,'incoming'),filename:(req,_file,cb)=>cb(null,req.importId)});
const upload=multer({storage,limits:{fileSize:20*1024*1024,files:1,fields:0,parts:1},fileFilter:(_req,file,cb)=>{try{fileType(file.originalname);cb(null,true);}catch(e){cb(e);}}});
app.post('/api/imports/upload',auth,owner,wrap(async(req,res,next)=>{
  await withImportAdmission(pool,req,res,async(assertActive)=>{
    await capacity();assertActive();req.importId=randomUUID();
    await query("INSERT INTO imports(id,requested_by,kind,filename,status,approved_by,decision_reason) VALUES($1,$2,'upload','','uploading',$2,'owner')",[req.importId,req.profile.id]);
  });
  // The complete reservation is visible before other admission writers or
  // multipart storage proceed. Abort cannot release it midway through INSERT.
  assertImportRequestActive(req,res);next();
}),upload.single('file'),wrap(async(req,res)=>{
  if(!req.file) throw error('Выберите файл');
  // From here the durable intent owns the file. An uncertain DB response must
  // never delete bytes that a committed queued request may already be using.
  req.preserveUpload=true;
  const input=await fs.open(req.file.path,'r');try{await input.sync();}finally{await input.close();}
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const saved=await client.query("UPDATE imports SET filename=$1,status='queued',updated_at=now() WHERE id=$2 AND status='uploading' RETURNING id",[safeName(req.file.originalname),req.importId]);
    if(!saved.rowCount)throw error('Загрузка прервана или её срок истёк');
    await client.query("INSERT INTO audit(actor,action,target) VALUES($1,'import.upload',$2)",[req.profile.id,req.importId]);await client.query('COMMIT');req.importCommitted=true;
  }catch(e){
    await client.query('ROLLBACK').catch(()=>{});
    const saved=(await query('SELECT status FROM imports WHERE id=$1',[req.importId])).rows[0];
    if(saved&&['queued','processing','completed'].includes(saved.status))req.importCommitted=true;else throw e;
  }finally{client.release();}
  res.status(202).json({id:req.importId});
}));
app.post('/api/imports/ranobe/preview',auth,rateLimit({windowMs:60000,limit:6}),wrap(async(req,res)=>{
  const {url}=z.object({url:z.string().max(2000)}).parse(req.body);const info=await resolveRanobe(url);delete info.list;res.json(info);
}));
app.post('/api/imports/ranobe',auth,withAdmission(async(req,res,assertActive)=>{
  await capacity();const data=z.object({url:z.string().max(2000),branch:z.number().int().nonnegative().nullable(),start:z.number().int().min(1).max(20000),count:z.number().int().min(1).max(20)}).parse(req.body);
  ranobeSlug(data.url);const id=randomUUID(),auto=['owner','trusted-import'].includes(req.profile.role);assertActive();
  await query('INSERT INTO imports(id,requested_by,kind,filename,source_url,status,approved_by,decision_reason,options) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,req.profile.id,'ranobe','RanobeLib',data.url,auto?'queued':'pending-approval',auto?req.profile.id:null,auto?'role-auto-approval':null,JSON.stringify(data)]);
  await audit(req.profile.id,'import.ranobe-request',id,{start:data.start,count:data.count,branch:data.branch});res.status(202).json({id});
}));
app.post('/api/imports/link',auth,withAdmission(async(req,res,assertActive)=>{
  await capacity();
  const data=z.object({url:z.string().max(2000),kind:z.enum(['file','source-review']),filename:z.string().max(180).optional()}).parse(req.body);
  const url=checkUrl(data.url),id=randomUUID();
  let name='';if(data.kind==='file'){name=safeName(data.filename || decodeURIComponent(url.pathname.split('/').pop()||''));fileType(name);}
  const auto=req.profile.role==='owner' || req.profile.role==='trusted-import';
  const status=data.kind==='source-review'?'source-review':auto?'queued':'pending-approval';assertActive();
  await query('INSERT INTO imports(id,requested_by,kind,filename,source_url,status,approved_by,decision_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,req.profile.id,data.kind,name,url.href,status,auto&&data.kind==='file'?req.profile.id:null,auto?'role-auto-approval':null]);
  await audit(req.profile.id,'import.request',id,{kind:data.kind});res.status(202).json({id});
}));
app.get('/api/imports',auth,wrap(async(req,res)=>{
  const {rows}=await query(`SELECT i.*,p.login AS initiator FROM imports i JOIN profiles p ON p.id=i.requested_by ${req.profile.role==='owner'?'':'WHERE i.requested_by=$1'} ORDER BY i.created_at DESC LIMIT 100`,req.profile.role==='owner'?[]:[req.profile.id]);
  // Source URLs may contain secrets; never expose query strings through the dashboard.
  res.json(rows.map(r=>({...r,source_url:r.source_url?new URL(r.source_url).origin+new URL(r.source_url).pathname:null})));
}));
app.post('/api/imports/:id/cancel',auth,withAdmission(async(req,res,assertActive)=>{
 const id=validId(req.params.id),row=(await query('SELECT * FROM imports WHERE id=$1',[id])).rows[0];
 if(!row)throw error('Заявка не найдена',404);
 if(row.requested_by!==req.profile.id&&req.profile.role!=='owner')throw error('Можно отменить только собственную заявку',403);
 if(!['queued','processing','pending-approval','source-review'].includes(row.status))throw error('Заявка уже закрыта или файл ещё передаётся',409);
 assertActive();await applyImportDecision(pool,{id,expectedStatus:row.status,action:'cancel',actor:req.profile.id,reason:'Отмена пользователем'});res.json({ok:true});
}));
app.post('/api/imports/:id/decision',auth,owner,withAdmission(async(req,res,assertActive)=>{
  const data=z.object({action:z.enum(['approve','reject','retry']),reason:z.string().max(300).default('')}).parse(req.body),id=validId(req.params.id);
  const row=(await query('SELECT * FROM imports WHERE id=$1',[id])).rows[0];if(!row)throw error('Заявка не найдена',404);
  if(data.action==='approve' && (row.kind==='source-review' || row.status!=='pending-approval')) throw error('Эту заявку нельзя одобрить для скачивания. Нужен поддерживаемый адаптер или прямая ссылка');
  if(data.action==='retry' && !canRetryImport(row))throw error('Повтор доступен после ошибки/блокировки или для проверки поддерживаемой полной ветки RanobeLib');
  if(data.action==='retry')await assertUploadRetryable(row,qdir);
  if(data.action==='reject' && ['processing','completed'].includes(row.status))throw error('Активную задачу остановите через аварийную паузу');
  if(data.action!=='reject')await checkImportCapacity(pool,qdir,clean,{exclude:id});assertActive();
  await applyImportDecision(pool,{id,expectedStatus:row.status,action:data.action,actor:req.profile.id,reason:data.reason});res.json({ok:true});
}));
app.get('/api/audit',auth,owner,wrap(async(_req,res)=>res.json((await query('SELECT a.*,p.login FROM audit a LEFT JOIN profiles p ON p.id=a.actor ORDER BY a.id DESC LIMIT 100')).rows)));
app.get('/api/policy',auth,wrap(async(_req,res)=>res.type('text/plain').send(await fs.readFile('LIBRARY_POLICY.md','utf8'))));
app.get('/api/health',(_req,res)=>res.json({ok:true}));
app.use('/api',(_req,res)=>res.status(404).json({error:'Метод не найден'}));
app.use(express.static('dist',{index:false}));
app.get('/{*path}',(_req,res)=>res.sendFile(path.resolve('dist/index.html')));
app.use((err,req,res,_next)=>{
  if(req.importId&&!req.importCommitted){
    query("UPDATE imports SET status='error',security_state='error',error='Загрузка не завершена. Повторно выберите файл.',updated_at=now() WHERE id=$1 AND status='uploading'",[req.importId]).catch(()=>{});
    if(!req.preserveUpload)fs.unlink(path.join(qdir,'incoming',req.importId)).catch(()=>{});
  }
  const status=err instanceof z.ZodError?400:err.code==='LIMIT_FILE_SIZE'?413:err.status||500;
  if(status===500) console.error('Request failed:',err.code || err.name);
  const readerDetails=status<500&&typeof err.code==='string'&&err.code.startsWith('READER_')?{code:err.code,...(Number.isSafeInteger(err.expectedCounter)?{expectedCounter:err.expectedCounter}:{}),...(typeof err.consumed==='boolean'?{consumed:err.consumed}:{}),...(typeof err.snapshotRequired==='boolean'?{snapshotRequired:err.snapshotRequired}:{})}:{};
  res.status(status).json({error:err instanceof z.ZodError?'Проверьте заполненные поля':status===500?'Ошибка сервера. Подробности в журнале':err.message,...readerDetails});
});
const server=app.listen(3080,'0.0.0.0',()=>console.log('Cotology: http://localhost:3080'));
server.requestTimeout=300000;
process.on('SIGTERM',()=>server.close(()=>pool.end().then(()=>process.exit(0))));
