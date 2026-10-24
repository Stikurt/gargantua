// The primary source's observed JSON editor shape, converted to inert escaped
// markup for the existing isolated parser. This is not an HTML safety boundary:
// the raw source, converted bundle and parsed result still require their scans.
const MAX_BYTES=2*1024*1024,MAX_NODES=20000,MAX_DEPTH=16,MAX_TEXT=100000;
const reject=()=>{throw Object.assign(new Error('Глава недоступна или имеет неподдерживаемый формат'),{code:'RANOBE_CONTENT'});};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key));
const validText=value=>typeof value==='string'&&value.length<=MAX_TEXT&&value.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const escape=value=>value.replace(/[&<>"']/gu,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export function normalizeRanobeContent(content,{attachments=[],validateImage}={}){
 if(typeof content==='string'){
  if(!content.trim()||!content.isWellFormed()||Buffer.byteLength(content)>MAX_BYTES)reject();
  return content;
 }
 if(!Array.isArray(attachments)||attachments.length>50)reject();const images=new Map(),usedImages=new Set();
 for(const attachment of attachments){
  const required=['filename','name','extension','width','height','url','previewUrl','originalUrl'];
  if(!exact(attachment,required)||required.some(key=>!Object.hasOwn(attachment,key))||!UUID.test(attachment.name??'')||images.has(attachment.name)||!['png','jpg','jpeg','webp'].includes(attachment.extension)||attachment.filename!==attachment.name+'.'+attachment.extension)reject();
  if(!Number.isSafeInteger(attachment.width)||!Number.isSafeInteger(attachment.height)||attachment.width<1||attachment.height<1||attachment.width>20000||attachment.height>20000||attachment.width*attachment.height>40000000)reject();
  if(typeof attachment.url!=='string'||attachment.url.length>2000||!attachment.url.startsWith('/uploads/ranobe/')||attachment.previewUrl!==attachment.url||attachment.originalUrl!==attachment.url||!attachment.url.endsWith('/'+attachment.filename)||typeof validateImage!=='function')reject();
  const url='https://ranobelib.me'+attachment.url;let checked;try{checked=validateImage(url);}catch{reject();}if(checked!==url)reject();images.set(attachment.name,url);
 }
 let nodes=0,bytes=0,hasText=false,imageCount=0;const chunks=[],active=new Set();
 const append=value=>{bytes+=Buffer.byteLength(value);if(bytes>MAX_BYTES)reject();chunks.push(value);};
 const walk=(node,depth=0)=>{
  if(++nodes>MAX_NODES||depth>MAX_DEPTH||!record(node)||active.has(node))reject();active.add(node);
  try{
   if(node.type==='doc'){
    if(depth!==0||!exact(node,['type','content'])||!Array.isArray(node.content)||!node.content.length||node.content.length>MAX_NODES)reject();
    for(const child of node.content){if(!['paragraph','image','horizontalRule'].includes(child?.type))reject();walk(child,depth+1);}
   }else if(node.type==='paragraph'){
    if(depth!==1||!exact(node,['type','content','attrs'])||node.content!==undefined&&(!Array.isArray(node.content)||node.content.length>MAX_NODES))reject();
    // Observed on the first chapter of volume 1. Alignment is cosmetic and
    // flattened by the existing inert publication schema; never forward CSS.
    if(Object.hasOwn(node,'attrs')&&(!exact(node.attrs,['textAlign'])||node.attrs.textAlign!=='center'))reject();
    append('<p>');for(const child of node.content??[]){if(!['text','hardBreak'].includes(child?.type))reject();walk(child,depth+1);}append('</p>');
   }else if(node.type==='hardBreak'){
    if(depth!==2||!exact(node,['type']))reject();append('<br>');
   }else if(node.type==='text'){
    if(depth!==2||!exact(node,['type','text','marks'])||!validText(node.text))reject();
    const marks=node.marks??[];
    if(!Array.isArray(marks)||marks.length>2||Object.hasOwn(node,'marks')&&node.marks===null)reject();
    const seen=new Set(),tags=[];
    for(const mark of marks){
     if(++nodes>MAX_NODES||!exact(mark,['type'])||!['bold','italic'].includes(mark.type)||seen.has(mark.type))reject();
     seen.add(mark.type);tags.push(mark.type==='bold'?'strong':'em');
    }
    if(node.text.trim())hasText=true;
    append(tags.map(tag=>`<${tag}>`).join('')+escape(node.text)+tags.toReversed().map(tag=>`</${tag}>`).join(''));
   }else if(node.type==='horizontalRule'){
    // Observed in the selected source's typed editor response. A plain scene
    // break survives both inert representations without introducing a new
    // executable tag, attribute, publication kind or renderer capability.
    if(depth!==1||!exact(node,['type']))reject();append('<p>***</p>');
   }else if(node.type==='image'){
    if(depth!==1||!exact(node,['type','attrs'])||!exact(node.attrs,['description','images'])||node.attrs.description!==null||!Array.isArray(node.attrs.images)||node.attrs.images.length!==1)reject();
    const reference=node.attrs.images[0];if(!exact(reference,['image'])||!UUID.test(reference.image??'')||!images.has(reference.image)||++imageCount>50)reject();
    usedImages.add(reference.image);append(`<img src="${escape(images.get(reference.image))}" alt="">`);
   }else reject();
  }finally{active.delete(node);}
 };
 walk(content);if(!hasText&&!imageCount||usedImages.size!==images.size)reject();
 let serialized;try{serialized=JSON.stringify({content,attachments});}catch{reject();}if(Buffer.byteLength(serialized)>MAX_BYTES)reject();
 return chunks.join('');
}
