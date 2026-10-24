/** Public-safe Warriors download report from LOCAL snapshots only.
 * No phone, browser, bridge, network or download operation exists in this file.
 * node scripts/report-warriors-downloads.mjs --plan
 * node scripts/report-warriors-downloads.mjs --state PRIVATE_STATE.json
 *   --progress PRIVATE_PROGRESS.json --output docs/gargantua/WARRIORS_DOWNLOAD_STATUS.json
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const EXPECTED_WARRIORS_UNITS=116;
export const REPORT_SOURCE_IDS=Object.freeze(['libcat','litlife','ranobelib','ranobeme','ranobehub','wikisource','gutenberg','merged','catalog']);
const sourceSet=new Set(REPORT_SOURCE_IDS),kinds=new Set(['main','super','novella','novella-collection','manga','guide','graphic-adaptation']);
const nativeStatuses=new Set(['queued','downloading','waiting','paused','complete','partial','error']);
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const editionKey=value=>value.source+':'+value.id;
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=50000?value:null;
const unsafeText=/https?:\/\/|\b(?:[a-z0-9-]+\.)+ts\.net\b|\b(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)\b|[a-z]:[\\/]|\\|\/(?:users|home|sdcard|storage|data)\/|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/iu;
function publicLabel(value,max=500){if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/u.test(value)||unsafeText.test(value))return null;return value.trim()||null;}
function bibliographyId(value){return typeof value==='string'&&/^wc-[a-z0-9-]{1,150}$/u.test(value)?value:null;}

/** IDs are opaque public catalogue identities, never arbitrary URLs or paths. */
export function publicSourceBookId(source,value){
 if(!sourceSet.has(source)||!['string','number'].includes(typeof value))return null;
 const id=String(value);if(!id||id.length>4096||/[\s\u0000-\u001f\u007f\\?#]/u.test(id)||/https?:|:\/\//iu.test(id))return null;
 if(['litlife','ranobeme','wikisource','gutenberg'].includes(source))return /^[1-9]\d{0,11}$/u.test(id)?id:null;
 if(source==='ranobelib')return /^[1-9]\d{0,11}--[a-z0-9][a-z0-9-]{0,300}$/u.test(id)?id:null;
 if(source==='ranobehub')return /^[1-9]\d{0,11}(?:-[a-z0-9][a-z0-9-]{0,300})?$/u.test(id)?id:null;
 if(source==='merged')return /^[a-f0-9]{8,64}$/u.test(id)?id:null;
 if(source==='catalog')return /^[a-f0-9-]{8,80}$/u.test(id)?id:null;
 if(!/^[a-zA-Z0-9_-]+$/u.test(id))return null;
 try{const decoded=Buffer.from(id,'base64url').toString('utf8');return /^\/knigi\/[a-z0-9/_-]+\.html$/u.test(decoded)&&!decoded.includes('..')&&!decoded.includes('//')?id:null;}catch{return null;}
}
function iso(value){const date=typeof value==='number'?new Date(value):typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/u.test(value)?new Date(value):null;return date&&Number.isFinite(date.valueOf())&&date.getUTCFullYear()>=2000&&date.getUTCFullYear()<=2100?date.toISOString():null;}
function snapshotTime(value,fallback){const embedded=iso(value),observed=iso(fallback);return {at:embedded||observed,source:embedded?'snapshot_timestamp':observed?'local_file_modified_time_fallback':'unknown'};}
function sourceIds(record){const sources=new Set();for(const attempt of Array.isArray(record?.attempts)?record.attempts:[])if(sourceSet.has(attempt?.source))sources.add(attempt.source);return [...sources].sort();}
function searchStatus(record){if(!object(record))return 'not_searched_in_snapshot';if(record.status==='unresolved_source_errors')return 'source_error_in_search_snapshot';if(record.status==='no_confirmed_russian_query')return 'russian_query_unconfirmed';if(record.status==='not_found')return 'no_selection_observed_on_searched_pages';return 'no_selection_in_snapshot';}
function publicMetadata(unit,record){
 const id=bibliographyId(unit.bookId||record?.id);assert(id,'Invalid public bibliography identity');
 const title=publicLabel(record?.canonicalRussianTitle)||publicLabel(unit.title)||publicLabel(record?.englishTitle);assert(title,'Public bibliography title required');
 const kind=kinds.has(record?.kind)?record.kind:kinds.has(unit.kind)?unit.kind:null;assert(kind,'Known bibliography kind required');
 const labels=[...(Array.isArray(unit.queryTitles)?unit.queryTitles:[]),...(Array.isArray(record?.russianSearchTitles)?record.russianSearchTitles:[])];
 const queryTitles=[...new Set(labels.map(value=>publicLabel(value)).filter(Boolean))].slice(0,30);
 return {id,order:Number.isSafeInteger(unit.order)&&unit.order>0?unit.order:null,title,kind,queryTitles};
}
function nativeJobs(progress){if(Array.isArray(progress))return progress;if(object(progress)&&Array.isArray(progress.jobs))return progress.jobs;throw Error('Expected a local native progress snapshot with jobs array');}
function safeJob(job){if(!object(job)||!object(job.book)||!sourceSet.has(job.book.source))return null;const id=publicSourceBookId(job.book.source,job.book.id);return id?{source:job.book.source,id,total:count(job.total),downloaded:count(job.downloaded),failed:count(job.failed),unavailable:count(job.unavailable),status:nativeStatuses.has(job.status)?job.status:'invalid_progress'}:null;}
function observedEdition(selection,metadata,jobs){
 if(!object(selection)||!sourceSet.has(selection.source))return null;
 const id=publicSourceBookId(selection.source,selection.id);if(!id)return null;
 // All exported labels are from the public bibliography. Raw private snapshot
 // titles, queries, error strings, URLs and native job IDs are never copied.
 const result={source:selection.source,id,title:metadata.title,total:count(selection.outlineTotal),downloaded:null,failed:null,unavailable:null,status:'not_observed_in_progress_snapshot'};
 if(result.total===0){result.status='invalid_selection_outline';return result;}
 const candidates=jobs.filter(job=>job.source===result.source&&job.id===result.id),expected=count(selection.outlineTotal),matches=expected&&candidates.length?candidates.filter(job=>job.total===expected):candidates;
 if(!matches.length){if(candidates.length)result.status='outline_mismatch_in_progress_snapshot';return result;}
 if(matches.length!==1){result.status='ambiguous_progress_snapshot';return result;}
 const job=matches[0];if([job.total,job.downloaded,job.failed,job.unavailable].some(value=>value===null)||job.total===0||job.downloaded+job.failed+job.unavailable>job.total||job.status==='invalid_progress'){result.status='invalid_progress_snapshot';return result;}
 return {...result,total:job.total,downloaded:job.downloaded,failed:job.failed,unavailable:job.unavailable,status:job.status};
}
const complete=edition=>Boolean(edition)&&edition.status==='complete'&&edition.total>0&&edition.downloaded===edition.total&&edition.failed===0&&edition.unavailable===0;

/** Construct by whitelist, never clone/spread private snapshot objects. */
export function buildWarriorsDownloadReport({state,progress,readingList,now=new Date(),stateObservedAt,progressObservedAt}={}){
 assert(object(state)&&object(state.records),'State records object required');
 assert(object(readingList)&&Array.isArray(readingList.books)&&Array.isArray(readingList.recommendedFirstReadOrder),'Local public reading list required');
 const generatedAt=iso(now instanceof Date?now.toISOString():now);assert(generatedAt,'Valid report generation time required');
 const records=new Map(readingList.books.map(book=>[book.id,book]));assert(records.size===readingList.books.length,'Duplicate bibliography IDs');
 const inventory=new Map();for(const value of Object.values(state.records))if(object(value)&&bibliographyId(value.bookId)){assert(!inventory.has(value.bookId),'Duplicate state bibliography ID');inventory.set(value.bookId,value);}
 const jobs=nativeJobs(progress).map(safeJob).filter(Boolean),editionRefs=new Map(),invalidSelections=new Set();
 const select=(record,metadata)=>{if(!record?.selected)return null;const edition=observedEdition(record.selected,metadata,jobs);if(!edition){invalidSelections.add(metadata.id);return null;}const identity=editionKey(edition);if(!editionRefs.has(identity))editionRefs.set(identity,new Map());editionRefs.get(identity).set(metadata.id,edition);return edition;};
 const units=[],representation=[],unresolvedSourceErrorUnits=new Set();let directUnits=0,fullyRepresentedFallbackUnits=0,partialFallbackUnits=0;
 for(const unit of readingList.recommendedFirstReadOrder){
  const book=records.get(unit.bookId);assert(book,'Queue unit missing its public record');const metadata=publicMetadata(unit,book),record=inventory.get(metadata.id),selected=select(record,metadata),fallbacks=[];
  let represented=Boolean(selected),status=selected?'selected_edition':searchStatus(record);
  if(selected)directUnits++;
  else if(Array.isArray(unit.fallbackBookIds)&&unit.fallbackBookIds.length){
   assert(new Set(unit.fallbackBookIds).size===unit.fallbackBookIds.length,'Duplicate fallback identity');
   for(const id of unit.fallbackBookIds){const fallback=records.get(id);assert(fallback,'Fallback missing public record');const data=publicMetadata({bookId:id,order:unit.order,title:fallback.canonicalRussianTitle||fallback.englishTitle,queryTitles:fallback.russianSearchTitles},fallback),observed=inventory.get(id),edition=select(observed,data);fallbacks.push({...data,status:edition?'selected_fallback_edition':searchStatus(observed),sourceIds:sourceIds(observed),selected:edition});}
   const chosen=fallbacks.filter(row=>row.selected),distinct=new Set(chosen.map(row=>editionKey(row.selected)));
   represented=chosen.length===fallbacks.length&&distinct.size===fallbacks.length;
   if(represented){status='represented_by_all_fallback_novellas';fullyRepresentedFallbackUnits++;}
   else if(chosen.length){status=distinct.size<chosen.length?'conflicting_fallback_edition_mapping':'partially_represented_by_fallback_novellas';partialFallbackUnits++;}
  }
  if(invalidSelections.has(metadata.id)&&!selected)status='invalid_selection_identity';
  if(!represented&&(record?.status==='unresolved_source_errors'||fallbacks.some(fallback=>!fallback.selected&&fallback.status==='source_error_in_search_snapshot')))unresolvedSourceErrorUnits.add(metadata.id);
  units.push({...metadata,status,sourceIds:sourceIds(record),selected,fallbacks});representation.push(represented);
 }
 assert(new Set(units.map(unit=>unit.id)).size===units.length,'Duplicate reading queue unit');
 const editions=[...editionRefs.values()].map(values=>[...values.values()][0]),duplicates=[...editionRefs.values()].filter(values=>values.size>1).length;
 const representedUnits=representation.filter(Boolean).length,allSelectedEditionsComplete=editions.length>0&&editions.every(complete),sum=field=>editions.reduce((total,edition)=>total+(edition[field]??0),0);
 const selectedStatuses={};for(const edition of editions)selectedStatuses[edition.status]=(selectedStatuses[edition.status]||0)+1;
 const unresolvedSourceErrors=unresolvedSourceErrorUnits.size;
 const stateTime=snapshotTime(state.updatedAt,stateObservedAt),progressTime=snapshotTime(Array.isArray(progress)?undefined:progress.updatedAt,progressObservedAt),age=at=>at?Math.round((Date.parse(generatedAt)-Date.parse(at))/1000):null,progressAge=age(progressTime.at),stateAge=age(stateTime.at);
 return {
  schemaVersion:1,series:'Коты-воители / Warriors',generatedAt,snapshotAt:progressTime.at||stateTime.at,live:false,
  freshness:{stateUpdatedAt:stateTime.at,progressUpdatedAt:progressTime.at,stateTimestampSource:stateTime.source,progressTimestampSource:progressTime.source,stateAgeSeconds:stateAge,progressAgeSeconds:progressAge,staleAfterSeconds:300,progressSnapshotStale:progressAge===null||progressAge>300||progressAge< -60,progressPredatesStateSnapshot:Boolean(progressTime.at&&stateTime.at&&progressTime.at<stateTime.at)},
  summary:{plannedReadingUnits:units.length,referenceReadingUnits:EXPECTED_WARRIORS_UNITS,directlySelectedUnits:directUnits,unitsRepresentedByAllFallbacks:fullyRepresentedFallbackUnits,representedUnits,partiallyRepresentedFallbackUnits:partialFallbackUnits,unrepresentedUnits:units.length-representedUnits,selectedEditions:editions.length,fullyDownloadedSelectedEditions:editions.filter(complete).length,selectedEditionsWithoutCompleteProgress:editions.filter(edition=>!complete(edition)).length,selectedEditionsWithUnknownProgressCounters:editions.filter(edition=>[edition.downloaded,edition.failed,edition.unavailable].some(value=>value===null)).length,selectedEditionStatuses:selectedStatuses,observedTotalSections:sum('total'),observedDownloadedSections:sum('downloaded'),observedFailedSections:sum('failed'),observedUnavailableSections:sum('unavailable'),unitsWithUnresolvedSourceErrors:unresolvedSourceErrors,unitsWithNoSelectionOnSearchedPages:units.filter(unit=>unit.status==='no_selection_observed_on_searched_pages').length,unitsWithUnconfirmedRussianQuery:units.filter(unit=>unit.status==='russian_query_unconfirmed').length,unitsNotSearchedInSnapshot:units.filter(unit=>unit.status==='not_searched_in_snapshot').length,invalidSelectionIdentities:invalidSelections.size,conflictingBibliographyToEditionMappings:duplicates,allSelectedEditionsComplete},
  wholeSeriesComplete:units.length===EXPECTED_WARRIORS_UNITS&&representedUnits===units.length&&allSelectedEditionsComplete&&sum('failed')===0&&sum('unavailable')===0&&invalidSelections.size===0&&duplicates===0&&progressTime.at!==null,
  limitations:[
   'Это датированный снимок локальной очереди и библиотеки, а не живое состояние загрузок.',
   'Поиск клиента проверял первую страницу результатов каждого сохранённого запроса. Отсутствие выбора в этом снимке не доказывает, что книги нет в интернете.',
   'Ошибки источников и неподтверждённые русские переводы указаны отдельно. Английская библиография и русская поисковая подпись не доказывают выход русского издания.',
   'Сборник представлен отдельными новеллами только при наличии всех требуемых новелл; неполный набор не считается полным сборником.',
   'Статус complete требует совпавшего издания и оглавления, положительного total, downloaded=total, failed=0 и unavailable=0. Старое состояние queue не заменяет наблюдение в progress.',
   'Числа разделов описывают сохранённый клиентом материал. Карточка комикса или сохранённые подписи сами по себе не подтверждают полноту изображений.',
   'Названия и поисковые подписи взяты из публичной библиографии. Личные адреса, настройки, тексты, закладки, позиции чтения и исходные сообщения ошибок не копируются.'
  ],units
 };
}

function options(argv){const result=new Map();for(let i=0;i<argv.length;i++){const key=argv[i];assert(/^--(?:state|progress|output|plan)$/u.test(key),'Unknown option');if(key==='--plan'&&(!argv[i+1]||argv[i+1].startsWith('--')))result.set('plan','true');else{assert(argv[i+1]&&!argv[i+1].startsWith('--'),'Option value required');result.set(key.slice(2),argv[++i]);}}return result;}
async function localJson(filename){const stat=await fs.stat(filename);assert(stat.isFile()&&stat.size<=64*1024*1024,'Bounded local JSON input required');return {value:JSON.parse(await fs.readFile(filename,'utf8')),observedAt:stat.mtime.toISOString()};}
export async function reportWarriorsDownloads(argv=process.argv.slice(2)){
 const args=options(argv);if(args.get('plan')==='true'){const plan={localOnly:true,phoneActions:0,networkRequests:0,expectedReadingUnits:EXPECTED_WARRIORS_UNITS,inputs:'Private local state and native progress JSON; public local Warriors reading list.',output:'Whitelist-only bibliographic identities, public source IDs and progress counters. No private snapshots are copied.',completeness:'All116 units represented, all selected editions complete, zero failed/unavailable; partial fallback cannot claim a complete series.'};process.stdout.write(JSON.stringify(plan,null,2)+'\n');return plan;}
 assert(args.get('state')&&args.get('progress'),'--state and --progress are required');
 const root=path.resolve(fileURLToPath(new URL('../',import.meta.url))),[state,progress,reading]=await Promise.all([localJson(path.resolve(args.get('state'))),localJson(path.resolve(args.get('progress'))),localJson(path.join(root,'docs/gargantua/WARRIORS_READING_LIST.json'))]);
 const report=buildWarriorsDownloadReport({state:state.value,progress:progress.value,readingList:reading.value,stateObservedAt:state.observedAt,progressObservedAt:progress.observedAt}),output=path.resolve(args.get('output')||path.join(root,'docs/gargantua/WARRIORS_DOWNLOAD_STATUS.json'));
 assert(![args.get('state'),args.get('progress'),path.join(root,'docs/gargantua/WARRIORS_READING_LIST.json')].map(value=>path.resolve(value)).includes(output),'Output must not overwrite inputs or bibliography');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify({written:true,snapshotAt:report.snapshotAt,selectedEditions:report.summary.selectedEditions,fullyDownloadedSelectedEditions:report.summary.fullyDownloadedSelectedEditions,representedUnits:report.summary.representedUnits,plannedReadingUnits:report.summary.plannedReadingUnits,wholeSeriesComplete:report.wholeSeriesComplete,staleSnapshot:report.freshness.progressSnapshotStale})+'\n');return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{await reportWarriorsDownloads();}catch{process.stderr.write('Report generation failed. Check the local JSON inputs and supported command options.\n');process.exitCode=1;}}
