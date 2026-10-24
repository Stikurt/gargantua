const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const keyPattern=/^(lastProfile|[a-f0-9-]{36}:[a-zA-Z0-9:-]{1,180})$/;
class FileStore{
 constructor(root){this.root=path.resolve(root);this.queue=Promise.resolve();this.index=null;}
 checkKey(key){if(typeof key!=='string'||!keyPattern.test(key))throw new Error('Недопустимый ключ локальной библиотеки');}
 location(key){
  this.checkKey(key);
  const parts=key.split(':');
  if(parts[1]==='book'&&/^[a-f0-9-]{36}$/.test(parts[2]||''))return path.join(this.root,'books',parts[0],`${parts[2]}.cotology.json`);
  return path.join(this.root,'metadata',createHash('sha256').update(key).digest('hex')+'.json');
 }
 async init(){
  if(this.index)return;
  await fs.mkdir(this.root,{recursive:true});
  try{
   const raw=await fs.readFile(path.join(this.root,'index.json'),'utf8');
   if(raw.length>4*1024*1024)throw new Error('Слишком большой индекс');
   const index=JSON.parse(raw);for(const[key,value]of Object.entries(index)){this.checkKey(key);if(!Number.isSafeInteger(value)||value<0)throw new Error('Повреждён индекс локальной библиотеки');}
   this.index=index;
  }catch(e){if(e.code!=='ENOENT')throw e;this.index={};}
 }
 async atomic(file,text){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',text,{mode:0o600});await fs.rename(file+'.tmp',file);}
 async get(key){this.checkKey(key);await this.init();try{
  const file=this.location(key),stat=await fs.stat(file);if(stat.size>32*1024*1024)throw new Error('Локальный файл слишком большой');
  const envelope=JSON.parse(await fs.readFile(file,'utf8'));if(envelope.key!==key)throw new Error('Неверная запись локальной библиотеки');return envelope.value;
 }catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async put(key,value){this.checkKey(key);const job=async()=>{
  await this.init();const text=JSON.stringify({key,value}),size=Buffer.byteLength(text);
  if(size>32*1024*1024)throw new Error('Локальный пакет превышает 32 МБ');
  const total=Object.values(this.index).reduce((a,b)=>a+b,0)-(this.index[key]||0)+size;
  if(total>2*1024*1024*1024||Object.keys(this.index).length>=30000)throw new Error('Локальное хранилище заполнено (2 ГБ)');
  await this.atomic(this.location(key),text);this.index[key]=size;await this.atomic(path.join(this.root,'index.json'),JSON.stringify(this.index));
 };const next=this.queue.then(job);this.queue=next.catch(()=>{});return next;}
 async remove(key){this.checkKey(key);const job=async()=>{await this.init();await fs.unlink(this.location(key)).catch(e=>{if(e.code!=='ENOENT')throw e;});delete this.index[key];await this.atomic(path.join(this.root,'index.json'),JSON.stringify(this.index));};const next=this.queue.then(job);this.queue=next.catch(()=>{});return next;}
 async keys(prefix){if(typeof prefix!=='string'||prefix.length>220)throw new Error('Неверный фильтр');await this.init();return Object.keys(this.index).filter(k=>k.startsWith(prefix));}
 async entries(prefix){const keys=await this.keys(prefix);const out=[];for(const key of keys)out.push([key,await this.get(key)]);return out;}
}
module.exports={FileStore};
