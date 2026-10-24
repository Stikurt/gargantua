import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeNarration} from '../scripts/narration-preflight.mjs';

const book=(chapters=2,blocks=3,text='Пример 😀 текста.')=>({title:'Оригинал',author:'Автор',language:'ru',assets:{},chapters:Array.from({length:chapters},(_,i)=>({title:'Глава '+(i+1),blocks:Array.from({length:blocks},()=>({type:'text',text}))}))});
test('narration preflight is read-only and counts Unicode code points without changing source',()=>{
 const content=book(),before=JSON.stringify(content),report=analyzeNarration([content]);
 assert.equal(JSON.stringify(content),before);assert.equal(report.actualInferenceRun,false);assert.equal(report.capacityAcceptance,false);assert.equal(report.chapters,2);assert.equal(report.blocks,6);
 assert.equal(report.characters,2*Array.from('Глава 1').length+6*Array.from('Пример 😀 текста.').length);
 assert.equal(report.legacyV1Segmentation.segments,8);assert.equal(report.chapterPackingSimulation.segments,2);assert.equal(report.chapterPackingSimulation.implemented,false);assert.equal(report.candidatePackedAudioPlan.segments,2);assert.equal(report.candidatePackedAudioPlan.sourceIdentityIsPreflightOnly,true);
});
test('chapter packing simulation never crosses chapter or source publication boundaries',()=>{
 const report=analyzeNarration([book(4,1,'А'),book(3,1,'Б')]);
 assert.equal(report.parts,2);assert.equal(report.chapterPackingSimulation.segments,7);assert.equal(report.sources[1].partIndex,1);assert.equal(report.sources[0].contentSha256.length,64);
});
test('preflight exposes server manifest and client segment barriers before inference',()=>{
 const report=analyzeNarration([book(1,9000,'Абзац.')]);
 assert.equal(report.legacyV1Segmentation.segments,9001);assert.equal(report.legacyV1Segmentation.serverManifestAdmissible,false);assert.equal(report.legacyV1Segmentation.clientSegmentCountAdmissible,false);assert.equal(report.chapterPackingSimulation.serverManifestAdmissible,true);assert.equal(report.candidatePackedAudioPlan.serverManifestAdmissible,true);
});
test('PCM estimates include WAV headers and three copies with reserve',()=>{
 const report=analyzeNarration([book()],{freeBytes:1});
 assert.equal(report.estimates.onePcmCopyBytes.low,Math.ceil(report.estimates.audioDurationSeconds.low*44100+44*report.candidatePackedAudioPlan.segments));
 assert.equal(report.estimates.serverClientAndOneBackupBytes.high,3*report.estimates.onePcmCopyBytes.high);assert.equal(report.estimates.estimatedThreeCopiesPlus2GiBReserveFit,false);
});
test('unsupported structures are reported and malformed sources or estimates fail closed',()=>{
 const content=book(1,1);content.structure={schemaVersion:2,warnings:[],chapters:[{id:'c-0',revision:1,title:'Заголовок',blocks:[{id:'b-0',type:'table',text:'Таблица',rows:[['a']]}]}]};
 assert.equal(analyzeNarration([content]).unsupportedBlocks,1);
 for(const parts of [[],[{}],null])assert.throws(()=>analyzeNarration(parts));
 for(const options of [{freeBytes:-1},{freeBytes:NaN},{realTimeFactor:0},{charactersPerSecond:{low:0,high:10}},{perSegmentOverheadSeconds:{low:5,high:1}}])assert.throws(()=>analyzeNarration([book()],options),{code:'NARRATION_PREFLIGHT_INPUT'});
});
test('punctuation-only packed chunks are flagged before actual synthesis without silently normalizing them',()=>{
 const report=analyzeNarration([book(1,1,'***')]);assert.equal(report.candidatePackedAudioPlan.nonSpeechOnlySegments.count,0);
 const content=book(1,1,'***');content.chapters[0].title='';const flagged=analyzeNarration([content]);assert.equal(flagged.candidatePackedAudioPlan.nonSpeechOnlySegments.count,1);assert.deepEqual(flagged.candidatePackedAudioPlan.nonSpeechOnlySegments.firstOrdinals,[0]);assert.equal(flagged.candidatePackedAudioPlan.nonSpeechOnlySegments.mayRequireVersionedNarrationNormalization,true);
});
