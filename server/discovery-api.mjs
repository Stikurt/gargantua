import {z} from 'zod';
import {rateLimit} from 'express-rate-limit';
import {createDiscoveryRequest,getDiscoveryRequest,listDiscoveryRequests,decideDiscoveryRequest} from './discovery-requests.mjs';
const id=z.string().uuid();
const chapterRange=z.object({start:z.number().int().min(1).max(20000000),count:z.number().int().min(1).max(5)}).strict();
const input=z.object({idempotencyKey:id,query:z.string().min(2).max(300),intent:z.enum(['auto','book','author','series']).default('auto'),language:z.string().regex(/^[a-z]{2}$/).default('ru'),allowOriginal:z.boolean().default(false),audio:z.boolean().default(true),chapterRange:chapterRange.optional()}).strict();
const decision=z.object({action:z.enum(['approve','cancel','select','retry','refine','more']),expectedRevision:z.number().int().positive(),planRevision:z.number().int().nonnegative().optional(),candidateId:z.string().max(120).optional(),query:z.string().min(2).max(300).optional(),intent:z.enum(['auto','book','author','series']).optional(),language:z.string().regex(/^[a-z]{2}$/).optional(),allowOriginal:z.boolean().optional(),audio:z.boolean().optional(),chapterRange:chapterRange.optional()}).strict();

// This surface accepts a description or a stored candidate ID. Download URLs,
// expected metadata and provider verdicts are never accepted from clients.
export function discoveryRoutes(app,{auth,wrap,pool}){
 const admission=rateLimit({windowMs:60000,limit:12,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Слишком много изменений поисковых заявок. Подождите минуту.'}});
 app.post('/api/discovery/requests',auth,admission,wrap(async(req,res)=>{
  const result=await createDiscoveryRequest(pool,req.profile,input.parse(req.body));res.status(result.idempotent||result.reused?200:202).json(result);
 }));
 app.get('/api/discovery/requests',auth,wrap(async(req,res)=>res.json(await listDiscoveryRequests(pool,req.profile,{limit:50}))));
 app.get('/api/discovery/requests/:id',auth,wrap(async(req,res)=>res.json(await getDiscoveryRequest(pool,req.profile,id.parse(req.params.id)))));
 app.post('/api/discovery/requests/:id/decision',auth,admission,wrap(async(req,res)=>res.json(await decideDiscoveryRequest(pool,req.profile,{id:id.parse(req.params.id),...decision.parse(req.body)}))));
}
