import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {importBook} from '../src/import-book.mjs';
import {validateCatalogs} from '../src/catalogs.mjs';
const read=(text,name='book.fb2')=>importBook(strToU8(text),name);
test('offline TXT never treats markup as HTML',()=>{assert.equal(read('<script>alert(1)</script>','story.txt').chapters[0].blocks[0].text,'<script>alert(1)</script>');});
test('FB2 extracts title and inert paragraphs, omits binary images',()=>{const book=read('<FictionBook><description><title-info><book-title>Путь</book-title><author><first-name>Автор</first-name></author></title-info></description><body><section><title><p>Глава</p></title><p>Текст &amp; книга</p></section></body><binary>AAAA</binary></FictionBook>');assert.equal(book.title,'Путь');assert.equal(book.chapters[0].blocks.at(-1).text,'Текст & книга');assert(!JSON.stringify(book.chapters).includes('AAAA'));});
test('rejects entities, active XML, malformed XML, non-text and oversized input',()=>{
 for(const text of ['<!DOCTYPE x [<!ENTITY x "evil">]><FictionBook/>','<FictionBook><body><script>bad</script></body></FictionBook>','<FictionBook><body></FictionBook>'])assert.throws(()=>read(text));
 assert.throws(()=>read('a\u0000b','x.txt'));assert.throws(()=>importBook(new Uint8Array(10*1024*1024+1),'x.txt'));
});
function epub(extra={}){return zipSync({'mimetype':strToU8('application/epub+zip'),'META-INF/container.xml':strToU8('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),'OPS/book.opf':strToU8('<package xmlns:dc="urn:dc"><metadata><dc:title>Journey</dc:title></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>'),'OPS/one.xhtml':strToU8('<html><head><title>Hidden</title></head><body><h1>First</h1><p>Hello</p></body></html>'),...extra});}
test('EPUB follows spine, omits head and archive payloads',()=>{const b=importBook(epub({'payload.exe':strToU8('MZnotexecuted')}),'x.epub');assert.equal(b.title,'Journey');assert.equal(b.chapters[0].title,'First');assert(!JSON.stringify(b.chapters).includes('Hidden'));});
test('ZIP traversal and compression bombs rejected before publication',()=>{assert.throws(()=>importBook(epub({'../evil.xml':strToU8('<x/>')}),'x.epub'));assert.throws(()=>importBook(epub({'bomb.xml':strToU8('x'.repeat(500000))}),'x.epub'));});
test('catalog nesting rejects cycles, orphan parents and duplicate identities',()=>{const a='00000000-0000-4000-8000-000000000002',b='00000000-0000-4000-8000-000000000003';const c=[{id:a,title:'Series',parent:null,items:[]},{id:b,title:'Cycle',parent:a,items:[]}];assert.equal(validateCatalogs(c),c);assert.throws(()=>validateCatalogs([{...c[0],parent:b},c[1]]));assert.throws(()=>validateCatalogs([c[1]]));assert.throws(()=>validateCatalogs([c[0],c[0]]));});
