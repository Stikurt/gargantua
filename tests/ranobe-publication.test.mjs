import test from 'node:test';import assert from 'node:assert/strict';
import {bindRanobeChapter,extractRanobeChapter,assembleRanobePart,ranobePartWouldOverflow} from '../server/ranobe-publication.mjs';
import {validateBook} from '../server/publication-files.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6QkAAAAASUVORK5CYII=','base64').toString('base64');
const book=()=>({title:'Novel',author:'Author',language:'ru',chapters:[{title:'Chapter',blocks:[{type:'text',text:'Текст'},{type:'image',asset:'image-0.png',text:'Карта'}]}],assets:{'image-0.png':png}});
const bind=(key,extra={})=>bindRanobeChapter(book(),{feedId:'feed-one',key,title:'Novel',author:'Author',language:'ru',chapterTitle:key,...extra});
test('chapter identities are stable across part boundaries and distinct across source/branch',()=>{
 const a=bind('1/1'),b=bind('1/2'),again=bind('1/1'),other=bind('1/1',{feedId:'feed-two'});assert.equal(a.structure.chapters[0].id,again.structure.chapters[0].id);assert.notEqual(a.structure.chapters[0].id,b.structure.chapters[0].id);assert.notEqual(a.structure.chapters[0].id,other.structure.chapters[0].id);
 const part=assembleRanobePart([a,b],{title:'Novel',author:'Author',language:'ru',first:1,last:2});validateBook(part);assert.deepEqual(part.structure.chapters.map(c=>c.id),[a.structure.chapters[0].id,b.structure.chapters[0].id]);assert.equal(Object.keys(part.assets).length,1);assert.equal(part.chapters[1].blocks[1].asset,'image-0.png');
});
test('extracting a prepared chapter keeps its exact text, image and identity',()=>{
 const a=bind('1/1'),b=bind('1/2'),part=assembleRanobePart([a,b],{title:'Novel',author:'Author',language:'ru',first:1,last:2});const extracted=extractRanobeChapter(part,1);assert.deepEqual(extracted.chapters,b.chapters);assert.deepEqual(extracted.structure.chapters,b.structure.chapters);assert.deepEqual(extracted.assets,b.assets);assert.throws(()=>extractRanobeChapter(part,2));
});
test('internal references are rebound and references to missing blocks are rejected',()=>{
 const value=book();value.structure={schemaVersion:2,warnings:[],chapters:[{id:'c0',revision:1,title:'Chapter',blocks:[{id:'p0',type:'paragraph',text:'Сноска',spans:[{start:0,end:6,kind:'link',target:'p1'}]},{id:'p1',type:'footnote',text:'Примечание'}]}]};
 const bound=bindRanobeChapter(value,{feedId:'feed',key:'key',title:'Novel',author:'Author',language:'ru',chapterTitle:'Chapter'});assert.equal(bound.structure.chapters[0].blocks[0].spans[0].target,bound.structure.chapters[0].blocks[1].id);
 value.structure.chapters[0].blocks[0].spans[0].target='missing';assert.throws(()=>bindRanobeChapter(value,{feedId:'feed',key:'key',title:'Novel',author:'Author',language:'ru',chapterTitle:'Chapter'}));
});
test('part bounds split between whole chapters and preserve Unicode titles',()=>{
 const a=bind('1');assert.equal(ranobePartWouldOverflow([],a),false);assert.equal(ranobePartWouldOverflow(Array.from({length:50},()=>a),a),true);const large=bind('2');large.chapters[0].blocks[0].text='x'.repeat(100000);assert.equal(ranobePartWouldOverflow([a],large),false);
 const part=assembleRanobePart([a],{title:'📕'.repeat(300),author:'Author',language:'ru',first:1,last:1});assert.ok(part.title.isWellFormed());assert.throws(()=>assembleRanobePart([],{title:'Novel'}));
});
