// Conservative routing evidence for already accepted, immutable text packages.
// This is a bounded statistical hint, never source metadata or a security seal.
import {createHash} from 'node:crypto';
import {readPublication} from './publication-files.mjs';
import {checkedPublicationView} from './publication-model.mjs';

export const TEXT_LANGUAGE_METHOD='bounded-text-language-v2';
const MAX_PARTS=3,MAX_CHAPTERS=3,WINDOW=4000,MAX_READ_BYTES=96*1024*1024;
const HASH=/^[a-f0-9]{64}$/u;
const sha=value=>createHash('sha256').update(value).digest('hex');
const indices=length=>[...new Set([0,Math.floor((length-1)/2),length-1])];
const words=value=>new Set(value.split(' '));
const RU=words('и в на с не что он она они его ее это как но а то по к из у за от для был была было были быть мы вы я мне меня ему ее себя когда если чтобы который которая которые потому после перед уже еще только даже чем при между здесь там теперь тогда очень можно надо без через');
const EN=words('the and of to in a is was were be been for with that this it he she they his her their not had have has as at from but on by which when who would could should if then than there so into we you my your our what did do does all after before because only about through between');
// той/те/само/много/вече also occur in Russian. They cannot establish
// Bulgarian evidence, even when several occur in a confidently Russian window.
const BULGARIAN=words('това тя като което която които съм със беше бяха щеше защото няма когато този тази тези всичко нейните техните');
const OTHER_LATIN=words('der die das und ist nicht eine einen nicht mit für que qui une les des dans est avec pour mais los las una por para pero del el la et le il lo gli che della sono');
const tally=(tokens,set)=>({hits:tokens.filter(token=>set.has(token)).length,distinct:new Set(tokens.filter(token=>set.has(token))).size});
export const languageSourceSetSha=books=>sha(JSON.stringify(books.map(book=>({publicationId:book.id,language:book.language,publicationSha256:book.publication_sha256,packageSha256:book.package_sha256}))));
export const currentLanguageDetection=(previous,sourceSetSha256)=>HASH.test(sourceSetSha256??'')&&previous?.status==='detected'&&['ru','en'].includes(previous.language)&&previous.evidence?.method===TEXT_LANGUAGE_METHOD&&previous.evidence.sourceSetSha256===sourceSetSha256;

export function detectTextLanguage(value){
 if(typeof value!=='string'||!value.isWellFormed()||value.length>WINDOW)return {language:null,reason:'SAMPLE_INVALID'};
 const text=value.toLowerCase().replace(/ё/gu,'е'),letters=text.match(/\p{L}/gu)??[],tokens=text.match(/\p{L}+/gu)??[];
 const counts={characters:value.length,letters:letters.length,words:tokens.length};
 if(letters.length<600||tokens.length<120)return {...counts,language:null,reason:'SAMPLE_TOO_SHORT'};
 const cyrillic=letters.filter(letter=>/[а-я]/u.test(letter)).length,latin=letters.filter(letter=>/[a-z]/u.test(letter)).length;
 if(cyrillic/letters.length>=0.98&&!/[іїєґўәғқңөұүһ]/u.test(text)){
  const ru=tally(tokens,RU),bg=tally(tokens,BULGARIAN);
  if(bg.distinct>=2&&bg.hits>=3)return {...counts,language:null,reason:'OTHER_CYRILLIC_LANGUAGE'};
  if(ru.distinct>=14&&ru.hits/tokens.length>=0.14)return {...counts,language:'ru',reason:'FUNCTION_WORDS_AND_SCRIPT'};
 }
 if(latin/letters.length>=0.98){
  const en=tally(tokens,EN),other=tally(tokens,OTHER_LATIN);
  if(other.distinct>=3&&other.hits/tokens.length>=0.035)return {...counts,language:null,reason:'OTHER_LATIN_LANGUAGE'};
  if(en.distinct>=16&&en.hits/tokens.length>=0.18)return {...counts,language:'en',reason:'FUNCTION_WORDS_AND_SCRIPT'};
 }
 return {...counts,language:null,reason:'MIXED_OR_UNCERTAIN_LANGUAGE'};
}

