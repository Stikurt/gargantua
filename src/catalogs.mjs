export const DEVICE='00000000-0000-4000-8000-000000000001';
export function validateCatalogs(catalogs){
 if(!Array.isArray(catalogs)||catalogs.length>100)throw new Error('Не больше 100 каталогов');
 const ids=new Set(catalogs.map(c=>c.id));if(ids.size!==catalogs.length)throw new Error('Повтор каталога');
 let items=0;
 for(const c of catalogs){
  if(!/^[a-f0-9-]{36}$/.test(c.id)||typeof c.title!=='string'||!c.title.trim()||c.title.length>120||!Array.isArray(c.items)||(items+=c.items.length)>200)throw new Error('Недопустимый каталог или больше 200 записей');
  const seen=new Set([c.id]);let parent=c.parent;
  while(parent){if(!ids.has(parent)||seen.has(parent))throw new Error('Недопустимая вложенность каталогов');seen.add(parent);if(seen.size>8)throw new Error('Не больше 7 уровней вложенности');parent=catalogs.find(x=>x.id===parent).parent;}
  for(const item of c.items){if(!['device','server'].includes(item.scope)||!/^[a-f0-9-]{36}$/.test(item.id)||typeof item.title!=='string'||item.title.length>250||typeof item.author!=='string'||item.author.length>250)throw new Error('Недопустимая запись каталога');}
 }
 return catalogs;
}
