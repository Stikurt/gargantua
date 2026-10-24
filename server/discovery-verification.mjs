/** Identity consistency gate after isolated parsing, before publication.
 * expected MUST come from the persisted provider selection. It must never be
 * copied into parser fields to manufacture evidence. This is neither malware
 * scanning nor a copyright/authenticity guarantee. No network, ZIP or XML parser
 * runs here: EPUB evidence must originate in the isolated parser's OPF reader.
 */
import {createHash} from 'node:crypto';

const MAX_INPUT=20*1024*1024,MAX_TXT=6*1024*1024,HEADER_BYTES=64*1024;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bounded=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\p{Cc}\p{Cf}]/u.test(value);
const normalized=value=>value.normalize('NFKC').toLowerCase().replace(/ё/gu,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/gu,' ');
const person=value=>normalized(value.replace(/,?\s*\(?\d{3,4}\s*[-–—]\s*\d{0,4}\)?\s*$/u,'')).split(' ').sort().join(' ');
const unique=values=>[...new Set(values)].sort();
const same=(a,b)=>a.length===b.length&&a.every((item,index)=>item===b[index]);
const LANGUAGE={en:'en',eng:'en',english:'en',ru:'ru',rus:'ru',russian:'ru',fr:'fr',fra:'fr',fre:'fr',french:'fr',de:'de',deu:'de',ger:'de',german:'de',es:'es',spa:'es',spanish:'es',it:'it',ita:'it',italian:'it',pt:'pt',por:'pt',portuguese:'pt',ja:'ja',jpn:'ja',japanese:'ja',zh:'zh',zho:'zh',chi:'zh',chinese:'zh',ko:'ko',kor:'ko',korean:'ko',uk:'uk',ukr:'uk',ukrainian:'uk',kk:'kk',kaz:'kk',kazakh:'kk',pl:'pl',pol:'pl',polish:'pl'};
const language=value=>LANGUAGE[value.toLowerCase().trim()]??(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})*$/u.test(value)?value.slice(0,2):null);
function stringArray(value,maxItems,maxLength){return Array.isArray(value)&&value.length>0&&value.length<=maxItems&&value.every(item=>bounded(item,maxLength));}

export function gutenbergIdentifier(value){
 if(typeof value!=='string'||value.length>500)return null;
 return /^(?:https?:\/\/(?:www\.)?gutenberg\.org\/(?:ebooks|etext)\/|urn:gutenberg:)([1-9][0-9]{0,9})\/?$/iu.exec(value)?.[1]??null;
}

/** Extract only actual UTF-8 TXT header/footer fields, not body name mentions.
 * Strict modern/classic Gutenberg wrappers intentionally send unsupported older
 * formats to review instead of substituting the filename or expected metadata.
 */
