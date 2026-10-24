import {importBook} from './import-book.mjs';
self.onmessage=({data})=>{try{self.postMessage({content:importBook(new Uint8Array(data.bytes),data.name)});}catch(error){self.postMessage({error:error.message||'Не удалось проверить книгу'});}};