function windows(chapter){
 const blocks=chapter.blocks.filter(block=>block.type==='text'&&block.text.trim()).map(block=>block.text),length=blocks.reduce((sum,text)=>sum+text.length+1,0);
 const starts=length<=WINDOW?[0]:[...new Set([0,Math.floor((length-WINDOW)/2),length-WINDOW])];
 return starts.map(offset=>{let position=0,text='';for(const block of blocks){const end=position+block.length+1;if(end>offset&&text.length<WINDOW){const begin=Math.max(0,offset-position);text+=(block+'\n').slice(begin,begin+WINDOW-text.length);}position=end;if(text.length>=WINDOW)break;}return {offset,text};});
}

export async function detectPublicationLanguage(library,books,{read=readPublication,check=checkedPublicationView}={}){
 const evidence={schemaVersion:1,method:TEXT_LANGUAGE_METHOD,scope:'sampled-publication-text',metadataChanged:false,wholeBookLanguageGuaranteed:false,selectedParts:[],readBytes:0,sampledCharacters:0};
 const finish=(status,reason,language=null)=>({status,reason,language,evidence});
 if(!library||!Array.isArray(books)||!books.length||books.length>20000||books.some(book=>!book||typeof book!=='object'))return finish('unconfirmed','SOURCE_LANGUAGE_INPUT');
 evidence.sourceSetSha256=languageSourceSetSha(books);
 const selected=indices(books.length).slice(0,MAX_PARTS).map(index=>books[index]);
 for(const book of selected){
  const files=book?.artifact_manifest?.files;
  if(!HASH.test(book?.publication_sha256??'')||!HASH.test(book?.package_sha256??'')||book.security_state!=='passed'||!Array.isArray(files)||!files.length||files.length>201||files.some(file=>!Number.isSafeInteger(file.bytes)||file.bytes<1))return finish('blocked','SOURCE_LANGUAGE_INTEGRITY');
  evidence.readBytes+=files.reduce((sum,file)=>sum+file.bytes,0);
 }
 if(evidence.readBytes>MAX_READ_BYTES)return finish('unconfirmed','SOURCE_LANGUAGE_READ_BUDGET');
 let language=null;
 try{
  for(const book of selected){
   const loaded=await read(library,book);check(book,loaded.content);
   if(loaded.content.title!==book.title||loaded.content.author!==book.author||loaded.content.language!==book.language)return finish('blocked','SOURCE_LANGUAGE_INTEGRITY');
   const part={publicationId:book.id,publicationSha256:book.publication_sha256,packageSha256:book.package_sha256,samples:[]};evidence.selectedParts.push(part);
   for(const chapterIndex of indices(loaded.content.chapters.length).slice(0,MAX_CHAPTERS))for(const sample of windows(loaded.content.chapters[chapterIndex])){
    const detected=detectTextLanguage(sample.text);evidence.sampledCharacters+=sample.text.length;
    part.samples.push({chapterIndex,offset:sample.offset,sha256:sha(sample.text),...detected});
    if(!detected.language)return finish('unconfirmed',detected.reason);
    if(language&&language!==detected.language)return finish('unconfirmed','SOURCE_LANGUAGE_SAMPLES_DISAGREE');
    language=detected.language;
   }
  }
 }catch{return finish('blocked','SOURCE_LANGUAGE_INTEGRITY');}
 const declared=new Set(books.map(book=>(book.language||'und').toLowerCase().split('-')[0]).filter(value=>value!=='und'));
 if(!language||declared.size>1||declared.size===1&&!declared.has(language))return finish('unconfirmed','SOURCE_LANGUAGE_METADATA_CONFLICT');
 return finish('detected','BOUNDED_TEXT_LANGUAGE',language);
}
