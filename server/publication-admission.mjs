// Shared process budget for verified book reads and reader-metadata work.
// An aborted HTTP response must not release a still-running file/JSON task.
let active=0;
const leases=new WeakMap();
export function publicationAdmission(req,res,next){
 if(active>=2)return res.status(429).json({error:'Уже открываются книги или сохраняются данные. Повторите через несколько секунд'});
 active++;
 const state={started:false,released:false,release(){if(!this.released){this.released=true;active--;}}};leases.set(req,state);
 res.once('finish',()=>{if(!state.started)state.release();});
 res.once('close',()=>{if(!state.started)state.release();});next();
}
export function publicationHandler(wrap,fn){return wrap(async(req,res,next)=>{
 const state=leases.get(req);if(!state)throw new Error('Publication admission required');state.started=true;
 try{return await fn(req,res,next);}finally{state.release();}
});}
export const publicationWork=(wrap,fn)=>[publicationAdmission,publicationHandler(wrap,fn)];
