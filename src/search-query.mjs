// Shared query validation and conservative metadata-backed suggestions. This
// module performs no network, persistence, candidate selection or acquisition.
export const SEARCH_QUERY_LIMITS=Object.freeze({minCharacters:2,maxCharacters:300,knownRecords:256,aliasesPerRecord:8,suggestions:5,editCharacters:120,editDistance:2});
const PASTE_SPACE=/[\t\r\n\p{Zs}\u2028\u2029]+/gu;
const HIDDEN=/[\p{Cc}\p{Cf}\u034f\u180b-\u180d\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const KINDS=new Set(['book','author','series']),INTENTS=new Set(['auto',...KINDS]);
function fail(code,message){throw Object.assign(new TypeError(message),{code});}
function wellFormed(value){for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;}
/** Length limits intentionally use UTF-16 code units, matching existing API
 * validation. Never truncate a query: doing so could request a different book. */
export function normalizeSearchQuery(value){
 if(typeof value!=='string')fail('SEARCH_QUERY_TYPE','Введите название, автора или серию');
 if(value.length<SEARCH_QUERY_LIMITS.minCharacters||value.length>SEARCH_QUERY_LIMITS.maxCharacters)fail('SEARCH_QUERY_LENGTH','Запрос должен содержать от 2 до 300 символов');
 if(!wellFormed(value))fail('SEARCH_QUERY_UNICODE','Запрос содержит повреждённые символы');
 // Only conventional pasted line breaks and separator spaces are tolerated;
 // vertical tab, form feed, NUL, bidi overrides and zero-width controls fail.
 const spaced=value.replace(PASTE_SPACE,' ');
 if(HIDDEN.test(spaced))fail('SEARCH_QUERY_CONTROL','Введите запрос без скрытых и управляющих символов');
 const query=spaced.normalize('NFKC').replace(PASTE_SPACE,' ').trim();
 if(HIDDEN.test(query)||!wellFormed(query))fail('SEARCH_QUERY_CONTROL','Введите запрос без скрытых и управляющих символов');
 if(query.length<SEARCH_QUERY_LIMITS.minCharacters||query.length>SEARCH_QUERY_LIMITS.maxCharacters)fail('SEARCH_QUERY_LENGTH','Запрос должен содержать от 2 до 300 символов');
 // Run after compatibility normalization, then compact whitespace to prevent
 // a pasted/split scheme or www prefix from bypassing the existing URL rule.
 const compact=query.replace(/\s/gu,'');
 if(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu.test(compact))fail('SEARCH_QUERY_URL','Здесь укажите название или автора. Для ссылки выберите добавление из источника.');
 return query;
}
export function describeSearchQuery(value){const query=normalizeSearchQuery(value);return {originalQuery:value,normalizedQuery:query,changed:value!==query};}
/** Matching aids are never identities for deduplication or automatic download. */
export function searchQueryKey(value){return normalizeSearchQuery(value).toLowerCase().replace(/ё/gu,'е').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/gu,' ').trim();}

/** Bounded optimal-string-alignment Damerau-Levenshtein distance. Adjacent
 * transpositions count once; overlapping transpositions may be overestimated,
 * which conservatively omits a suggestion rather than broadening a match.
 * Above the bound, returns bound+1; never computes a matrix for long inputs. */
