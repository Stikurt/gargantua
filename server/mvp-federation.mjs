import {createHash} from 'node:crypto';

const error=(message,status=409)=>Object.assign(new Error(message),{status,code:'MERGE_ALIGNMENT'});
const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/gu,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/gu,' ');
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,28);
export function workTitle(value){return normalize(String(value??'').replace(/\s*\((?:новелла|ранобэ|роман|novel|light novel)\)\s*/giu,' '));}
const aliases=book=>[book.title,book.originalTitle,...(book.aliases??[]),...(book.alternativeTitles??[])].filter(value=>typeof value==='string'&&value.trim()).map(workTitle);
const transliteration={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
const authorKey=value=>normalize(Array.isArray(value)?value.map(item=>typeof item==='string'?item:item?.name??'').join(' '):value).split('').map(letter=>transliteration[letter]??letter).join('').split(' ').filter(Boolean).sort().join(' ');
export function matchMvpWork(base,other){
  if(base.kind!==other.kind)return {matches:false,reason:'Разный вид произведения'};
  const shared=aliases(base).find(title=>title&&aliases(other).includes(title));
  if(!shared)return {matches:false,reason:'Название не совпадает; автоматически объединять нельзя'};
  const a=authorKey(base.author),b=authorKey(other.author);
  const known=value=>value&&!/не указан|unknown|автор/i.test(value);
  const authorMatches=known(a)&&known(b)&&(a===b||a.replaceAll(' ','')===b.replaceAll(' ',''));
  if(known(a)&&known(b)&&!authorMatches)return {matches:false,reason:'У изданий указаны разные авторы'};
  return {matches:true,title:shared,authorMatches,confidence:authorMatches?'title-and-author':'title',warnings:authorMatches?[]:['Совпадение найдено по названию; автор указан не во всех каталогах.']};
}
const numeric=value=>{const raw=String(value??'').trim().replace(',','.');return /^\d+(?:\.\d+)?$/u.test(raw)&&Number.isFinite(Number(raw))?Number(raw):null;};
const partOf=chapter=>numeric(chapter.part??(/(?:часть|part)\s*([0-9]+)/iu.exec(chapter.title??'')?.[1]));
const frontMatter=chapter=>/^(?:(?:начальные|цветные|вступительные) )?(?:иллюстрации?|обложка|титульная страница|illustrations?|cover|оглавление|содержание)(?:$|\s)/iu.test(normalize(chapter.title));
function numbering(book){
  if(['global','volume','unknown'].includes(book.numbering))return book.numbering;
  const numbers=new Map();
  for(const chapter of book.chapters??[]){const n=numeric(chapter.number),v=numeric(chapter.volume)??1;if(n===null||n<=0||frontMatter(chapter))continue;const key=String(n);if(!numbers.has(key))numbers.set(key,new Set());numbers.get(key).add(v);}
  if(!numbers.size)return 'unknown';
  return [...numbers.values()].some(volumes=>volumes.size>1)?'volume':'global';
}
function chapterOrigin(book,chapter,branchId){return chapter.origin??{source:book.source,bookId:String(book.id),chapterId:String(chapter.id),...(branchId??chapter.branchId??book.defaultBranchId?{branchId:String(branchId??chapter.branchId??book.defaultBranchId)}:{})};}
function isAvailable(chapter,branchId){return chapter.available!==false&&(!branchId||!Array.isArray(chapter.branchIds)||chapter.branchIds.map(String).includes(String(branchId)));}
function coordinates(book,mode,branchId){
  const seen=new Set(),duplicates=[],rows=[];
  for(const [index,chapter] of (book.chapters??[]).entries()){
    const number=numeric(chapter.number),volume=numeric(chapter.volume)??1,part=partOf(chapter);
    const origin=chapterOrigin(book,chapter,branchId);
    const parent=number!==null&&number>0&&!frontMatter(chapter)?(mode==='global'?`g:${number}`:`v:${volume}:${number}`):null;
    const key=parent?parent+(part!==null?`:p:${part}`:''):`origin:${origin.source}:${origin.bookId}:${origin.chapterId}:${origin.branchId??''}`;
    if(seen.has(key))duplicates.push(key);seen.add(key);
    rows.push({...chapter,origin,mergeKey:key,coordinateKey:parent,part,number:chapter.number,available:isAvailable(chapter,branchId),_index:index,_n:number,_v:volume});
  }
  return {rows,duplicates};
}
const families=rows=>{const result=new Map();for(const row of rows){if(!row.coordinateKey)continue;if(!result.has(row.coordinateKey))result.set(row.coordinateKey,[]);result.get(row.coordinateKey).push(row);}return result;};
export function compareMvpBooks(base,other,{baseBranchId,otherBranchId}={}){
  const identity=matchMvpWork(base,other),warnings=[...(identity.warnings??[])];
  const aMode=numbering(base),bMode=numbering(other),compatible=aMode!=='unknown'&&aMode===bMode;
  const alignment=compatible?(aMode==='global'?'global-number':'volume-number'):'unverified';
  const a=coordinates(base,compatible?aMode:'volume',baseBranchId),b=coordinates(other,compatible?bMode:'volume',otherBranchId);
  const aParents=new Set(a.rows.filter(row=>row.coordinateKey).map(row=>row.coordinateKey));
  const bParents=new Set(b.rows.filter(row=>row.coordinateKey).map(row=>row.coordinateKey));
  const baseAvailableFamilies=families(a.rows.filter(row=>row.available));
  const coveredDuplicateKeys=new Set(b.duplicates.filter(key=>{const incoming=b.rows.find(row=>row.mergeKey===key);return (baseAvailableFamilies.get(incoming.coordinateKey)??[]).some(row=>row.part===null||row.mergeKey===key);}));
  const overlap=[...aParents].filter(key=>bParents.has(key)).length;
  const nontrivial=identity.title?.split(' ').length>=2;
  const enoughOverlap=overlap>=Math.min(3,aParents.size,bParents.size)&&overlap>0;
  const disjointVerified=identity.authorMatches&&aMode==='global'&&aParents.size>0&&bParents.size>0;
  let reason='';
  if(!identity.matches)reason=identity.reason;
  else if(base.kind!=='novel')reason='У книжных изданий может различаться разбиение на страницы. Откройте выбранное издание отдельно.';
  else if(!compatible)reason='Нумерация томов и глав различается или не подтверждена. Автоматическое объединение недоступно.';
  else if(a.duplicates.length||b.duplicates.some(key=>!coveredDuplicateKeys.has(key)))reason='В оглавлении есть неоднозначные номера новых глав и частей. Выберите источник отдельно.';
  else if(!(enoughOverlap&&(identity.authorMatches||nontrivial)||disjointVerified))reason='Недостаточно совпадающих глав для надёжного объединения.';
  if(reason)warnings.push(reason);
  if(!reason&&coveredDuplicateKeys.size)warnings.push(`У другого источника неоднозначно подписаны ${coveredDuplicateKeys.size} совпадающих номеров. Эти записи не подменяют главы основного источника.`);
  if(!reason)warnings.push('Новые главы могут быть в другом переводе. Уже выбранный текст совпадающих глав сохраняется.');
  const aKeys=new Set(a.rows.map(row=>row.mergeKey));
  const aFamilies=families(a.rows),aRows=new Map(a.rows.map(row=>[row.mergeKey,row]));
  const added=b.rows.filter(row=>row.available&&row.coordinateKey&&!aKeys.has(row.mergeKey)&&!(aFamilies.get(row.coordinateKey)??[]).some(existing=>existing.part===null||row.part===null));
  const fills=b.rows.filter(row=>row.available&&aRows.has(row.mergeKey)&&!aRows.get(row.mergeKey).available);
  return {book:other,chaptersCount:(other.chapters??[]).length,availableCount:b.rows.filter(row=>row.available).length,baseCount:a.rows.length,addedCount:reason?0:added.length,matchedCount:overlap,fillCount:reason?0:fills.length,alignment,canMerge:!reason,warnings,identityConfidence:identity.confidence??'none'};
}
export function mergeMvpBooks(base,other,options={}){
  const comparison=compareMvpBooks(base,other,options);
  if(!comparison.canMerge)throw error(comparison.warnings.at(-1));
  const mode=numbering(base),a=coordinates(base,mode,options.baseBranchId),b=coordinates(other,mode,options.otherBranchId);
  const rows=new Map(a.rows.map(row=>[row.mergeKey,{...row,alternateOrigins:[...(row.alternateOrigins??[])]}]));
  const familyIndex=families(a.rows);
  const ambiguousIncoming=new Set(b.duplicates);
  let addedCount=0,filledCount=0;
  for(const incoming of b.rows){
    if(ambiguousIncoming.has(incoming.mergeKey))continue;
    const existing=rows.get(incoming.mergeKey);
    if(existing){
      existing.alternateOrigins.push({...incoming.origin,available:incoming.available});
      if(!existing.available&&incoming.available){existing.alternateOrigins.push({...existing.origin,available:false});existing.origin=incoming.origin;existing.available=true;filledCount++;}
      continue;
    }
    if(!incoming.coordinateKey||!incoming.available)continue;
    // A complete chapter and split parts are not interchangeable cached texts.
    // Keep the base edition on overlap; preserve every explicit new part.
    if((familyIndex.get(incoming.coordinateKey)??[]).some(row=>row.part===null||incoming.part===null))continue;
    rows.set(incoming.mergeKey,{...incoming,alternateOrigins:[]});
    if(!familyIndex.has(incoming.coordinateKey))familyIndex.set(incoming.coordinateKey,[]);familyIndex.get(incoming.coordinateKey).push(incoming);addedCount++;
  }
  const ordered=[...rows.values()].sort((a,b)=>{
    if(!a.coordinateKey&&!b.coordinateKey)return a._index-b._index;
    if(!a.coordinateKey)return a._index<3?-1:1;if(!b.coordinateKey)return b._index<3?1:-1;
    return (mode==='volume'?a._v-b._v:0)||a._n-b._n||(a.part??0)-(b.part??0);
  });
  const chapters=ordered.map(({_index,_n,_v,...chapter})=>({...chapter,id:'mc-'+hash(chapter.mergeKey),baseChapterId:chapter.origin.source===base.source&&chapter.origin.bookId===String(base.id)?chapter.origin.chapterId:undefined}));
  const mergeBase=base.mergeBase??{source:base.source,id:String(base.id),...(options.baseBranchId?{branchId:String(options.baseBranchId)}:{})};
  const id=hash(JSON.stringify(mergeBase));
  const contributors=[{source:base.source,id:String(base.id),title:base.title,url:base.url,chaptersCount:a.rows.length},{source:other.source,id:String(other.id),title:other.title,url:other.url,chaptersCount:b.rows.length}];
  const book={...base,source:'merged',sourceName:'Объединённое оглавление',url:undefined,id,mergeBase,contributors,chapters,branches:[],defaultBranchId:null,numbering:mode,chapterCount:chapters.length,kind:'novel',coverage:`${a.rows.length} разделов основного источника; добавлено ${addedCount}, заполнено пропусков ${filledCount}.`,warnings:comparison.warnings};
  return {book,chapters,branches:[],sources:contributors,warnings:comparison.warnings,summary:{baseCount:a.rows.length,otherCount:b.rows.length,totalCount:chapters.length,addedCount,filledCount,matchedCount:comparison.matchedCount,alignment:comparison.alignment}};
}

export function createMvpFederation({sources}){
  const related=async({source,id,title,branchId}={})=>{
    const base=await sources.book(source,id);
    const queries=[...new Set([String(title||base.title).replace(/\s*\((?:новелла|ранобэ|novel)\)\s*/giu,'').trim(),base.originalTitle].filter(Boolean))].slice(0,2);
    const alternatives=[],errors=[];
    await Promise.all((sources.sources??[]).filter(meta=>meta.id!==source&&meta.kind===base.kind).map(async meta=>{
      try{
        let candidates=[];
        for(const query of queries){const result=await sources.search({source:meta.id,query,page:1});if(result.errors?.length){errors.push(...result.errors);break;}candidates=result.items.filter(item=>matchMvpWork(base,item).matches);if(candidates.length)break;}
        for(const candidate of candidates.slice(0,2)){
          try{
            if(base.kind!=='novel'){alternatives.push({book:candidate,chaptersCount:null,availableCount:null,addedCount:0,matchedCount:0,canMerge:false,alignment:'edition',warnings:['Издание открывается отдельно: разбиение книжных изданий может отличаться.']});continue;}
            const detail=await sources.book(candidate.source,candidate.id);
            alternatives.push(compareMvpBooks(base,detail,{baseBranchId:branchId}));
          }catch(cause){errors.push({source:meta.id,message:cause.message});}
        }
      }catch(cause){errors.push({source:meta.id,message:cause.message});}
    }));
    alternatives.sort((a,b)=>Number(b.canMerge)-Number(a.canMerge)||(b.addedCount??0)-(a.addedCount??0)||(b.availableCount??0)-(a.availableCount??0));
    return {base,alternatives,errors};
  };
  const merge=async({baseSource,baseId,otherSource,otherId,baseBranchId,otherBranchId})=>{
    if(baseSource===otherSource&&String(baseId)===String(otherId))throw error('Выберите другой источник');
    const [base,other]=await Promise.all([sources.book(baseSource,baseId),sources.book(otherSource,otherId)]);
    return mergeMvpBooks(base,other,{baseBranchId,otherBranchId});
  };
  return {related,merge};
}