export function inspectGutenbergText(raw){
 const observed={title:null,authors:[],languages:[],sourceIds:[],evidence:'gutenberg-txt-header-footer'};
 const reasons=[];const reject=code=>{if(!reasons.includes(code))reasons.push(code);};
 if(!Buffer.isBuffer(raw)||!raw.length||raw.length>MAX_TXT)return {observed,reasons:['TEXT_INPUT_LIMIT']};
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(raw).replace(/\r\n?/gu,'\n');}catch{return {observed,reasons:['TEXT_ENCODING_UNKNOWN']};}
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))reject('TEXT_CONTENT_INVALID');
 const marker=/^\*{3}\s*(START|END) OF (?:THE|THIS) PROJECT GUTENBERG EBOOK (.+?)\s*\*{3}\s*$/gimu;
 const markers=[];for(const found of text.matchAll(marker)){markers.push({kind:found[1].toUpperCase(),title:found[2].trim(),index:found.index,end:found.index+found[0].length});if(markers.length>2)break;}
 if(markers.length!==2||markers[0].kind!=='START'||markers[1].kind!=='END'||markers[0].index>HEADER_BYTES||text.length-markers[1].end>HEADER_BYTES||markers[1].index<=markers[0].end){reject('GUTENBERG_WRAPPER_MISSING');return {observed,reasons};}
 const header=text.slice(0,markers[0].index);
 if(!/(?:The Project Gutenberg eBook|Project Gutenberg(?:'s|’s) eBook)/iu.test(header.slice(0,2048)))reject('GUTENBERG_HEADER_MISSING');
 const fields=new Map();let current=null;
 const lines=header.split('\n');
 if(lines.length>1500||lines.some(line=>line.length>2000))return {observed,reasons:['SOURCE_METADATA_LIMIT']};
 for(const line of lines){
  const field=/^([A-Za-z][A-Za-z -]{0,40}):\s*(.*)$/u.exec(line);
  if(field){current=field[1].toLowerCase();if(!fields.has(current))fields.set(current,[]);fields.get(current).push(field[2].trim());}
  else if(current&&/^\s+\S/u.test(line))fields.get(current).push(line.trim());
  else current=null;
 }
 const titles=fields.get('title')??[];
 if(titles.length===1&&bounded(titles[0],300))observed.title=titles[0];else reject('SOURCE_TITLE_UNKNOWN');
 const authors=[...(fields.get('author')??[]),...(fields.get('authors')??[])];
 if(stringArray(authors,16,200))observed.authors=authors;else reject('SOURCE_AUTHORS_UNKNOWN');
 const labels=(fields.get('language')??[]).flatMap(value=>value.split(/\s*,\s*/u));
 const langs=labels.map(language);
 if(labels.length&&labels.length<=16&&langs.every(Boolean))observed.languages=unique(langs);else reject('SOURCE_LANGUAGE_UNKNOWN');
 const ids=[];
 for(const found of header.matchAll(/\[(?:eBook)\s*#\s*([1-9][0-9]{0,9})\]/giu))ids.push(found[1]);
 for(const found of header.matchAll(/^eBook(?:-No\.|\s+No\.)?:\s*([1-9][0-9]{0,9})\s*$/gimu))ids.push(found[1]);
 observed.sourceIds=unique(ids);
 if(observed.sourceIds.length!==1)reject(observed.sourceIds.length?'SOURCE_ID_CONFLICT':'SOURCE_ID_UNKNOWN');
 if(observed.title&&markers.some(item=>normalized(item.title)!==normalized(observed.title)))reject('GUTENBERG_MARKER_TITLE_MISMATCH');
 if(!text.slice(markers[0].end,markers[1].index).trim())reject('TEXT_BODY_MISSING');
 return {observed,reasons};
}

function inspectEpub(book){
 const observed={title:null,authors:[],languages:[],sourceIds:[],evidence:'isolated-parser-opf'};
 const reasons=[],meta=book?.sourceMetadata;
 if(!object(meta)||meta.schemaVersion!==1||meta.format!=='epub'||meta.provenance!=='opf')return {observed,reasons:['SOURCE_METADATA_UNKNOWN']};
 if(bounded(meta.title,300))observed.title=meta.title;else reasons.push('SOURCE_TITLE_UNKNOWN');
 if(stringArray(meta.authors,16,200))observed.authors=[...meta.authors];else reasons.push('SOURCE_AUTHORS_UNKNOWN');
 const langs=Array.isArray(meta.languages)&&meta.languages.length<=16?meta.languages.filter(x=>bounded(x,30)).map(language):[];
 if(langs.length===meta.languages?.length&&langs.length&&langs.every(Boolean))observed.languages=unique(langs);else reasons.push('SOURCE_LANGUAGE_UNKNOWN');
 if(!Array.isArray(meta.identifiers)||meta.identifiers.length>32||!meta.identifiers.every(x=>bounded(x,500)))reasons.push('SOURCE_ID_UNKNOWN');
 else observed.sourceIds=unique(meta.identifiers.map(gutenbergIdentifier).filter(Boolean));
 if(observed.sourceIds.length!==1)reasons.push(observed.sourceIds.length?'SOURCE_ID_CONFLICT':'SOURCE_ID_UNKNOWN');
 if(observed.title&&(!bounded(book.title,300)||normalized(book.title)!==normalized(observed.title)))reasons.push('PARSER_METADATA_CONFLICT');
 if(observed.authors.length&&(!bounded(book.author,300)||!observed.authors.some(author=>person(author)===person(book.author))))reasons.push('PARSER_METADATA_CONFLICT');
 if(observed.languages.length&&(!bounded(book.language,30)||!observed.languages.includes(language(book.language))))reasons.push('PARSER_METADATA_CONFLICT');
 return {observed,reasons:unique(reasons)};
}

/** Caller already validates book and fences parsed output to the attempt token.
 * input hash pins this decision to actual downloaded bytes; metadata never
 * substitutes for the separate ClamAV, parser, resource and publication gates.
 */
export function verifyDiscoveredBook({expected,book,extension,rawInput,expectedInputSha256}={}){
 const result={status:'review_required',verified:false,reasons:[],observed:null,inputSha256:null,
  assurance:'metadata-consistency-only',securityScanRequired:true,rightsVerified:false};
 const reject=code=>{if(!result.reasons.includes(code))result.reasons.push(code);};
 if(!object(expected)||expected.provider!=='gutenberg'||typeof expected.remoteId!=='string'||!/^[1-9][0-9]{0,9}$/u.test(expected.remoteId)||!bounded(expected.title,300)||!stringArray(expected.authors,16,200)||!Array.isArray(expected.languages)||!expected.languages.length||expected.languages.length>16||!expected.languages.every(x=>typeof x==='string'&&/^[a-z]{2}$/u.test(x))){reject('EXPECTED_METADATA_INVALID');return result;}
 if(expected.language!==null&&expected.language!==undefined&&(!expected.languages.includes(expected.language)||expected.languages.length!==1)){reject('EXPECTED_METADATA_INVALID');return result;}
 if(!Buffer.isBuffer(rawInput)||!rawInput.length||rawInput.length>MAX_INPUT){reject('INPUT_BYTES_MISSING');return result;}
 result.inputSha256=createHash('sha256').update(rawInput).digest('hex');
 if(typeof expectedInputSha256!=='string'||!/^[a-f0-9]{64}$/u.test(expectedInputSha256)||expectedInputSha256!==result.inputSha256){reject('INPUT_HASH_MISMATCH');return result;}
 if(!object(book)){reject('PARSED_BOOK_MISSING');return result;}
 const inspected=extension==='txt'?inspectGutenbergText(rawInput):extension==='epub'?inspectEpub(book):null;
 if(!inspected){reject('SOURCE_FORMAT_UNSUPPORTED');return result;}
 result.observed=inspected.observed;for(const reason of inspected.reasons)reject(reason);
 const observed=result.observed;
 if(observed.title&&normalized(observed.title)!==normalized(expected.title))reject('SOURCE_TITLE_MISMATCH');
 if(observed.authors.length&&!same(unique(observed.authors.map(person)),unique(expected.authors.map(person))))reject('SOURCE_AUTHORS_MISMATCH');
 if(observed.languages.length&&!same(unique(observed.languages),unique(expected.languages)))reject('SOURCE_LANGUAGE_MISMATCH');
 if(observed.sourceIds.length===1&&observed.sourceIds[0]!==expected.remoteId)reject('SOURCE_ID_MISMATCH');
 if(!result.reasons.length){result.verified=true;result.status='verified';}
 return result;
}
