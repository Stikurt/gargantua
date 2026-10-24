import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {requestedChapterRange,normalizedChapterRange,makeChapterSelection,sourceChapterSelection,assertSelectionBooks,selectedChapterIndices,selectedPartIndices,publicChapterRange} from '../server/derived-selection.mjs';
const books=(counts=[3,4])=>counts.map((count,p)=>({id:randomUUID(),chapter_count:count,publication_manifest:{readingOrder:Array.from({length:count},(_,c)=>({chapterId:`part${p}-chapter${c}`}))}}));
const source=(values,range,kind='translation')=>({parts:values,manifest:{schemaVersion:2,parts:values.map((b,ordinal)=>({ordinal,publicationId:b.id,chapterCount:b.chapter_count})),selection:makeChapterSelection(values,range,kind)}});

test('new ranges default to five, clamp only the final batch, and keep distinct translation/audio caps',()=>{
 assert.deepEqual(requestedChapterRange(undefined),{start:1,count:5});
 assert.deepEqual(normalizedChapterRange(undefined,3),{start:1,count:3});
 assert.deepEqual(normalizedChapterRange({start:6,count:5},7),{start:6,count:2});
 assert.deepEqual(requestedChapterRange({start:1,count:50},'audio'),{start:1,count:50});
 for(const value of [{start:0,count:5},{start:1,count:0},{start:1,count:6},{start:1.5,count:2},{start:1,count:2,all:true},null,[],{start:1},'all'])assert.throws(()=>requestedChapterRange(value),{code:'DERIVED_CHAPTER_RANGE'});
 assert.throws(()=>normalizedChapterRange({start:8,count:5},7),{code:'DERIVED_CHAPTER_RANGE'});
 assert.throws(()=>requestedChapterRange({start:1,count:51},'audio'),{code:'DERIVED_CHAPTER_RANGE'});
});
test('selection pins physical IDs and exact offsets across source part boundaries',()=>{
 const values=books(),selected=source(values,{start:3,count:4}),selection=sourceChapterSelection(selected);
 assert.deepEqual(selection.chapters.map(c=>[c.ordinal,c.partIndex,c.chapterIndex]),[[2,0,2],[3,1,0],[4,1,1],[5,1,2]]);
 assert.deepEqual(selectedPartIndices(selected),[0,1]);
 assert.deepEqual(selectedChapterIndices(selected,1,values[1].publication_manifest.readingOrder.map(e=>({id:e.chapterId}))),[0,1,2]);
 assert.deepEqual(publicChapterRange(selected.manifest),{start:3,count:4,total:7,hasMore:true,nextStart:7});
 assert.deepEqual(publicChapterRange(source(values,{start:6,count:5}).manifest),{start:6,count:2,total:7,hasMore:false,nextStart:null});
 assert.equal(assertSelectionBooks(selected),selection);
});
test('tampered physical identity, ordering, count, bounds and content chapter IDs fail closed',()=>{
 const values=books(),base=source(values,{start:3,count:4});
 for(const change of [s=>s.selection.start++,s=>s.selection.count++,s=>s.selection.total++,s=>s.selection.chapters.reverse(),s=>s.selection.chapters[0].ordinal++,s=>s.selection.chapters[0].partIndex=1,s=>s.selection.chapters[0].chapterIndex=20,s=>s.selection.chapters[0].publicationId=randomUUID(),s=>s.selection.chapters[0].chapterId='bad/id',s=>s.selection.chapters[0].unknown=true]){
  const copy=structuredClone(base);change(copy.manifest);assert.throws(()=>sourceChapterSelection(copy),{code:'DERIVED_SELECTION_INTEGRITY'});
 }
 const changed=structuredClone(base);changed.manifest.selection.chapters[0].chapterId='other-valid-id';assert.throws(()=>assertSelectionBooks(changed),{code:'DERIVED_SELECTION_INTEGRITY'});
 assert.throws(()=>selectedChapterIndices(base,0,[{id:'different'},{id:'different'},{id:'different'}]),{code:'DERIVED_SELECTION_INTEGRITY'});
});
test('legacy whole-book identities keep their complete chapter ordering and no implicit selection',()=>{
 const values=books(),legacy={parts:values,manifest:{schemaVersion:1,parts:values.map((b,ordinal)=>({ordinal,publicationId:b.id,chapterCount:b.chapter_count}))}};
 assert.equal(sourceChapterSelection(legacy),null);assert.deepEqual(selectedPartIndices(legacy),[0,1]);
 assert.deepEqual(selectedChapterIndices(legacy,1,[{id:'one'},{id:'two'},{id:'three'},{id:'four'}]),[0,1,2,3]);
 assert.deepEqual(publicChapterRange(legacy.manifest),{start:1,count:7,total:7,hasMore:false,nextStart:null});
 assert.throws(()=>sourceChapterSelection({...legacy,manifest:{...legacy.manifest,selection:{}}}),{code:'DERIVED_SELECTION_INTEGRITY'});
});
test('large metadata inventories allocate only the explicitly selected chapter entries',()=>{
 const values=books(Array(1000).fill(1000)),selected=makeChapterSelection(values,{start:999999,count:5});
 assert.equal(selected.chapters.length,2);assert.equal(selected.total,1000000);assert.deepEqual(selected.chapters.map(c=>c.chapterIndex),[998,999]);
});
