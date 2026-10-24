import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256,structureFor} from '../server/publication-model.mjs';
import {makeDerivedPlan} from '../server/derived-plan.mjs';
import {PACKED_AUDIO_SEGMENTATION,makePackedAudioPlan,makePackedAudioPlanStreaming,packedAudioSourceUnit} from '../server/derived-audio-plan.mjs';

const book=(texts,title='Глава')=>({title:'Оригинал',author:'Автор',language:'ru',assets:{},chapters:[{title,blocks:texts.map(text=>({type:'text',text}))}]});
const source=count=>({sha256:'a'.repeat(64),parts:Array.from({length:count},()=>({id:randomUUID()}))});
function coverage(contents,plan){
 const slices=new Map();
 for(const unit of plan.manifest.segments){
  const text=packedAudioSourceUnit(contents,unit);assert.ok(Array.from(text).length<=700);assert.equal(sha256(Buffer.from(text)),unit.sourceSha256);
  for(const range of unit.ranges){const key=`${unit.partIndex}|${unit.chapterIndex}|${range.blockIndex}`,list=slices.get(key)||[];list.push(range);slices.set(key,list);}
 }
 for(const [p,content]of contents.entries())for(const [c,chapter]of structureFor(content).chapters.entries())for(const [b,text]of [[-1,chapter.title],...chapter.blocks.map((block,index)=>[index,block.text])]){
  const ranges=slices.get(`${p}|${c}|${b}`)||[];if(!text.trim()){assert.equal(ranges.length,0);continue;}
  const chars=Array.from(text);assert.equal(chars.slice(0,ranges[0].start).join('').trim(),'');assert.equal(chars.slice(ranges.at(-1).end).join('').trim(),'');for(let n=1;n<ranges.length;n++){assert.ok(ranges[n].start>=ranges[n-1].end);assert.equal(chars.slice(ranges[n-1].end,ranges[n].start).join('').trim(),'');}
 }
}
test('audio range packing groups paragraphs, preserves originals and pins a separate revision',()=>{
 const contents=[book(['Первый абзац.','Второй 😀 абзац.','Третий абзац.'])],before=canonicalJson(contents),src=source(1),plan=makePackedAudioPlan(src,contents);
 assert.equal(plan.segments,1);assert.equal(plan.manifest.segmentationRevision,PACKED_AUDIO_SEGMENTATION);assert.equal(packedAudioSourceUnit(contents,plan.manifest.segments[0]),'Глава\n\nПервый абзац.\n\nВторой 😀 абзац.\n\nТретий абзац.');assert.equal(canonicalJson(contents),before);coverage(contents,plan);
 const old=makeDerivedPlan(src,contents,'audio');assert.equal(old.segments,4);assert.equal(old.manifest.segmentationRevision,'derived-unicode-v1');assert.notEqual(old.sha256,plan.sha256);
});
test('whole and streaming plans are identical, independently hash-pinned and chapter-local',async()=>{
 const contents=[book(['А'.repeat(1700),' С пробелами. '.repeat(100)]),{...book(['Б']),chapters:[...book(['Б']).chapters,...book(['В']).chapters]}],src=source(2),reads=[],whole=makePackedAudioPlan(src,contents),streamed=await makePackedAudioPlanStreaming(src,async index=>{reads.push(index);return contents[index];});
 assert.deepEqual(reads,[0,1]);assert.deepEqual(streamed,whole);assert.equal(whole.sha256,sha256(Buffer.from(canonicalJson(whole.manifest))));coverage(contents,whole);
 assert.equal(new Set(whole.manifest.segments.map(unit=>unit.id)).size,whole.segments);
});
test('Unicode, whitespace, long blocks and many tiny paragraphs are covered exactly once',()=>{
 const contents=[book(['  😀 слово '.repeat(150),'\n\t','x'.repeat(710),...Array.from({length:1000},(_,index)=>String(index))],'😀 Заголовок')],plan=makePackedAudioPlan(source(1),contents);coverage(contents,plan);assert.ok(plan.segments<30);
});
test('sentence seams are preferred when available without losing source offsets',()=>{
 const text='А'.repeat(390)+'. '+'Б'.repeat(400),contents=[book([text],'')],plan=makePackedAudioPlan(source(1),contents);coverage(contents,plan);assert.equal(packedAudioSourceUnit(contents,plan.manifest.segments[0]),'А'.repeat(390)+'. ');
});
test('very long whitespace runs never create silent-only inference segments or lose spoken text',()=>{
 const contents=[book([' '.repeat(1500)+'Первое слово.'+' '.repeat(1600)+'Последнее слово.'+' '.repeat(1500)],'')],plan=makePackedAudioPlan(source(1),contents);coverage(contents,plan);
 assert.ok(plan.manifest.segments.every(unit=>packedAudioSourceUnit(contents,unit).trim()));
});
test('changed, reordered, oversized and malformed range locators fail closed',()=>{
 const contents=[book(['Первый абзац.','Второй абзац.'])],unit=makePackedAudioPlan(source(1),contents).manifest.segments[0];
 const changed=structuredClone(contents);changed[0].chapters[0].blocks[0].text='Другой текст.';assert.throws(()=>packedAudioSourceUnit(changed,unit),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});
 const mutations=[value=>value.ranges.reverse(),value=>value.ranges[0].end=999,value=>value.ranges[0].start=-1,value=>value.ranges[0].sha256='b'.repeat(64),value=>value.ranges[0].extra=true,value=>value.sourceSha256='b'.repeat(64),value=>value.partIndex=-1,value=>value.chapterIndex=999,value=>value.ranges=[]];
 for(const mutate of mutations){const value=structuredClone(unit);mutate(value);assert.throws(()=>packedAudioSourceUnit(contents,value),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});}
});
test('unsupported structures, invalid source identities and empty narration reject before inference',()=>{
 const content=book(['Table']);content.structure={schemaVersion:2,warnings:[],chapters:[{id:'c-0',revision:1,title:'Глава',blocks:[{id:'b-0',type:'table',text:'Table',rows:[['Value']]}]}]};
 assert.throws(()=>makePackedAudioPlan(source(1),[content]),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});
 assert.throws(()=>makePackedAudioPlan(source(1),[book(['\n'],'')]),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});
 for(const src of [null,{...source(1),sha256:'bad'},{...source(1),parts:[{id:'bad'}]}])assert.throws(()=>makePackedAudioPlan(src,[book(['Текст'])]),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});
});
