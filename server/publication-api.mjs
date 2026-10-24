import {canonicalJson,checkedPublicationView,sha256,publicChapter} from './publication-model.mjs';
const version=(req,error)=>{if(req.query.revision!=='1')throw error('Укажите доступную неизменяемую версию: revision=1',409);};
function send(req,res,bytes,type='application/json'){
 const digest=sha256(bytes),etag=`"${digest}"`;res.set('ETag',etag).set('X-Content-SHA256',digest);
 if(req.get('If-None-Match')===etag)return res.status(304).end();
 return res.type(type).send(bytes);
}
export function publicationRoutes(app,{auth,wrap,error,readable,verifiedPublication}){
 app.get('/api/v2/implementation',auth,(_req,res)=>res.json({version:'0.2.0-core.14',storageVersion:10,session:'legacy-cookie-and-CSRF',implemented:['GET publication revision=1','GET publication chapter revision=1','GET publication image revision=1','legacy-session discovery requests','bounded author and series continuation','exact-source shared acquisition','durable derived queue','EN-to-RU machine-draft translation','RU chunked WAV audio','private reader metadata CAS and change feed','durable reader mutation receipts and tombstones','reader metadata export and explicit import','counter-bound v2 mutation IDs','automatic accepted-receipt compaction and backup budget','stable Ranobe inventory observation','bounded accepted-text language routing'],notImplemented:['v2 session','audio position server sync'],compatibility:'/api/books',derived:'/api/derived'}));
 app.get('/api/v2/publications/:id',auth,wrap(async(req,res)=>{
  version(req,error);const row=await readable(req.params.id),checked=await verifiedPublication(row),view=checkedPublicationView(row,checked.content);send(req,res,view.bytes);
 }));
 app.get('/api/v2/publications/:id/chapters/:chapterId',auth,wrap(async(req,res)=>{
  version(req,error);const row=await readable(req.params.id),checked=await verifiedPublication(row),view=checkedPublicationView(row,checked.content);
  const chapter=view.structure.chapters.find(chapter=>chapter.id===req.params.chapterId),entry=view.manifest.readingOrder.find(entry=>entry.chapterId===req.params.chapterId);
  if(!chapter||!entry)throw error('Глава этой версии не найдена',404);
  const bytes=Buffer.from(canonicalJson(publicChapter(chapter)));if(sha256(bytes)!==entry.sha256||bytes.length!==entry.bytes)throw error('Глава не прошла проверку целостности',423);send(req,res,bytes);
 }));
 app.get('/api/v2/publications/:id/resources/:name',auth,wrap(async(req,res)=>{
  version(req,error);if(!/^image-\d{1,3}\.png$/.test(req.params.name))throw error('Ресурс не найден',404);
  const row=await readable(req.params.id),checked=await verifiedPublication(row);checkedPublicationView(row,checked.content);
  const bytes=checked.buffers.get(req.params.name);if(!bytes)throw error('Ресурс не найден',404);res.set('Content-Security-Policy',"default-src 'none'");send(req,res,bytes,'image/png');
 }));
}
