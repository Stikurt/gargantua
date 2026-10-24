import {createExtraBookSources} from './mvp-extra-books.mjs';
import {extractMvpHtml} from './mvp-sources.mjs';
import fs from 'node:fs';
const adapter=createExtraBookSources({extractHtml:extractMvpHtml});const evidence=[];
for(const [source,query] of [['libcat','Король в жёлтом'],['litlife','Коты-воители']]){
 const start=Date.now();try{const found=await adapter.search(source,query);console.log('SEARCH',source,found.items.map(x=>({id:x.id,title:x.title,author:x.author,available:x.available})));const chosen=source==='libcat'?found.items.find(x=>/Чамберс/.test(x.author)):found.items.find(x=>/Стань диким/.test(x.title))??found.items[0];if(!chosen)throw Error('Required book missing');const book=await adapter.book(source,chosen.id);console.log('BOOK',source,book.title,book.chapters.length,book.available);const chapters=[];for(const page of ['1','2']){const chapter=await adapter.chapter(source,chosen.id,page);console.log('CHAPTER',source,page,chapter.paragraphs.length,chapter.text.length,chapter.sourceUrl);chapters.push({page,paragraphs:chapter.paragraphs.length,characters:chapter.text.length,sourceUrl:chapter.sourceUrl});}evidence.push({source,query,searchItems:found.items.map(x=>({id:x.id,title:x.title,author:x.author,available:x.available})),book:{id:book.id,title:book.title,author:book.author,pages:book.chapters.length},chapters,elapsedMs:Date.now()-start});}catch(e){console.log('ERROR',source,e.code,e.message,e.stack);process.exitCode=1;}
}
fs.writeFileSync('server/mvp-books-smoke-evidence.json',JSON.stringify(evidence,null,2));
