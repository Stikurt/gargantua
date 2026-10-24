import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {canonicalJson,sha256,structureFor} from '../server/publication-model.mjs';
import {makeDerivedPlan,makeDerivedPlanStreaming,translatedBooks,sourceUnit} from '../server/derived-plan.mjs';
import {makePackedAudioPlan,makePackedAudioPlanStreaming,packedAudioSourceUnit} from '../server/derived-audio-plan.mjs';
import {makeChapterSelection} from '../server/derived-selection.mjs';
const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/derived-selection-v2.json',import.meta.url),'utf8'));

test('pinned cross-part v2 fixture reconstructs exact plans and compact translated publications',async()=>{
 const {source,contents,translationPlan,audioPlan,outputs,translated}=fixture,before=canonicalJson(contents),reads=[];
 assert.equal(sha256(Buffer.from(canonicalJson(source.manifest))),source.sha256);
 assert.deepEqual(makeDerivedPlan(source,contents,'translation'),translationPlan);assert.deepEqual(makePackedAudioPlan(source,contents),audioPlan);
 assert.deepEqual(await makeDerivedPlanStreaming(source,async p=>{reads.push(p);return contents[p];},'translation'),translationPlan);assert.deepEqual(reads,[1,2]);
 assert.deepEqual(await makePackedAudioPlanStreaming(source,async p=>contents[p]),audioPlan);
 assert.deepEqual(translatedBooks(source,contents,translationPlan.manifest,outputs),translated);assert.deepEqual(translated.map(book=>book.structure.chapters.map(c=>c.id)),[['c-2','c-3'],['c-0']]);
 assert.equal(canonicalJson(contents),before);assert.ok(translationPlan.manifest.segments.every(u=>u.partIndex>0));assert.ok(audioPlan.manifest.segments.every(u=>u.partIndex>0));
 for(const unit of translationPlan.manifest.segments)assert.equal(sha256(Buffer.from(sourceUnit(contents,unit))),unit.sourceSha256);
 for(const unit of audioPlan.manifest.segments)assert.equal(sha256(Buffer.from(packedAudioSourceUnit(contents,unit))),unit.sourceSha256);
});
test('local finalization of a selected later part keeps physical chapter IDs and global title coverage',()=>{
 const {source,contents,translationPlan,outputs,translated}=fixture;
 const units=translationPlan.manifest.segments.filter(u=>u.partIndex===1),localOutputs=units.map(u=>outputs[u.ordinal]),local=translatedBooks({...source,parts:[source.parts[1]]},[contents[1]],{segments:units.map(u=>({...u,partIndex:0}))},localOutputs);
 assert.deepEqual(local,[translated[0]]);assert.match(local[0].title,/главы 6–7/u);
});
test('cross-batch footnotes reject before inference; in-batch references keep their target',()=>{
 const contents=structuredClone(fixture.contents),source=structuredClone(fixture.source),book=contents[1];book.structure=structuredClone(structureFor(book));book.structure.chapters[2].blocks[0].referenceId=book.structure.chapters[0].blocks[0].id;
 assert.throws(()=>makeDerivedPlan(source,contents,'translation'),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});
 book.structure.chapters[2].blocks[0].referenceId=book.structure.chapters[3].blocks[0].id;assert.doesNotThrow(()=>makeDerivedPlan(source,contents,'translation'));
});
test('changing chapter selection changes source and segment identities without rewriting original source',()=>{
 const next=structuredClone(fixture.source);next.manifest.selection=makeChapterSelection(next.parts,{start:1,count:5});next.sha256=sha256(Buffer.from(canonicalJson(next.manifest)));
 assert.notEqual(next.sha256,fixture.source.sha256);const plan=makeDerivedPlan(next,fixture.contents,'translation');assert.ok(plan.manifest.segments.every(unit=>unit.partIndex<2));assert.ok(plan.manifest.segments.every(unit=>!fixture.translationPlan.manifest.segments.some(old=>old.id===unit.id)));
});
