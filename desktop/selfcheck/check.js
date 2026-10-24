(async()=>{
 const results=[];const check=(name,condition)=>{results.push({name,ok:!!condition});if(!condition)throw new Error(name);};
 const native=window.cotologyNative;
 try{
  check('Sandbox: no Node.js in renderer',typeof require==='undefined'&&typeof process==='undefined');
  check('Restricted native bridge present',typeof native.get==='function'&&typeof native.put==='function');
  if(native.selfCheckOffline){
   const response=await fetch('/api/me');check('Offline signal is explicit',response.status===503&&response.headers.get('X-Cotology-Offline')==='1');
   const p=await native.get('lastProfile');check('Profile persisted in files',!!p?.id);
   const catalog=await native.get(p.id+':catalog');check('Catalog persisted',catalog?.length>0);
   const keys=await native.keys(p.id+':book:');check('Local package index survives restart',keys.length>0);
   const book=await native.get(keys[0]);check('Three downloaded chapters available without server',book.content.chapters.length===3);
   check('Saved text is present',book.content.chapters[0].blocks.some(b=>b.text.includes('У каждой истории')));
  }else{
   const response=await fetch('/api/me');check('Authenticated API bridge works',response.status===200);
   const p=await response.json();const catalog=await(await fetch('/api/books')).json();
   const book=catalog.find(b=>b.title==='Путеводитель по тихой библиотеке');check('Verified demonstration book found',!!book);
   const packetResponse=await fetch('/api/books/'+book.id+'/download');check('Native package download succeeds',packetResponse.status===200);
   const content=await packetResponse.json();check('Complete chapter package',content.chapters.length===3);
   await native.put('lastProfile',{id:p.id,login:p.login,role:p.role});await native.put(p.id+':catalog',[book]);await native.put(p.id+':book:'+book.id,{book,content,savedAt:Date.now()});
   check('File write/read through isolated IPC', (await native.get(p.id+':book:'+book.id)).content.chapters.length===3);
   let denied=false;try{await native.put('../../escape',{x:1});}catch{denied=true;}check('Arbitrary file paths rejected',denied);
   const out=await fetch('/api/logout',{method:'POST',headers:{'X-Cotology':'1','X-CSRF-Token':p.csrf}});check('POST body/session proxy and logout',out.status===200);
  }
  await native.selfCheckReport({ok:true,results,at:new Date().toISOString()});
 }catch(e){results.push({name:String(e.message),ok:false});await native.selfCheckReport({ok:false,results,at:new Date().toISOString()});}
})();
