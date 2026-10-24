import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,canonicalJson} from '../server/publication-model.mjs';
import {validateBook,validateDerivation} from '../server/publication-files.mjs';
import {splitDerivedText,makeDerivedPlan,sourceUnit,translatedBooks} from '../server/derived-plan.mjs';
import {validateDerivedText,validateDerivedWav,storeDerivedSegment,readDerivedSegment,writeDerivedManifest,readDerivedManifest} from '../server/derived-files.mjs';

const HASH='a'.repeat(64),RECIPE='b'.repeat(64),PROFILE='c'.repeat(64);
const source={sha256:HASH,parts:[{id:randomUUID()}]};
function book(blocks=[{id:'b-one',type:'paragraph',text:'Original 😀 line.\n\nSecond line.'}]){
 return {title:'Original title',author:'Synthetic author',language:'en',assets:{},chapters:[{title:'Chapter',blocks:[{type:'text',text:'Legacy representation.'}]}],structure:{schemaVersion:2,warnings:[],chapters:[{id:'c-one',revision:1,title:'Chapter',blocks}]}};
}
function wav(){
 const frames=2205,data=Buffer.alloc(frames*2),raw=Buffer.alloc(44+data.length);
 for(let i=0;i<frames;i++)data.writeInt16LE(Math.round(Math.sin(i/16)*1000),i*2);
 raw.write('RIFF');raw.writeUInt32LE(raw.length-8,4);raw.write('WAVEfmt ',8);raw.writeUInt32LE(16,16);raw.writeUInt16LE(1,20);raw.writeUInt16LE(1,22);raw.writeUInt32LE(22050,24);raw.writeUInt32LE(44100,28);raw.writeUInt16LE(2,32);raw.writeUInt16LE(16,34);raw.write('data',36);raw.writeUInt32LE(data.length,40);data.copy(raw,44);return raw;
}
test('segmentation covers every Unicode code point and whitespace without splitting surrogate pairs',()=>{
 const text=('  line 😀 e\u0301 '.repeat(120))+'END';
 const units=splitDerivedText(text,50);
 assert.equal(units.map(x=>x.text).join(''),text);let cursor=0;
 for(const unit of units){assert.equal(unit.start,cursor);assert.equal(unit.end-unit.start,Array.from(unit.text).length);assert.ok(unit.text.isWellFormed());assert.ok(unit.end-unit.start<=50);cursor=unit.end;}
 assert.equal(cursor,Array.from(text).length);
});
test('source hash binds the exact source unit rather than title or model label',()=>{
 const original=book(),plan=makeDerivedPlan(source,[original],'translation').manifest;
 const unit=plan.segments.find(x=>x.blockIndex===0);
 assert.equal(sourceUnit([original],unit),'Original 😀 line.\n\nSecond line.');
 const changed=structuredClone(original);changed.structure.chapters[0].blocks[0].text+='!';
 // Change within the pinned slice, not an unrelated trailing character.
 changed.structure.chapters[0].blocks[0].text='Changed!'+changed.structure.chapters[0].blocks[0].text;
 assert.throws(()=>sourceUnit([changed],unit),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});
});
test('translation preserves original bytes, stable block IDs and footnote references; omitted emphasis is explicit',()=>{
 const original=book([{id:'b-one',type:'paragraph',text:'Original prose.',spans:[{start:0,end:8,kind:'strong'}]},{id:'b-note',type:'footnote',text:'Original note.',referenceId:'b-one'}]);
 const before=canonicalJson(original),plan=makeDerivedPlan(source,[original],'translation').manifest;
 const result=translatedBooks(source,[original],plan,plan.segments.map(x=>Buffer.from(x.blockIndex===-1?'Глава':x.blockIndex===0?'Перевод текста.':'Перевод примечания.')))[0];
 assert.equal(canonicalJson(original),before);assert.equal(result.language,'ru');assert.deepEqual(result.structure.chapters[0].blocks.map(x=>x.id),['b-one','b-note']);assert.equal(result.structure.chapters[0].blocks[1].referenceId,'b-one');assert.equal(result.structure.chapters[0].blocks[0].spans,undefined);
 assert.ok(result.structure.warnings.includes('MACHINE_TRANSLATION_DRAFT'));assert.ok(result.structure.warnings.includes('MACHINE_TRANSLATION_INLINE_FORMATTING_OMITTED'));
});
test('different recipes keep identical visible translations as separate packages with inert exact provenance',()=>{
 const original=book(),before=canonicalJson(original),plan=makeDerivedPlan(source,[original],'translation').manifest;
 const outputs=plan.segments.map(unit=>Buffer.from(unit.blockIndex===-1?'Глава':'Одинаковый перевод.'));
 const provenance={schemaVersion:1,kind:'machine-translation',quality:'machine-draft',sourceSha256:HASH,recipeSha256:RECIPE,jobId:randomUUID()};
 const a=translatedBooks(source,[original],plan,outputs,provenance)[0],b=translatedBooks(source,[original],plan,outputs,{...provenance,recipeSha256:PROFILE,jobId:randomUUID()})[0];
 validateBook(a);validateBook(b);
 assert.equal(a.title,b.title);assert.deepEqual(a.chapters,b.chapters);assert.deepEqual(a.structure,b.structure);assert.notEqual(sha256(Buffer.from(JSON.stringify(a))),sha256(Buffer.from(JSON.stringify(b))));
 const again=translatedBooks(source,[original],plan,outputs,provenance)[0];assert.equal(JSON.stringify(again),JSON.stringify(a));assert.equal(canonicalJson(original),before);
 provenance.quality='changed-after-copy';assert.equal(a.derivation.quality,'machine-draft');
});
test('derivation metadata cannot inject authority, paths, unknown fields or a mismatched source',()=>{
 const meta={schemaVersion:1,kind:'machine-translation',quality:'machine-draft',sourceSha256:HASH,recipeSha256:RECIPE,jobId:randomUUID()};
 validateDerivation(meta);
 for(const mutation of [{role:'owner'},{path:'../outside'},{schemaVersion:true},{jobId:'../../invalid'},{recipeSha256:'A'.repeat(64)},{quality:'human-approved'},{sourceSha256:null}])assert.throws(()=>validateDerivation({...meta,...mutation}),{code:'PUBLICATION_INTEGRITY'});
 const original=book(),plan=makeDerivedPlan(source,[original],'translation').manifest;
 assert.throws(()=>translatedBooks(source,[original],plan,plan.segments.map(()=>Buffer.from('Текст')),{...meta,sourceSha256:'f'.repeat(64)}),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});
});
test('tables, ruby and inline links reject unsupported transforms before generating any plan',()=>{
 for(const blocks of [[{id:'b-table',type:'table',text:'Grid',rows:[['A']]}],[{id:'b-ruby',type:'ruby',text:'字'}],[{id:'b-link',type:'paragraph',text:'Link',spans:[{start:0,end:4,kind:'link',target:'b-link'}]}]])assert.throws(()=>makeDerivedPlan(source,[book(blocks)],'translation'),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});
});
test('invalid UTF-8, controls, empty text and oversized translations fail closed',()=>{
 for(const bytes of [Buffer.from([0xff]),Buffer.from(' \t'),Buffer.from('bad\u0000text'),Buffer.alloc(32769,65)])assert.throws(()=>validateDerivedText(bytes),{code:'DERIVED_INTEGRITY'});
 assert.equal(validateDerivedText(Buffer.from('Строка\n\tтекст')),'Строка\n\tтекст');
});
test('WAV validates actual lengths/PCM and rejects silence, clipping and unexpected chunks',()=>{
 const valid=wav(),pcm=validateDerivedWav(valid);assert.equal(pcm.frames,2205);assert.equal(pcm.durationSeconds,0.1);
 const corrupt=Buffer.from(valid);corrupt.writeUInt32LE(0xffffffff,40);
 const silent=Buffer.from(valid);silent.fill(0,44);
 const clipped=Buffer.from(valid);for(let i=44;i<clipped.length;i+=2)clipped.writeInt16LE(32767,i);
 const foreign=Buffer.from(valid);foreign.write('JUNK',36);
 for(const raw of [corrupt,silent,clipped,foreign,valid.subarray(0,valid.length-2)])assert.throws(()=>validateDerivedWav(raw),{code:'DERIVED_INTEGRITY'});
});
test('checkpoint files and final manifests are immutable, checksummed, and bound to job/attempt',async()=>{
 const parent=path.resolve(process.env.DERIVED_TEST_ROOT||'.local/test-results/derived-safety-files');await fs.mkdir(parent,{recursive:true});
 const root=await fs.mkdtemp(path.join(parent,'owned-')),claim={id:randomUUID(),attempt_token:randomUUID(),kind:'translation',recipe_sha256:RECIPE};
 try{
  const raw=Buffer.from('Проверенный технический пример.'),manifest=await storeDerivedSegment(root,claim,0,raw,{inputSha256:HASH,profileSha256:PROFILE,scanVersion:'ClamAV 1.0/synthetic'});
  assert.ok((await readDerivedSegment(root,claim.id,manifest)).equals(raw));
  for(const mutation of [{file:{...manifest.file,path:'../outside.txt'}},{jobId:randomUUID()},{inputSha256:'bad'},{scan:{...manifest.scan,sha256:'f'.repeat(64)}}])await assert.rejects(()=>readDerivedSegment(root,claim.id,{...manifest,...mutation}),{code:'DERIVED_INTEGRITY'});
  await assert.rejects(()=>storeDerivedSegment(root,claim,0,Buffer.from('Другой результат.'),{inputSha256:HASH,profileSha256:PROFILE,scanVersion:'ClamAV synthetic'}),error=>['DERIVED_INTEGRITY','PUBLICATION_INTEGRITY'].includes(error.code)&&error.status===423);
  assert.ok((await readDerivedSegment(root,claim.id,manifest)).equals(raw));
  const final={schemaVersion:1,jobId:claim.id,kind:'translation',sourceSha256:HASH,recipeSha256:RECIPE,quality:'machine-draft',segments:[manifest],publicationIds:[randomUUID()]},result=await writeDerivedManifest(root,claim.id,final);
  assert.equal((await readDerivedManifest(root,{...result,job_id:claim.id})).manifest.segments[0].file.sha256,sha256(raw));
  const filename=path.join(root,'derived',claim.id,manifest.file.path);await fs.writeFile(filename,Buffer.from('Подмена'));
  await assert.rejects(()=>readDerivedSegment(root,claim.id,manifest),{code:'DERIVED_INTEGRITY'});
 }finally{
  assert.ok(root.startsWith(parent+path.sep));await fs.rm(root,{recursive:true,force:true});
 }
});
