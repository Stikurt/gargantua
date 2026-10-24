import {z} from 'zod';
import {validateCatalogs} from '../src/catalogs.mjs';
import {saveLegacyCatalogs} from './reader-legacy.mjs';
const item=z.object({id:z.uuid(),scope:z.enum(['device','server']),title:z.string().max(250),author:z.string().max(250)}).strict();
const schema=z.object({revision:z.number().int().min(0).max(2147483646),catalogs:z.array(z.object({id:z.uuid(),title:z.string().trim().min(1).max(120),parent:z.uuid().nullable(),items:z.array(item).max(200)}).strict()).max(100)}).strict();
export async function saveCatalogs(pool,profileId,data){
 return saveLegacyCatalogs(pool,profileId,data);
}
export function catalogRoutes(app,{auth,wrap,error,query,pool}){
 app.get('/api/catalogs',auth,wrap(async(req,res)=>{const {rows}=await query('SELECT revision,catalogs FROM profile_catalogs WHERE profile_id=$1',[req.profile.id]);res.json(rows[0]||{revision:0,catalogs:[]});}));
 app.put('/api/catalogs',auth,wrap(async(req,res)=>{
  const data=schema.parse(req.body);validateCatalogs(data.catalogs);
  if(Buffer.byteLength(JSON.stringify(data))>24000)throw error('Каталоги превышают 24 КБ',413);
  res.json(await saveCatalogs(pool,req.profile.id,data));
 }));
}