export function boundedDamerauDistance(left,right,bound=SEARCH_QUERY_LIMITS.editDistance){
 if(typeof left!=='string'||typeof right!=='string'||!Number.isSafeInteger(bound)||bound<0||bound>SEARCH_QUERY_LIMITS.editDistance)throw new TypeError('Invalid bounded edit-distance input');
 if(left===right)return 0;
 const a=Array.from(left),b=Array.from(right);
 if(a.length>SEARCH_QUERY_LIMITS.editCharacters||b.length>SEARCH_QUERY_LIMITS.editCharacters||Math.abs(a.length-b.length)>bound)return bound+1;
 if(!a.length)return b.length<=bound?b.length:bound+1;if(!b.length)return a.length<=bound?a.length:bound+1;
 let previous=Uint16Array.from({length:b.length+1},(_,index)=>index),beforePrevious=null;
 for(let row=1;row<=a.length;row++){
  const current=new Uint16Array(b.length+1);current.fill(bound+1);current[0]=row;let rowMinimum=bound+1;
  const first=Math.max(1,row-bound),last=Math.min(b.length,row+bound);
  for(let col=first;col<=last;col++){
   let distance=Math.min(previous[col]+1,current[col-1]+1,previous[col-1]+(a[row-1]===b[col-1]?0:1));
   if(beforePrevious&&row>1&&col>1&&a[row-1]===b[col-2]&&a[row-2]===b[col-1])distance=Math.min(distance,beforePrevious[col-2]+1);
   current[col]=distance;rowMinimum=Math.min(rowMinimum,distance);
  }
  if(rowMinimum>bound)return bound+1;beforePrevious=previous;previous=current;
 }
 return previous[b.length]<=bound?previous[b.length]:bound+1;
}
const LATIN_KEYS="qwertyuiop[]asdfghjkl;'zxcvbnm,.",CYRILLIC_KEYS='йцукенгшщзхъфывапролджэячсмитьбю';
const latinToCyrillic=new Map([...LATIN_KEYS].map((letter,index)=>[letter,[...CYRILLIC_KEYS][index]]));
const cyrillicToLatin=new Map([...CYRILLIC_KEYS].map((letter,index)=>[letter,[...LATIN_KEYS][index]]));
const latinConfusables=new Map(Object.entries({a:'а',c:'с',e:'е',o:'о',p:'р',x:'х',y:'у',k:'к',m:'м',t:'т',b:'в',h:'н'}));
const cyrillicConfusables=new Map([...latinConfusables].map(([latin,cyrillic])=>[cyrillic,latin]));
const letters=value=>(value.match(/\p{L}/gu)||[]).length;
const convert=(value,table)=>Array.from(value,letter=>table.get(letter)||letter).join('');
function comparisonVariants(query){
 const lower=query.toLowerCase(),hasLatin=/[a-z]/u.test(lower),hasCyrillic=/[а-яё]/u.test(lower),variants=[];
 const add=(value,reason)=>{try{const key=searchQueryKey(value);if(key&&key!==searchQueryKey(query)&&!variants.some(item=>item.key===key))variants.push({key,reason});}catch{/* Never suggest a transformation that fails the same query policy. */}};
 if(hasLatin&&hasCyrillic){add(convert(lower,latinConfusables),'mixed-alphabet');add(convert(lower,cyrillicConfusables),'mixed-alphabet');}
 // Wrong-layout suggestions need at least four letters from one alphabet and
 // an exact supplied known title/alias. Layout changes never enter fuzzy search.
 if(letters(lower)>=4&&hasLatin&&!hasCyrillic)add(convert(lower,latinToCyrillic),'keyboard-layout');
 if(letters(lower)>=4&&hasCyrillic&&!hasLatin)add(convert(lower,cyrillicToLatin),'keyboard-layout');
 return variants;
}
const ownValue=(record,key)=>{if(!record||typeof record!=='object')return undefined;const descriptor=Object.getOwnPropertyDescriptor(record,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;};
function candidateText(value){try{return typeof value==='string'?normalizeSearchQuery(value):null;}catch{return null;}}
function numbers(value){return (value.match(/\p{N}+/gu)||[]).join('|');}
const reasonRank={'known-alias':0,'mixed-alphabet':1,'keyboard-layout':2,typo:3};
/** Known records: {id?,title,aliases?:string[],kind?:book|author|series}.
 * Results contain only a proposed query and display metadata. Confirming one
 * must create an explicit new/refined request through normal server policy;
 * a suggestion is never a server candidate ID or an acquisition instruction. */
export function suggestSearchQueries(value,known,{intent='auto',limit=SEARCH_QUERY_LIMITS.suggestions}={}){
 const normalizedQuery=normalizeSearchQuery(value);if(!INTENTS.has(intent))throw new TypeError('Unknown search intent');
 if(!Array.isArray(known)||!Number.isSafeInteger(limit)||limit<1||limit>SEARCH_QUERY_LIMITS.suggestions)throw new TypeError('Invalid bounded known-metadata suggestion input');
 const key=searchQueryKey(normalizedQuery),variants=comparisonVariants(normalizedQuery),queryCharacters=Array.from(key).length,threshold=queryCharacters>=12?2:queryCharacters>=5?1:0,matches=[];let inspected=0;
 for(let index=0;index<Math.min(known.length,SEARCH_QUERY_LIMITS.knownRecords);index++){
  const item=ownValue(known,String(index)),title=candidateText(ownValue(item,'title')),kind=ownValue(item,'kind')??'book';if(!title||!KINDS.has(kind)||intent!=='auto'&&kind!==intent)continue;
  const titleKey=searchQueryKey(title);if(!titleKey)continue;inspected++;
  if(titleKey===key)continue;
  const aliases=ownValue(item,'aliases'),texts=[{value:title,key:titleKey,canonical:true}];
  if(Array.isArray(aliases))for(let alias=0;alias<Math.min(aliases.length,SEARCH_QUERY_LIMITS.aliasesPerRecord);alias++){const text=candidateText(ownValue(aliases,String(alias)));if(text){const aliasKey=searchQueryKey(text);if(aliasKey&&!texts.some(row=>row.key===aliasKey))texts.push({value:text,key:aliasKey,canonical:false});}}
  let best=null;
  for(const candidate of texts){
   // Exact canonical spelling/case/punctuation is already a usable query.
   if(candidate.key===key){if(!candidate.canonical&&titleKey!==key)best={reason:'known-alias',distance:0,matchedAlias:candidate.value};continue;}
   const variant=variants.find(item=>item.key===candidate.key);let current;
   if(variant)current={reason:variant.reason,distance:0,...(!candidate.canonical?{matchedAlias:candidate.value}:{})};
   else if(threshold&&queryCharacters<=SEARCH_QUERY_LIMITS.editCharacters&&numbers(key)===numbers(candidate.key)){
    const distance=boundedDamerauDistance(key,candidate.key,threshold),length=Math.max(queryCharacters,Array.from(candidate.key).length);
    if(distance>0&&distance<=threshold&&1-distance/length>=.8)current={reason:'typo',distance,...(!candidate.canonical?{matchedAlias:candidate.value}:{})};
   }
   if(current&&(!best||reasonRank[current.reason]<reasonRank[best.reason]||reasonRank[current.reason]===reasonRank[best.reason]&&current.distance<best.distance))best=current;
  }
  if(best){const knownId=ownValue(item,'id');matches.push({query:title,label:title,kind,knownId:typeof knownId==='string'&&ID.test(knownId)?knownId:null,reason:best.reason,editDistance:best.distance,confirmationRequired:true,...(best.matchedAlias?{matchedAlias:best.matchedAlias}:{}),_index:index});}
 }
 matches.sort((a,b)=>reasonRank[a.reason]-reasonRank[b.reason]||a.editDistance-b.editDistance||a._index-b._index);
 const suggestions=[],seen=new Set();for(const match of matches){const identity=match.kind+'|'+searchQueryKey(match.query);if(seen.has(identity))continue;seen.add(identity);const {_index,...suggestion}=match;suggestions.push(suggestion);if(suggestions.length===limit)break;}
 return {originalQuery:value,normalizedQuery,intent,confirmationRequired:true,suggestions,inspectedRecords:inspected,metadataTruncated:known.length>SEARCH_QUERY_LIMITS.knownRecords};
}
