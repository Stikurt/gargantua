import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSearchQuery,describeSearchQuery,searchQueryKey,boundedDamerauDistance,suggestSearchQueries,SEARCH_QUERY_LIMITS} from '../src/search-query.mjs';

test('query normalization accepts pasted whitespace and compatibility forms without rewriting words',()=>{
 assert.equal(normalizeSearchQuery('  Цивилизация\t\r\nмудрецов  '),'Цивилизация мудрецов');
 assert.equal(normalizeSearchQuery('Артур\u00a0\u2009\u202fКларк'),'Артур Кларк');
 assert.equal(normalizeSearchQuery('\u3000Ｒｅｎｄｅｚｖｏｕｓ\u3000ｗｉｔｈ\u3000Ｒａｍａ\u3000'),'Rendezvous with Rama');
 assert.equal(normalizeSearchQuery('Питер\u2028Пэн\u2029'),'Питер Пэн');
 assert.equal(normalizeSearchQuery('Свидание  с  Рамой'),'Свидание с Рамой');
});
test('raw and normalized query bounds stay at 2–300 UTF-16 units and never truncate',()=>{
 assert.equal(normalizeSearchQuery('а'.repeat(300)).length,300);
 for(const value of ['', 'x', '  ', 'x'.repeat(301),' '.repeat(300)+'x','\ufb03'.repeat(101)])assert.throws(()=>normalizeSearchQuery(value),error=>error.code==='SEARCH_QUERY_LENGTH');
 assert.equal(normalizeSearchQuery('😀'),'😀'); // Two UTF-16 units, same API convention.
 for(const value of [null,{},[],42])assert.throws(()=>normalizeSearchQuery(value),error=>error.code==='SEARCH_QUERY_TYPE');
});
test('hidden, bidi, non-paste control and malformed Unicode are rejected before or after normalization',()=>{
 for(const control of ['\0','\u0001','\v','\f','\u007f','\u0085','\u034f','\u061c','\u200b','\u200c','\u200d','\u200e','\u202e','\u2066','\ufeff','\ufe0f','\u{e0100}'])assert.throws(()=>normalizeSearchQuery('Книга'+control+'тест'),error=>error.code==='SEARCH_QUERY_CONTROL');
 for(const value of ['Книга\ud800тест','Книга\udc00тест'])assert.throws(()=>normalizeSearchQuery(value),error=>error.code==='SEARCH_QUERY_UNICODE');
});
test('URL rule runs after NFKC and catches split pasted schemes and www prefixes anywhere in the query',()=>{
 for(const value of ['https://example.org/book','ＨＴＴＰＳ：／／example.org/book','h t t p s : / / example.org','Название\nwww . example.org','test ftp:\t/\n/example.org','test git+ssh://example.org'])assert.throws(()=>normalizeSearchQuery(value),error=>error.code==='SEARCH_QUERY_URL');
 assert.equal(normalizeSearchQuery('Слово: история одной книги'),'Слово: история одной книги');
});
test('query description preserves original spelling and matching keys are explicitly separate from identities',()=>{
 const original='  ЦИВИЛИЗАЦИЯ\tМУДРЕЦОВ  ';assert.deepEqual(describeSearchQuery(original),{originalQuery:original,normalizedQuery:'ЦИВИЛИЗАЦИЯ МУДРЕЦОВ',changed:true});
 assert.equal(searchQueryKey('Коты-воители'),'коты воители');assert.equal(searchQueryKey('Всё, что мы знали'),'все что мы знали');
});
test('bounded edit distance covers insertion deletion substitution and adjacent transposition',()=>{
 for(const [a,b,expected] of [['мудрецов','мурдецов',1],['Кларк','Клак',1],['Кларк','Кларка',1],['novel','noval',1],['abc','acb',1],['same','same',0],['abc','xyz',3],['','ab',2]])assert.equal(boundedDamerauDistance(a,b,2),expected);
 assert.equal(boundedDamerauDistance('a'.repeat(121),'a'.repeat(120),2),3);assert.equal(boundedDamerauDistance('abc','xyz',1),2);assert.equal(boundedDamerauDistance('ab','ba',0),1);
 for(const args of [[null,'abc',1],['abc','abc',3],['abc','abc',-1]])assert.throws(()=>boundedDamerauDistance(...args),TypeError);
});
test('banded bounded distance agrees with an independent full OSA matrix for every abc word up to four characters',()=>{
 const words=[''];for(let length=1;length<=4;length++)for(const word of words.filter(value=>value.length===length-1))for(const letter of 'abc')words.push(word+letter);
 function full(a,b){const rows=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));for(let i=0;i<=a.length;i++)rows[i][0]=i;for(let j=0;j<=b.length;j++)rows[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){rows[i][j]=Math.min(rows[i-1][j]+1,rows[i][j-1]+1,rows[i-1][j-1]+(a[i-1]===b[j-1]?0:1));if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])rows[i][j]=Math.min(rows[i][j],rows[i-2][j-2]+1);}return rows[a.length][b.length];}
 let compared=0;for(const a of words)for(const b of words){const expected=full(a,b);for(const bound of [0,1,2]){assert.equal(boundedDamerauDistance(a,b,bound),Math.min(expected,bound+1),JSON.stringify({a,b,bound}));compared++;}}assert.equal(compared,43923);
});
const catalog=Object.freeze([
 {id:'novel-1',title:'Цивилизация Мудрецов',kind:'book',aliases:['Civilization of the Sages']},
 {id:'author-1',title:'Артур Кларк',kind:'author',aliases:['Arthur C. Clarke','Артура Кларка']},
 {id:'series-1',title:'Коты-воители',kind:'series',aliases:['Warrior Cats']},
]);
test('metadata-backed typos propose the known title while preserving raw query and intent',()=>{
 const original='  цивилизация\tмурдецов  ',result=suggestSearchQueries(original,catalog,{intent:'book'});
 assert.equal(result.originalQuery,original);assert.equal(result.normalizedQuery,'цивилизация мурдецов');assert.equal(result.intent,'book');
 assert.equal(result.suggestions.length,1);assert.equal(result.suggestions[0].query,'Цивилизация Мудрецов');assert.equal(result.suggestions[0].reason,'typo');assert.equal(result.suggestions[0].editDistance,1);assert.equal(result.suggestions[0].confirmationRequired,true);
 assert.equal(suggestSearchQueries('Артур Клак',catalog,{intent:'author'}).suggestions[0].query,'Артур Кларк');
});
test('known aliases provide explicit suggestions, while canonical case and hyphen differences need no correction',()=>{
 assert.equal(suggestSearchQueries('Civilization of the Sages',catalog).suggestions[0].reason,'known-alias');
 assert.equal(suggestSearchQueries('Артура Кларка',catalog,{intent:'author'}).suggestions[0].query,'Артур Кларк');
 assert.equal(suggestSearchQueries('цивилизация мудрецов',catalog).suggestions.length,0);
 assert.equal(suggestSearchQueries('КОТЫ ВОИТЕЛИ',catalog).suggestions.length,0);
 assert.equal(suggestSearchQueries('Книга вечера',[{title:'Книга вечера',aliases:['Книга вечер']}]).suggestions.length,0);
});
test('wrong keyboard layout is proposed only for an exact known title or alias',()=>{
 const result=suggestSearchQueries('wbdbkbpfwbz velhtwjd',catalog);assert.equal(result.suggestions[0].query,'Цивилизация Мудрецов');assert.equal(result.suggestions[0].reason,'keyboard-layout');
 assert.equal(suggestSearchQueries('фкергк сдфклу',[{title:'Arthur Clarke',kind:'author'}],{intent:'author'}).suggestions[0].query,'Arthur Clarke');
 assert.equal(suggestSearchQueries('wbdbkbpfwbz velhtwjo',catalog).suggestions.length,0,'A layout variant is never fed into fuzzy matching');
 assert.equal(suggestSearchQueries('unrelated words',catalog).suggestions.length,0);
});
test('mixed-alphabet lookalikes produce an explicit exact-known suggestion',()=>{
 const result=suggestSearchQueries('Цивилизaция Мудрецов',catalog);assert.equal(result.suggestions[0].reason,'mixed-alphabet');assert.equal(result.suggestions[0].query,'Цивилизация Мудрецов');
 const latin=suggestSearchQueries('Аrthur Clarke',[{title:'Arthur Clarke',kind:'author'}],{intent:'author'});assert.equal(latin.suggestions[0].reason,'mixed-alphabet');
});
test('short ambiguous titles, different volume numbers, broad typos, and wrong intents are omitted',()=>{
 assert.equal(suggestSearchQueries('Мама',[{title:'Рама'}]).suggestions.length,0);
 assert.equal(suggestSearchQueries('Книга том 1',[{title:'Книга том 2'}]).suggestions.length,0);
 assert.equal(suggestSearchQueries('Неизвестное произведение',catalog).suggestions.length,0);
 assert.equal(suggestSearchQueries('Артур Клак',catalog,{intent:'book'}).suggestions.length,0);
 assert.equal(suggestSearchQueries('Different words',[{title:'Different worlds'}]).suggestions.length,1);
});
test('ambiguous known titles remain distinct confirmation choices rather than automatic merge or acquisition',()=>{
 const result=suggestSearchQueries('Сказки озера',[{id:'a',title:'Сказки озёра'},{id:'b',title:'Сказки озераа'},{id:'c',title:'Сказки озераы'}]);
 assert.equal(result.suggestions.length,2);assert.deepEqual(result.suggestions.map(row=>row.knownId),['b','c']);
 assert.ok(result.suggestions.every(row=>row.confirmationRequired));assert.equal('selectedCandidateId' in result,false);assert.equal('sourceBinding' in result,false);assert.equal('url' in result,false);
});
test('known metadata is bounded and deterministic and never executes getters',()=>{
 let calls=0;const dangerous={kind:'book'};Object.defineProperty(dangerous,'title',{get(){calls++;throw Error('must not run');}});
 const rows=[dangerous,{title:'Цивилизация Мудрецов',aliases:['Книга',null,'\u202eопасный текст','https://example.org'],kind:'book'},...Array.from({length:300},(_,i)=>({id:'x'+i,title:'Книга '+i}))];
 const result=suggestSearchQueries('Цивилизация Мурдецов',rows);assert.equal(calls,0);assert.equal(result.metadataTruncated,true);assert.ok(result.inspectedRecords<=SEARCH_QUERY_LIMITS.knownRecords);assert.equal(result.suggestions.length,1);
 const array=[];Object.defineProperty(array,'0',{get(){calls++;throw Error('must not run');}});array.length=1;assert.equal(suggestSearchQueries('Книга',array).suggestions.length,0);assert.equal(calls,0);
 assert.deepEqual(suggestSearchQueries('Цивилизация Мурдецов',rows),result);
 for(const options of [{limit:0},{limit:6},{intent:'url'}])assert.throws(()=>suggestSearchQueries('Книга',[],options),TypeError);
});
