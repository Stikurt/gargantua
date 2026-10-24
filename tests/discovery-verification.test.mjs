import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyDiscoveredBook,inspectGutenbergText,gutenbergIdentifier} from '../server/discovery-verification.mjs';
import {validateBook,validateSourceMetadata,textForScan} from '../server/publication-files.mjs';

const expected={provider:'gutenberg',remoteId:'11',title:"Alice's Adventures in Wonderland",authors:['Carroll, Lewis'],language:'en',languages:['en']};
const txt=(changes={})=>Buffer.from(`The Project Gutenberg eBook of ${changes.title??expected.title}\n\nTitle: ${changes.title??expected.title}\n\nAuthor: ${changes.author??'Lewis Carroll'}\n\nRelease date: June 27, 2008 [eBook #${changes.id??'11'}]\n\nLanguage: ${changes.language??'English'}\n\n*** START OF THE PROJECT GUTENBERG EBOOK ${changes.markerTitle??changes.title??expected.title} ***\n\nA real body paragraph, entirely synthetic for this test.\n\n*** END OF THE PROJECT GUTENBERG EBOOK ${changes.markerTitle??changes.title??expected.title} ***\n\nProject Gutenberg license footer.\n`);
const hash=raw=>createHash('sha256').update(raw).digest('hex');
const legacyBook=()=>({title:'downloaded-file',author:'',language:'',chapters:[{title:'Text',blocks:[{type:'text',text:'Actual parser text'}]}],assets:{}});
const metadata=(changes={})=>({schemaVersion:1,format:'epub',provenance:'opf',title:expected.title,authors:['Carroll, Lewis, 1832-1898'],languages:['en'],identifiers:['http://www.gutenberg.org/ebooks/11'],...changes});
const epubBook=(changes={})=>({...legacyBook(),title:expected.title,author:'Carroll, Lewis, 1832-1898',language:'en',sourceMetadata:metadata(),...changes});
function verify(raw=txt(),changes={}){return verifyDiscoveredBook({expected,book:legacyBook(),extension:'txt',rawInput:raw,expectedInputSha256:hash(raw),...changes});}

test('TXT identity comes from actual header/footer, not filename or expected fields',()=>{
 const result=verify();assert.equal(result.status,'verified');assert.equal(result.verified,true);assert.deepEqual(result.reasons,[]);assert.equal(result.observed.title,expected.title);assert.deepEqual(result.observed.authors,['Lewis Carroll']);assert.deepEqual(result.observed.languages,['en']);assert.deepEqual(result.observed.sourceIds,['11']);assert.equal(result.inputSha256,hash(txt()));assert.equal(result.assurance,'metadata-consistency-only');assert.equal(result.rightsVerified,false);
});

test('each mismatching identity dimension requires review',()=>{
 for(const [changes,reason] of [[{title:'Completely different novel'},'SOURCE_TITLE_MISMATCH'],[{author:'Someone Else'},'SOURCE_AUTHORS_MISMATCH'],[{language:'French'},'SOURCE_LANGUAGE_MISMATCH'],[{id:'12'},'SOURCE_ID_MISMATCH']]){
  const result=verify(txt(changes));assert.equal(result.status,'review_required');assert.equal(result.verified,false);assert.ok(result.reasons.includes(reason));
 }
});

test('body metadata mentions and expected-looking parser fallback do not self-confirm TXT',()=>{
 const raw=Buffer.from(`An ordinary file. Title: ${expected.title}. Author: Carroll, Lewis. Language: English. [eBook #11]`);
 const result=verify(raw,{book:{...legacyBook(),title:expected.title,author:'Carroll, Lewis',language:'en',sourceMetadata:metadata()}});assert.equal(result.verified,false);assert.ok(result.reasons.includes('GUTENBERG_WRAPPER_MISSING'));
});

test('missing, duplicated or misplaced wrapper/identity fields fail closed',()=>{
 for(const transform of [value=>value.replace(/\*\*\* END[^\n]+/u,''),value=>value+'\n*** END OF THE PROJECT GUTENBERG EBOOK Alice ***',value=>value.replace('Title:','Unknown:'),value=>value.replace('Author:','Contributor:'),value=>value.replace('Language:','Dialect:'),value=>value.replace('[eBook #11]',''),value=>value.replace('[eBook #11]','[eBook #11] [eBook #12]'),value=>value.replace('Title:',`Title: Other\nTitle:`),value=>'x'.repeat(65537)+value]){
  const result=verify(Buffer.from(transform(txt().toString())));assert.equal(result.verified,false);assert.ok(result.reasons.length);
 }
});

test('marker title mismatch, unknown language and invalid encoding are explicit review',()=>{
 assert.ok(verify(txt({markerTitle:'Different Title'})).reasons.includes('GUTENBERG_MARKER_TITLE_MISMATCH'));
 assert.ok(verify(txt({language:'Unknown language'})).reasons.includes('SOURCE_LANGUAGE_UNKNOWN'));
 assert.ok(verify(Buffer.from([0xff])).reasons.includes('TEXT_ENCODING_UNKNOWN'));
 assert.ok(verify(Buffer.alloc(6*1024*1024+1,65)).reasons.includes('TEXT_INPUT_LIMIT'));
});

