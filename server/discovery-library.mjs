import {createHash} from 'node:crypto';
import {canonicalJson} from './publication-model.mjs';
import {WHOLE_PUBLICATION_METADATA_SQL,wholeLibraryPublication} from './discovery-whole-publication.mjs';

const norm=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const person=value=>norm(value).split(' ').sort().join(' ');
const digest=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
const allowed=(book,input)=>book.language===input.language||input.allowOriginal&&/^[a-z]{2}$/.test(book.language??'');

export function localDiscoveryCandidate(book,input,evidence='exact-local-title'){
 return {id:`dsc_${digest(`library:${book.id}`)}`,identity:{provider:'library',remoteId:book.id},kind:'book',bookId:book.id,title:book.title,authors:book.author?[{name:book.author,remoteId:null}]:[],languages:book.language?[book.language]:[],availability:'library',eligibleForAcquisition:Boolean(allowed(book,input)),matchEvidence:evidence,sourceBinding:{provider:'library',remoteId:book.id,access:'accepted-publication'},downloadSelections:[]};
}

/** Reuse accepted files, never infer that identically titled works are one work.
 * The caller supplies server-owned title/author context, not request URLs.
 * No file is considered ready until completeDiscoveryFromLibrary verifies it.
 */
export async function findLocalDiscoveryPlan(pool,input,{titles,authors=[],requireAuthor=false,context=null}={}){
 if(!Array.isArray(titles)||!titles.length||requireAuthor&&!authors.length)return null;
 const aliases=new Set(titles.map(norm)),people=new Set(authors.map(person));
 const rows=(await pool.query(`SELECT b.id,b.title,b.author,b.language,b.chapter_count,b.work_id,b.expression_id,b.edition_id,b.publication_sha256,b.package_sha256,${WHOLE_PUBLICATION_METADATA_SQL} FROM books b WHERE b.security_state='passed' ORDER BY b.created_at DESC LIMIT 1001`)).rows;
 // A partial scan cannot establish a unique match. Fall back to source search.
 if(rows.length>1000)return null;
 const matches=[];for(const book of rows)if(aliases.has(norm(book.title))&&(!people.size||people.has(person(book.author)))&&(await wholeLibraryPublication(pool,book)).whole)matches.push(book);
 if(!matches.length)return null;
 const candidates=matches.slice(0,20).map(book=>localDiscoveryCandidate(book,input,people.size?'exact-local-title-and-author':'exact-local-title'));
 const hasMore=matches.length>candidates.length,auto=!hasMore&&matches.length===1&&candidates[0].eligibleForAcquisition;
 return {query:input.query,intent:'book',language:input.language,allowOriginal:input.allowOriginal,metadataOnly:true,candidates,clarifications:auto?[]:[{code:'CHOOSE_LIBRARY_EDITION',message:hasMore?'Найдено больше 20 локальных версий. Уточните название и автора.':'Выберите уже сохранённую языковую версию или разрешите оригинал.',candidateIds:candidates.map(book=>book.id)}],providerErrors:[],hasMore,requestCount:0,cacheHits:0,status:auto?'resolved':'needs_clarification',selectedCandidateId:auto?candidates[0].id:null,nextAction:auto?'acquire':'none',plan:null,...(context?{resolutionContext:context}:{})};
}

/** Exact Gutenberg identity + persisted successful content verification only.
 * A bare title, work grouping, user-supplied source ID or source URL is not proof.
 * Immutable bytes are verified on the subsequent acquisition claim as usual.
 */
export async function reuseDiscoveredSources(pool,plan,input){
 if(!Array.isArray(plan?.candidates))return plan;
 const replacements=new Map();
 for(const candidate of plan.candidates){
  if(candidate.identity?.provider!=='gutendex'||candidate.availability!=='fetchable'||!candidate.eligibleForAcquisition||candidate.conflictingMetadata||candidate.identityEvidenceIncomplete||candidate.blockedReason)continue;
  const selection=candidate.downloadSelections?.find(item=>item.extension==='epub')??candidate.downloadSelections?.find(item=>item.extension==='txt');
  if(!selection?.expected||selection.expected.provider!=='gutenberg'||selection.expected.remoteId!==candidate.identity.remoteId)continue;
  const rows=(await pool.query(`SELECT DISTINCT b.id,b.title,b.author,b.language,b.chapter_count,b.work_id,b.expression_id,b.edition_id,b.publication_sha256,b.package_sha256,${WHOLE_PUBLICATION_METADATA_SQL} FROM imports i JOIN books b ON b.id=i.book_id
   WHERE i.status='completed' AND b.security_state='passed' AND b.artifact_manifest IS NOT NULL AND b.publication_manifest IS NOT NULL
   AND i.options#>'{discovery,expected}'=$1::jsonb
   AND i.report#>>'{identityVerification,verified}'='true'
   AND i.report#>>'{identityVerification,inputSha256}'=i.report->>'sha256'
   AND i.report->>'sha256' ~ '^[a-f0-9]{64}$'
   ORDER BY b.id LIMIT 2`,[canonicalJson(selection.expected)])).rows;
  if(rows.length===1&&allowed(rows[0],input)&&(await wholeLibraryPublication(pool,rows[0])).whole)replacements.set(candidate.id,{...localDiscoveryCandidate(rows[0],input,'verified-gutenberg-source-and-metadata'),matchedSource:{provider:'gutenberg',remoteId:candidate.identity.remoteId}});
 }
 if(!replacements.size)return plan;
 const result={...plan,candidates:[],clarifications:(plan.clarifications??[]).map(item=>({...item,candidateIds:[...new Set((item.candidateIds??[]).map(id=>replacements.get(id)?.id??id))]}))};
 const seen=new Set();for(const candidate of plan.candidates){const next=replacements.get(candidate.id)??candidate;if(!seen.has(next.id)){seen.add(next.id);result.candidates.push(next);}}
 result.selectedCandidateId=replacements.get(plan.selectedCandidateId)?.id??plan.selectedCandidateId;
 const ref=id=>replacements.get(id)?.id??id,itemRef=item=>({...item,candidateId:ref(item.candidateId)});
 if(result.plan)result.plan={...result.plan,...(result.plan.items?{items:result.plan.items.map(itemRef)}:{}),...(result.plan.suggestedCandidateIds?{suggestedCandidateIds:[...new Set(result.plan.suggestedCandidateIds.map(ref))]}:{}),...(result.plan.seriesVariants?{seriesVariants:result.plan.seriesVariants.map(group=>({...group,items:group.items.map(itemRef)}))}:{})};
 // A provider-to-provider hint is no longer a relation between two displayed
 // source cards after one was replaced by an accepted local publication.
 if(result.identityLinks)result.identityLinks=result.identityLinks.filter(link=>link.candidateIds.every(id=>seen.has(id)));
 return result;
}
