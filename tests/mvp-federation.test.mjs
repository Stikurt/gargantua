import test from 'node:test';
import assert from 'node:assert/strict';
import {compareMvpBooks,mergeMvpBooks,matchMvpWork,createMvpFederation} from '../server/mvp-federation.mjs';
const novel=(source,count,overrides={})=>({source,id:'55',kind:'novel',title:'Верховный Маг',originalTitle:'Supreme Magus',author:'Legiona',numbering:'global',chapters:Array.from({length:count},(_,index)=>({id:String(index+1),number:String(index+1),volume:'1',title:'Глава '+(index+1),available:true})),...overrides});
test('a longer matching novel adds its real tail while retaining the original source on overlap',()=>{
  const a=novel('ranobelib',100),b=novel('ranobeme',1100),comparison=compareMvpBooks(a,b);
  assert.equal(comparison.canMerge,true);assert.equal(comparison.addedCount,1000);assert.equal(comparison.matchedCount,100);
  const merged=mergeMvpBooks(a,b);assert.equal(merged.chapters.length,1100);assert.equal(merged.chapters[99].origin.source,'ranobelib');assert.equal(merged.chapters[100].origin.source,'ranobeme');assert.equal(merged.chapters[100].origin.chapterId,'101');
});
test('Russian and original aliases match, but conflicting authors or different works cannot merge',()=>{
  assert.equal(matchMvpWork(novel('a',3),novel('b',4,{title:'Supreme Magus'})).matches,true);
  assert.equal(compareMvpBooks(novel('a',3),novel('b',4,{author:'Another Writer'})).canMerge,false);
  assert.throws(()=>mergeMvpBooks(novel('a',3),novel('b',4,{title:'Совсем другая книга',originalTitle:''})),/Название/);
});
test('volume-local chapter numbers never get silently mixed with global numbering',()=>{
  const a=novel('a',4,{numbering:'volume'}),b=novel('b',5);assert.equal(compareMvpBooks(a,b).canMerge,false);assert.throws(()=>mergeMvpBooks(a,b),/Нумерация/);
});
test('explicit parts of new chapters remain distinct, and split overlap does not overwrite a complete cached chapter',()=>{
  const a=novel('a',3),b=novel('b',3);
  b.chapters=b.chapters.flatMap(chapter=>[{...chapter,id:chapter.id+'a',part:1,title:chapter.title+'. Часть 1'},{...chapter,id:chapter.id+'b',part:2,title:chapter.title+'. Часть 2'}]);
  b.chapters.push({id:'4a',number:'4',part:1,title:'Глава 4. Часть 1',available:true},{id:'4b',number:'4',part:2,title:'Глава 4. Часть 2',available:true});
  const result=mergeMvpBooks(a,b);assert.equal(result.chapters.length,5);assert.deepEqual(result.chapters.slice(-2).map(chapter=>chapter.part),[1,2]);assert.equal(result.chapters[0].origin.source,'a');
});
test('unavailable base releases are filled only by the exact corresponding available chapter',()=>{
  const a=novel('a',3);a.chapters[1].available=false;const result=mergeMvpBooks(a,novel('b',4));
  assert.equal(result.summary.filledCount,1);assert.equal(result.chapters[1].origin.source,'b');assert.equal(result.chapters[0].origin.source,'a');
});
test('the chosen translation branch is part of origin identity and the merged book has stable IDs across updates',()=>{
  const a=novel('a',3);a.chapters=a.chapters.map(chapter=>({...chapter,branchIds:['7','8']}));
  const first=mergeMvpBooks(a,novel('b',4),{baseBranchId:'8'}),updated=mergeMvpBooks(a,novel('b',5),{baseBranchId:'8'});
  assert.equal(first.book.id,updated.book.id);assert.equal(first.chapters[0].id,updated.chapters[0].id);assert.equal(first.chapters[0].origin.branchId,'8');
});
test('ambiguous chapter coordinates are not treated as missing extra chapters',()=>{
  const other=novel('b',4);other.chapters.push({...other.chapters[3],id:'duplicate'});assert.equal(compareMvpBooks(novel('a',3),other).canMerge,false);
});
test('incorrectly duplicated labels inside the already available base range do not discard the safe continuation',()=>{
  const a=novel('a',3),b=novel('b',5);b.chapters.push({...b.chapters[1],id:'wrong-label',title:'Другая подпись ошибочного номера'});
  const result=mergeMvpBooks(a,b);assert.equal(result.chapters.length,5);assert.equal(result.chapters[1].origin.source,'a');assert.equal(result.chapters[1].alternateOrigins.length,0);assert.equal(result.summary.addedCount,2);assert.match(result.warnings.join(' '),/неоднозначно/);
});
test('books split into reader pages are offered as separate editions rather than blindly merged',()=>{
  assert.equal(compareMvpBooks(novel('a',3,{kind:'book'}),novel('b',30,{kind:'book'})).canMerge,false);
});
test('a narrative chapter mentioning a cover is a numbered chapter, not front matter',()=>{
  const a=novel('a',3);a.chapters[1].title='Не суди книгу по обложке';const result=mergeMvpBooks(a,novel('b',4));assert.equal(result.chapters[1].mergeKey,'g:2');assert.equal(result.chapters.at(-1).number,'4');
});
test('related searches use registered novel sources and retain their explicit errors',async()=>{
  const a=novel('a',3),b=novel('b',5);const sources={sources:[{id:'a',kind:'novel'},{id:'b',kind:'novel'},{id:'down',kind:'novel'}],book:async(source)=>source==='a'?a:b,search:async({source})=>source==='down'?{items:[],errors:[{source,message:'Источник не ответил'}]}:{items:[b]}};
  const result=await createMvpFederation({sources}).related({source:'a',id:'55'});assert.equal(result.alternatives[0].addedCount,2);assert.equal(result.errors[0].source,'down');
});