test('input bytes are pinned to durable attempt hash before checking metadata',()=>{
 const raw=txt();assert.ok(verify(raw,{expectedInputSha256:'0'.repeat(64)}).reasons.includes('INPUT_HASH_MISMATCH'));
 assert.ok(verify(raw,{expectedInputSha256:undefined}).reasons.includes('INPUT_HASH_MISMATCH'));
 assert.ok(verify(raw,{rawInput:undefined}).reasons.includes('INPUT_BYTES_MISSING'));
});

test('missing trusted expected metadata never becomes an expected/observed equality shortcut',()=>{
 for(const changes of [{provider:'openlibrary'},{remoteId:'011'},{title:''},{authors:[]},{languages:[]},{language:'ru'},{languages:['EN']}])assert.ok(verify(txt(),{expected:{...expected,...changes}}).reasons.includes('EXPECTED_METADATA_INVALID'));
 assert.ok(verify(txt(),{expected:undefined}).reasons.includes('EXPECTED_METADATA_INVALID'));
});

test('EPUB accepts only actual isolated OPF evidence, matching the parsed publication metadata',()=>{
 const raw=Buffer.from('Synthetic EPUB bytes; actual ZIP parser tested separately');
 const result=verify(raw,{extension:'epub',book:epubBook()});assert.equal(result.verified,true);assert.equal(result.observed.evidence,'isolated-parser-opf');assert.deepEqual(result.observed.sourceIds,['11']);
 for(const sourceMetadata of [undefined,{...metadata(),provenance:'expected-api'},{...metadata(),format:'txt'},{...metadata(),schemaVersion:2}]){
  const denied=verify(raw,{extension:'epub',book:epubBook({sourceMetadata})});assert.equal(denied.verified,false);assert.ok(denied.reasons.includes('SOURCE_METADATA_UNKNOWN'));
 }
});

test('EPUB requires Gutenberg identifier from OPF, not an ISBN or a URL embedded in title/body',()=>{
 const raw=Buffer.from('Synthetic EPUB bytes');
 for(const identifiers of [[],['9780000000000'],['urn:uuid:00000000-0000-0000-0000-000000000000'],['https://evil.test/ebooks/11'],['https://www.gutenberg.org/ebooks/11?token=1'],['https://www.gutenberg.org/ebooks/11','https://www.gutenberg.org/ebooks/12']]){
  const result=verify(raw,{extension:'epub',book:epubBook({sourceMetadata:metadata({identifiers})})});assert.equal(result.verified,false);assert.ok(result.reasons.some(reason=>reason==='SOURCE_ID_UNKNOWN'||reason==='SOURCE_ID_CONFLICT'));
 }
 assert.equal(gutenbergIdentifier('urn:gutenberg:11'),'11');assert.equal(gutenbergIdentifier('https://www.gutenberg.org/etext/11'),'11');assert.equal(gutenbergIdentifier('file:///ebooks/11'),null);
});

test('EPUB cannot publish display fields conflicting with verified source metadata',()=>{
 const raw=Buffer.from('Synthetic EPUB bytes');
 for(const changes of [{title:'Different'},{author:'Different'},{language:'ru'}]){
  const result=verify(raw,{extension:'epub',book:epubBook(changes)});assert.equal(result.verified,false);assert.ok(result.reasons.includes('PARSER_METADATA_CONFLICT'));
 }
});

test('OPF arrays and required fields remain bounded and unknown is explicit review',()=>{
 const raw=Buffer.from('Synthetic EPUB bytes');
 for(const changes of [{title:''},{authors:[]},{languages:[]},{authors:Array(17).fill('Person')},{identifiers:Array(33).fill('http://www.gutenberg.org/ebooks/11')},{languages:['unknown language']}])assert.equal(verify(raw,{extension:'epub',book:epubBook({sourceMetadata:metadata(changes)})}).verified,false);
 assert.ok(verify(raw,{extension:'fb2',book:epubBook()}).reasons.includes('SOURCE_FORMAT_UNSUPPORTED'));
});

test('immutable publication validator accepts bounded source evidence and scans its actual strings',()=>{
 const book=epubBook();validateSourceMetadata(book.sourceMetadata);validateBook(book);
 const text=textForScan(book).toString();assert.ok(text.includes('http://www.gutenberg.org/ebooks/11'));assert.ok(text.includes('1832-1898'));
 for(const meta of [{...metadata(),expectedTitle:expected.title},{...metadata(),provenance:'api'},{...metadata(),identifiers:Array(33).fill('x')},{...metadata(),title:'x'.repeat(301)},{...metadata(),authors:['bad\nmetadata']}])assert.throws(()=>validateBook(epubBook({sourceMetadata:meta})),{code:'PUBLICATION_INTEGRITY'});
 validateBook(legacyBook());
});

test('inspection never mutates expected or parsed objects and returns fixed review codes',()=>{
 const exp=structuredClone(expected),book=epubBook(),before=JSON.stringify({exp,book});
 const raw=Buffer.from('Synthetic EPUB bytes');verify(raw,{extension:'epub',expected:exp,book});assert.equal(JSON.stringify({exp,book}),before);
 const observed=inspectGutenbergText(txt());assert.deepEqual(observed.reasons,[]);
});
