import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mvpSources,MVP_SOURCE_LIST} from './mvp-sources.mjs';
import {createMvpFederation} from './mvp-federation.mjs';
import {mvpRetryAfterMs} from './mvp-errors.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function createMvpApp({sources=mvpSources}={}) {
  const app=express();
  app.disable('x-powered-by');
  const federation=createMvpFederation({sources});
  const sourceList=sources.sources??MVP_SOURCE_LIST;
  app.use((req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    next();
  });
  const source=(req,name='source',allowAll=true)=>{
    const value=String(req.query[name]||(allowAll?'all':''));
    if(!(allowAll&&value==='all')&&!sourceList.some(source=>source.id===value))throw Object.assign(new Error('Неизвестный источник'),{status:400});
    return value;
  };
  const value=(req,name,max=1600)=>{
    if(typeof req.query[name]!=='string'||!req.query[name].trim()||req.query[name].length>max)throw Object.assign(new Error('Неверный параметр: '+name),{status:400});
    return req.query[name].trim();
  };
  app.get('/api/mvp/health',(_req,res)=>res.json({ok:true,name:'Гаргантюа',version:'0.7.1',mode:'search-offline-reader'}));
  app.get('/api/mvp/sources',(_req,res)=>res.json({sources:sourceList.map(source=>({...source,status:'unknown'}))}));
  app.get('/api/mvp/search',async(req,res)=>{
    const query=String(req.query.q||'').trim();
    if(query.length>500)throw Object.assign(new Error('Запрос слишком длинный'),{status:400});
    const page=Number(req.query.page||1);
    if(!Number.isSafeInteger(page)||page<1||page>500)throw Object.assign(new Error('Неверная страница'),{status:400});
    res.setHeader('Cache-Control','no-store');res.json(await sources.search({query,source:source(req),page}));
  });
  app.get('/api/mvp/random',async(req,res)=>res.json(await sources.random({source:source(req)})));
  app.get('/api/mvp/book',async(req,res)=>res.json(await sources.book(source(req),value(req,'id'))));
  app.get('/api/mvp/chapter',async(req,res)=>res.json(await sources.chapter(source(req),value(req,'id'),value(req,'chapterId'),{branchId:req.query.branchId?value(req,'branchId'):undefined})));
  app.get('/api/mvp/related',async(req,res)=>res.json(await federation.related({source:source(req,'source',false),id:value(req,'id'),title:req.query.title?value(req,'title',500):undefined,branchId:req.query.branchId?value(req,'branchId'):undefined})));
  app.get('/api/mvp/merge',async(req,res)=>res.json(await federation.merge({baseSource:source(req,'baseSource',false),baseId:value(req,'baseId'),otherSource:source(req,'otherSource',false),otherId:value(req,'otherId'),baseBranchId:req.query.baseBranchId?value(req,'baseBranchId'):undefined,otherBranchId:req.query.otherBranchId?value(req,'otherBranchId'):undefined})));
  app.use('/api',(_req,res)=>res.status(404).json({error:'Этот раздел не входит в MVP'}));
  app.use(express.static(path.join(root,'dist'),{index:'index.html',maxAge:0}));
  app.use((error,_req,res,_next)=>{
    console.error('[MVP]',error.code||error.name,error.message);
    const status=error.status>=400&&error.status<600?error.status:502;
    const retryAfterMs=status===429?mvpRetryAfterMs(Number.isFinite(error.retryAfterMs)?String(error.retryAfterMs/1000):null):undefined;
    if(retryAfterMs!==undefined)res.setHeader('Retry-After',String(Math.ceil(retryAfterMs/1000)));
    res.status(status).json({error:error.message||'Источник временно недоступен',code:error.code||'SOURCE_ERROR',...(retryAfterMs===undefined?{}:{retryAfterMs})});
  });
  return app;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||3080);
  createMvpApp().listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`Гаргантюа MVP 0.7.1 — порт ${port}`));
}
