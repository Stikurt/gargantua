import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonicalJson,structureFor,validateStructure,makePublicationManifest,checkedPublicationView,sha256,publicChapter} from '../server/publication-model.mjs';
const book=()=>({title:'Book',author:'Author',language:'',chapters:[{title:'Chapter',blocks:[{type:'text',text:'😀 Привет.'}]}],assets:{}});
const row=()=>({id:randomUUID(),work_id:randomUUID(),expression_id:randomUUID(),edition_id:randomUUID()});
test('legacy package projection is stable and declares its structural limitation',()=>{
 const b=book(),s=structureFor(b);assert.deepEqual(s.warnings,['LEGACY_STRUCTURE_ONLY']);validateStructure(s,1);assert.equal(s.chapters[0].blocks[0].type,'paragraph');assert.equal(b.structure,undefined);
 const r=row(),manifest=makePublicationManifest(r,b);assert.equal(manifest.language,'und');const bytes=Buffer.from(canonicalJson({...s.chapters[0],title:s.chapters[0].title.slice(0,250)}));assert.equal(sha256(bytes),manifest.readingOrder[0].sha256);assert.equal(bytes.length,manifest.readingOrder[0].bytes);
});
test('canonical projection survives JSONB property ordering and rejects drift',()=>{
 const b=book(),r=row(),manifest=makePublicationManifest(r,b),sha=sha256(Buffer.from(canonicalJson(manifest)));
 const reversed=Object.fromEntries(Object.entries(manifest).reverse());assert.equal(checkedPublicationView({...r,publication_manifest:reversed,publication_sha256:sha},b).manifest.id,r.id);
 assert.throws(()=>checkedPublicationView({...r,publication_manifest:manifest,publication_sha256:sha},{...b,title:'changed'}),{code:'PUBLICATION_STRUCTURE'});
});
test('rich inline boundaries never split UTF16 pairs and targets must exist',()=>{
 const s=structureFor(book()),block=s.chapters[0].blocks[0];block.spans=[{kind:'strong',start:0,end:2}];validateStructure(s,1);
 block.spans[0].end=1;assert.throws(()=>validateStructure(s,1));block.spans=[{kind:'link',start:0,end:2,target:'missing'}];assert.throws(()=>validateStructure(s,1));
 block.spans[0].target=block.id;validateStructure(s,1);
});
test('structure rejects extra active fields, duplicate IDs and URLs',()=>{
 for(const edit of [s=>{s.chapters[0].blocks[0].onclick='bad';},s=>{s.chapters[0].blocks.push({...s.chapters[0].blocks[0]});},s=>{s.chapters[0].blocks[0].referenceId='https://evil/';},s=>{s.chapters[0].blocks[0].rows=[['x']];}]){const s=structureFor(book());edit(s);assert.throws(()=>validateStructure(s,1));}
});
test('public titles preserve whole Unicode codepoints at the schema boundary',()=>{
 const b=book();b.title='a'.repeat(249)+'😀';b.chapters[0].title=b.title;
 assert.equal(Array.from(makePublicationManifest(row(),b).title).length,250);assert.ok(makePublicationManifest(row(),b).title.endsWith('😀'));assert.ok(publicChapter(structureFor(b).chapters[0]).title.endsWith('😀'));
 const s=structureFor(book());s.chapters[0].blocks[0].text='\uD83D';assert.throws(()=>validateStructure(s,1));
});
