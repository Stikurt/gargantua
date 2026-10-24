import {unzipSync} from 'fflate';
import sax from 'sax';

const MB=1024*1024;
function fail(message){throw new Error(message);}
function decode(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('Нужна книга в кодировке UTF-8. Пересохраните исходный файл.');}}
function xml(text,handlers){
 if(text.length>4*MB||/<!DOCTYPE|<!ENTITY/i.test(text))fail('Недопустимая XML-структура');
 const parser=sax.parser(true,{trim:false,strictEntities:true});let depth=0,nodes=0;
 parser.onopentag=node=>{if(++depth>64||++nodes>100000)fail('Слишком сложная книга');const name=node.name.toLowerCase().split(':').pop();if(['script','iframe','object','embed','svg','math','form'].includes(name))fail('Активное содержимое книги запрещено');handlers.open?.(name,node.attributes);};
 parser.onclosetag=name=>{handlers.close?.(name.toLowerCase().split(':').pop());depth--;};
 parser.ontext=text=>handlers.text?.(text);parser.oncdata=parser.ontext;
 parser.onerror=()=>fail('Повреждённый XML книги');parser.write(text).close();
}
function paragraphs(text){return text.split(/\n\s*\n/).map(t=>({type:'paragraph',text:t.trim()})).filter(b=>b.text);}
function plainXml(text,fb2=false){
 const blocks=[];let textBuffer='',skip=0,body=false,title='',author='',path=[];
 const flush=type=>{const value=textBuffer.replace(/\s+/g,' ').trim();textBuffer='';if(value){if(blocks.length>=30000)fail('Слишком много абзацев');blocks.push({type:type||'paragraph',text:value});}};
 xml(text,{
  open(name){path.push(name);if(name==='body')body=true;if(name==='binary'||name==='annotation')skip++;if(['p','h1','h2','h3','title','subtitle'].includes(name)&&body&&!skip)flush();},
  text(value){if(path.includes('book-title'))title+=value;if(path.includes('author'))author+=value+' ';if(body&&!skip)textBuffer+=value;},
  close(name){if(['p','h1','h2','h3','title','subtitle'].includes(name)&&body&&!skip)flush(['h1','h2','h3','title','subtitle'].includes(name)?'heading':'paragraph');if(name==='binary'||name==='annotation')skip--;if(fb2&&name==='body'){flush();body=false;}path.pop();}
 });flush();return {blocks,title:title.trim(),author:author.replace(/\s+/g,' ').trim()};
}
function pathJoin(base,relative){
 if(!relative||/[\\\u0000]|^[a-z]+:|^\//i.test(relative))fail('Недопустимый путь в EPUB');
 let decoded;try{decoded=decodeURIComponent(relative.split('#')[0]);}catch{fail('Повреждённый путь EPUB');}
 const parts=base.split('/').slice(0,-1);for(const p of decoded.split('/')){if(p==='..'){if(!parts.length)fail('Выход за пределы EPUB');parts.pop();}else if(p&&p!=='.')parts.push(p);}
 return parts.join('/');
}
export function importBook(bytes,filename){
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>10*MB)fail('Локальный импорт: от 1 байта до 10 МБ');
 const ext=filename.split('.').pop().toLowerCase(),fallback=filename.replace(/\.[^.]+$/,'').slice(0,250);let title=fallback,author='',chapters=[];
 if(ext==='txt'){
  const text=decode(bytes);if(/[\u0000-\u0008\u000e-\u001f]/.test(text))fail('Это не текстовая книга');
  const blocks=paragraphs(text);for(let i=0;i<blocks.length;i+=150)chapters.push({title:`Часть ${chapters.length+1}`,blocks:blocks.slice(i,i+150)});
 }else if(ext==='fb2'){
  const text=decode(bytes);if(!/<(?:\w+:)?FictionBook[\s>]/.test(text))fail('Не найден формат FB2');
  const result=plainXml(text,true);title=result.title||title;author=result.author;
  let current={title:'Начало',blocks:[]};for(const block of result.blocks){if(block.type==='heading'&&current.blocks.length){chapters.push(current);current={title:block.text.slice(0,250),blocks:[]};}current.blocks.push(block);}if(current.blocks.length)chapters.push(current);
 }else if(ext==='epub'){
  let count=0,total=0;const names=new Set();
  const files=unzipSync(bytes,{filter(file){
   if(++count>1000||file.name.length>300||/\\|(^|\/)\.\.?(\/|$)|^\/|\u0000/.test(file.name)||names.has(file.name))fail('Небезопасная структура EPUB');names.add(file.name);
   if(file.originalSize>4*MB||(total+=file.originalSize)>16*MB||file.originalSize>Math.max(file.size,1)*150)fail('EPUB превышает лимиты распаковки');
   return /\.(?:xml|opf|xhtml|html|htm)$/i.test(file.name)||file.name==='mimetype';
  }});
  if(!files.mimetype||decode(files.mimetype).trim()!=='application/epub+zip')fail('Это не EPUB');
  let opf;xml(decode(files['META-INF/container.xml']||new Uint8Array()),{open(n,a){if(n==='rootfile')opf=a['full-path'];}});
  if(!opf||!files[opf])fail('Не найдено оглавление EPUB');
  const manifest=new Map(),spine=[];let field='';
  xml(decode(files[opf]),{open(n,a){if(n==='item')manifest.set(a.id,{href:a.href,type:a['media-type']});if(n==='itemref')spine.push(a.idref);field=n;},text(t){if(field==='title'){if(title===fallback)title='';title+=t;}if(field==='creator')author+=t;},close(){field='';}});
  if(spine.length>1000)fail('Слишком много глав EPUB');
  for(const id of spine){const item=manifest.get(id);if(!item||!['application/xhtml+xml','text/html'].includes(item.type))continue;const key=pathJoin(opf,item.href);if(!files[key])fail('В EPUB отсутствует глава');const result=plainXml(decode(files[key]));if(result.blocks.length)chapters.push({title:result.blocks.find(b=>b.type==='heading')?.text.slice(0,250)||`Глава ${chapters.length+1}`,blocks:result.blocks});}
 }else fail('Поддерживаются EPUB, FB2 и TXT');
 if(!chapters.length||chapters.length>1000||chapters.reduce((n,c)=>n+c.blocks.length,0)>30000)fail('Книга пуста или превышает лимиты');
 return {title:title.trim().slice(0,250),author:author.trim().slice(0,250),chapters,assets:{},localImport:true,illustrationsOmitted:true};
}

