// Run on the local host after setup. Creates benign demonstration data and
// security test requests. The antivirus marker is a standard inert test string.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.BASE_URL||'http://localhost:3080';
const credentials=JSON.parse((await fs.readFile('.local/login.txt','utf8')).replace(/^\uFEFF/,''));
let cookie='',csrf='';
async function call(route,options={}){
  const headers={'X-Cotology':'1','X-CSRF-Token':csrf,...options.headers};if(cookie)headers.Cookie=cookie;
  if(options.body&&!(options.body instanceof FormData)){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
  const r=await fetch(base+'/api'+route,{...options,headers});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  const body=await r.json();return {status:r.status,body};
}
async function upload(name,contents){const form=new FormData();form.append('file',new Blob([contents]),name);const response=await call('/imports/upload',{method:'POST',body:form});assert.equal(response.status,202,JSON.stringify(response.body));return response.body.id;}
async function wait(id){for(let n=0;n<100;n++){const list=await call('/imports');const row=list.body.find(x=>x.id===id);if(['completed','blocked','error'].includes(row?.status))return row;await new Promise(r=>setTimeout(r,1500));}throw new Error('Import timeout');}
assert.equal((await call('/books')).status,401);console.log('PASS: anonymous library denied');
assert.equal((await call('/login',{method:'POST',body:{login:credentials.login,password:credentials.password}})).status,200);
const me=(await call('/me')).body;csrf=me.csrf;
const forbidden=await fetch(base+'/api/imports/link',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({url:'https://example.com/a.epub',kind:'file'})});assert.equal(forbidden.status,403);console.log('PASS: CSRF header required');
const fb2=`<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><genre>reference</genre><author><first-name>Cotology</first-name></author><book-title>Путеводитель по тихой библиотеке</book-title><lang>ru</lang></title-info></description><body><section><title><p>Глава первая. Своя полка</p></title><p>У каждой истории должно быть место, куда хочется вернуться. Эта небольшая книга создана специально для проверки вашей библиотеки: она не загружена с внешнего сайта.</p><p>Откройте оглавление, измените размер шрифта и переключите тему. Чтение должно оставаться спокойным и удобным на любом экране.</p><p>Закладка сохраняет выбранное место. Позиция чтения запоминается отдельно, поэтому можно возвращаться к любимым отрывкам, не теряя последнюю страницу.</p></section><section><title><p>Глава вторая. Взять с собой</p></title><p>Кнопка со стрелкой загрузки сохраняет всю книгу на этом устройстве. После подтверждения можно выключить сервер и продолжить чтение.</p><p>Обычное открытие главы не означает, что вся книга уже скачана. В локальной библиотеке отмечаются только полностью сохранённые экземпляры.</p><p>Заметки и позиции чтения, оставленные без сервера, будут отправлены при следующем открытии библиотеки и доступном соединении.</p></section><section><title><p>Глава третья. Доверять проверкам</p></title><p>Новая книга сначала попадает в карантин. Исходный файл проверяется антивирусом, затем отдельный обработчик разбирает его без доступа к сети и базе данных.</p><p>Читалка получает подготовленный текст и иллюстрации после успешных проверок. При ошибке материал остаётся закрытым, даже если его добавил владелец.</p><p>Теперь можно добавить собственную книгу. Истории здесь принадлежат вашим полкам — а время чтения только вам.</p></section></body></FictionBook>`;
const good=await wait(await upload('cotology-guide.fb2',fb2));assert.equal(good.status,'completed',good.error);assert.equal(good.security_state,'passed');
const bookId=good.book_id;
const info=await call('/books/'+bookId);assert.equal(info.status,200);assert.equal(info.body.chapters.length,3);console.log('PASS: FB2 → quarantine → antivirus → isolated parser → publication');
const chapter=await call(`/books/${bookId}/chapters/0`);assert.ok(chapter.body.blocks.some(x=>x.text.includes('У каждой истории')));
assert.equal((await call(`/books/${bookId}/reading`,{method:'PUT',body:{chapter:1,position:.4,shelf:'reading'}})).status,200);
assert.equal((await call(`/books/${bookId}/bookmarks`,{method:'POST',body:{chapter:1,position:.4,note:'Проверочная закладка'}})).status,200);
assert.equal((await call('/books/'+bookId)).body.bookmarks.length,1);console.log('PASS: progress and bookmarks persist');
const pack=await call(`/books/${bookId}/download`);assert.equal(pack.status,200);assert.equal(pack.body.chapters.length,3);console.log('PASS: complete offline package issued');
const fake=await wait(await upload('not-a-book.txt','<html><body>Not a book</body></html>'));assert.equal(fake.status,'blocked');assert.equal(fake.book_id,null);console.log('PASS: disguised HTML is blocked, no book published');
const xxe=await wait(await upload('unsafe.fb2','<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><FictionBook><body><section><p>&a;</p></section></body></FictionBook>'));assert.ok(['blocked','error'].includes(xxe.status));assert.equal(xxe.book_id,null);console.log('PASS: external XML entities rejected');
const marker=['X5O!P%@AP[4','\\PZX54(P^)7CC)7}','$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');
const detected=await wait(await upload('antivirus-test.txt',marker));assert.equal(detected.status,'blocked',detected.error);assert.match(detected.error,/FOUND/);console.log('PASS: inert antivirus test marker detected and quarantined');
const review=await call('/imports/link',{method:'POST',body:{kind:'source-review',url:'https://example.com/book'}});assert.equal(review.status,202);
const approve=await call(`/imports/${review.body.id}/decision`,{method:'POST',body:{action:'approve'}});assert.equal(approve.status,400);console.log('PASS: unknown site cannot be auto-imported by approval');
const secretUrl=await call('/imports/link',{method:'POST',body:{kind:'file',url:'https://127.0.0.1/book.txt',filename:'book.txt'}});assert.equal(secretUrl.status,202);
const blockedUrl=await wait(secretUrl.body.id);assert.equal(blockedUrl.status,'error');assert.match(blockedUrl.error,/непубличный/);console.log('PASS: local network download blocked before connection');
await fs.writeFile('.local/test-book.json',JSON.stringify({id:bookId}));
console.log('Integration checks complete. Demonstration book ID:',bookId);
