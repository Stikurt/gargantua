/** Read-only capacity estimate. This never queues work or opens the server DB. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalJson,sha256,structureFor} from '../server/publication-model.mjs';
import {validateBook} from '../server/publication-files.mjs';
import {splitDerivedText,assertDerivedManifestBudget} from '../server/derived-plan.mjs';
import {makePackedAudioPlan} from '../server/derived-audio-plan.mjs';
import {derivedUuid} from '../server/derived-files.mjs';

const GiB=1024**3;
const fail=message=>Object.assign(new Error(message),{code:'NARRATION_PREFLIGHT_INPUT'});
const estimate=(characters,rate)=>characters/rate;

export function analyzeNarration(parts,{freeBytes=null,charactersPerSecond={low:13,high:18},realTimeFactor=.073,perSegmentOverheadSeconds={low:4,high:12}}={}){
 if(!Array.isArray(parts)||!parts.length||parts.length>20000)throw fail('Expected 1–20000 immutable source parts');
 for(const pair of [charactersPerSecond,perSegmentOverheadSeconds])if(!pair||!Number.isFinite(pair.low)||!Number.isFinite(pair.high)||pair.low<=0||pair.high<pair.low)throw fail('Invalid estimate bounds');
 if(!Number.isFinite(realTimeFactor)||realTimeFactor<=0||freeBytes!==null&&(!Number.isSafeInteger(freeBytes)||freeBytes<0))throw fail('Invalid resource estimate');
 let characters=0,chapters=0,blocks=0,legacySegments=0,packedChapterSimulationSegments=0,unsupportedBlocks=0;
 const sources=[];
 for(const [partIndex,content]of parts.entries()){
  validateBook(content);const structure=structureFor(content);let partCharacters=0;
  for(const chapter of structure.chapters){
   chapters++;const pieces=[chapter.title];
   for(const block of chapter.blocks){blocks++;pieces.push(block.text);if(['table','ruby'].includes(block.type)||block.rows||block.spans?.some(span=>span.kind==='link'))unsupportedBlocks++;}
   for(const text of pieces){partCharacters+=Array.from(text).length;legacySegments+=splitDerivedText(text).filter(unit=>unit.text.trim()).length;}
   // A feasibility simulation only: not the deployed algorithm or a validated
   // locator map. It adds paragraph separators and never crosses a chapter.
   packedChapterSimulationSegments+=splitDerivedText(pieces.join('\n\n')).filter(unit=>unit.text.trim()).length;
  }
  characters+=partCharacters;
  sources.push({partIndex,title:content.title,chapters:structure.chapters.length,characters:partCharacters,contentSha256:sha256(Buffer.from(canonicalJson(content)))});
 }
 const capacities=count=>{
  let serverManifestAdmissible=true;try{assertDerivedManifestBudget({segments:{length:count}},parts.length);}catch{serverManifestAdmissible=false;}
  return {segments:count,serverPlanCountAdmissible:count>=1&&count<=50000,serverManifestAdmissible,clientSegmentCountAdmissible:count<=8192};
 };
 let candidatePackedAudioPlan;
 try{
  const source={sha256:sha256(Buffer.from(canonicalJson(sources))),parts:sources.map(row=>({id:derivedUuid(`narration-preflight|${row.partIndex}|${row.contentSha256}`)}))},plan=makePackedAudioPlan(source,parts),structures=parts.map(structureFor),nonSpeechOrdinals=[];let modelCharacters=0;
  for(const unit of plan.manifest.segments){const chapter=structures[unit.partIndex].chapters[unit.chapterIndex],text=unit.ranges.map(range=>Array.from(range.blockIndex===-1?chapter.title:chapter.blocks[range.blockIndex].text).slice(range.start,range.end).join('')).join('\n\n');modelCharacters+=Array.from(text).length;if(!/[\p{L}\p{N}]/u.test(text))nonSpeechOrdinals.push(unit.ordinal);}
  candidatePackedAudioPlan={status:'PLANNED_ONLY',segmentationRevision:plan.manifest.segmentationRevision,...capacities(plan.segments),manifestCanonicalBytes:Buffer.byteLength(canonicalJson(plan.manifest)),modelInputCharacters:modelCharacters,nonSpeechOnlySegments:{count:nonSpeechOrdinals.length,firstOrdinals:nonSpeechOrdinals.slice(0,100),mayRequireVersionedNarrationNormalization:nonSpeechOrdinals.length>0},sourceIdentityIsPreflightOnly:true,serverRecipeSelectionNotInspected:true};
 }catch(error){candidatePackedAudioPlan={status:'REJECTED_BEFORE_INFERENCE',code:error.code||'NARRATION_PREFLIGHT_PLAN'};}
 const estimatedSegments=candidatePackedAudioPlan.segments??packedChapterSimulationSegments;
 const estimatedCharacters=candidatePackedAudioPlan.modelInputCharacters??characters;
 const duration={low:estimate(estimatedCharacters,charactersPerSecond.high),high:estimate(estimatedCharacters,charactersPerSecond.low)};
 const pcm={low:Math.ceil(duration.low*44100+44*estimatedSegments),high:Math.ceil(duration.high*44100+44*estimatedSegments)};
 const wall=count=>({low:duration.low*realTimeFactor+count*perSegmentOverheadSeconds.low,high:duration.high*realTimeFactor+count*perSegmentOverheadSeconds.high});
 return {schemaVersion:1,readOnly:true,actualInferenceRun:false,capacityAcceptance:false,estimateOnly:true,
  estimatesAreNotMeasuredNovelDuration:true,sources,parts:parts.length,chapters,blocks,characters,unsupportedBlocks,
  legacyV1Segmentation:capacities(legacySegments),deployedSegmentationNotInspected:true,candidatePackedAudioPlan,chapterPackingSimulation:{...capacities(packedChapterSimulationSegments),implemented:false,addsParagraphSeparators:true},
  estimates:{assumptions:{charactersPerSecond,realTimeFactor,perSegmentOverheadSeconds,pcmBytesPerSecond:44100,copies:3},audioDurationSeconds:duration,onePcmCopyBytes:pcm,
   serverClientAndOneBackupBytes:{low:3*pcm.low,high:3*pcm.high},client8GiBQuota:{limitBytes:8*GiB,estimatedLowFits:pcm.low<=8*GiB,estimatedHighFits:pcm.high<=8*GiB},
   legacyV1WallSeconds:wall(legacySegments),packedCandidateWallSeconds:wall(estimatedSegments),chapterPackedSimulationWallSeconds:wall(packedChapterSimulationSegments),
   ...(freeBytes!==null?{freeBytes,estimatedThreeCopiesPlus2GiBReserveFit:3*pcm.high+2*GiB<=freeBytes}:{})},
  caveats:['No speech has been generated or listened to by this preflight.','Characters per second and per-segment overhead are estimates; a real source pilot must refine them.','The stored source hash is canonical JSON; it does not replace the original publication file hash.','chapterPackingSimulation is a count simulation; candidatePackedAudioPlan executes the implemented range planner with preflight-only identities and never queues it.','8 GiB is the total native audio store quota across all books; existing downloaded audio reduces available capacity.','Server output, client output and one backup are three copies; additional retained backups and temporary/spool copies need more space.']};
}

async function main(args){
 const files=[];let output=null,freeBytes=null;
 for(let n=0;n<args.length;n++){
  if(args[n]==='--output'){if(output||!args[n+1])throw fail('One --output path required');output=path.resolve(args[++n]);}
  else if(args[n]==='--free-bytes'){if(freeBytes!==null||!args[n+1]||!/^\d+$/.test(args[n+1]))throw fail('Invalid --free-bytes');freeBytes=Number(args[++n]);}
  else if(args[n].startsWith('--'))throw fail('Unknown option '+args[n]);else files.push(path.resolve(args[n]));
 }
 if(!files.length)throw fail('Usage: node scripts/narration-preflight.mjs part-book.json [...] [--output report.json] [--free-bytes N]');
 const parts=[];let totalBytes=0;
 for(const filename of files){const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>32*1024*1024)throw fail('Source must be a bounded ordinary book JSON file');totalBytes+=stat.size;if(totalBytes>128*1024*1024)throw fail('Source set exceeds the 128 MiB preflight memory budget');const raw=await fs.readFile(filename);if(raw.length!==stat.size)throw fail('Source changed while being read');parts.push(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));}
 const report=analyzeNarration(parts,{freeBytes}),raw=JSON.stringify(report,null,2)+'\n';
 if(output){await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,raw,{flag:'wx'});}
 process.stdout.write(raw);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{process.stderr.write(String(error.code||'NARRATION_PREFLIGHT')+': '+error.message+'\n');process.exitCode=1;});
