const pending=new Set();
const native=()=>globalThis.window?.cotologyNative;
const open=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('cotology-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('items');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
function track(promise){pending.add(promise);promise.finally(()=>pending.delete(promise)).catch(()=>{});return promise;}
function changed(){globalThis.window?.dispatchEvent(new Event('gargantua-local-change'));}
export async function get(key){if(native())return native().get(key);const db=await open();return new Promise((resolve,reject)=>{const t=db.transaction('items','readonly'),r=t.objectStore('items').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);t.oncomplete=()=>db.close();t.onabort=()=>{db.close();reject(t.error);};});}
/** Visible metadata and the synchronization outbox share one commit. */
export function apply(operations){return track((async()=>{
 if(!Array.isArray(operations)||operations.length>12000)throw new Error('Слишком много изменений за одно сохранение');
 for(const op of operations){if(!op||!['put','remove'].includes(op.type)||typeof op.key!=='string'||!op.key||op.key.length>220)throw new Error('Недопустимая запись хранилища');}
 if(native()){if(typeof native().apply!=='function')throw new Error('Обновите приложение для надёжного сохранения библиотеки');await native().apply(operations);}
 else{const db=await open();await new Promise((resolve,reject)=>{const t=db.transaction('items','readwrite');try{const items=t.objectStore('items');for(const op of operations)op.type==='put'?items.put(op.value,op.key):items.delete(op.key);}catch(e){t.abort();reject(e);}t.oncomplete=()=>{db.close();resolve();};t.onabort=()=>{db.close();reject(t.error||new Error('Изменения не сохранены'));};t.onerror=()=>{};});}
 changed();
 })());}
export function put(key,value){return apply([{type:'put',key,value}]);}
export function remove(key){return apply([{type:'remove',key}]);}
async function scan(prefix,values){if(native())return native()[values?'entries':'keys'](prefix);const db=await open();return new Promise((resolve,reject)=>{const out=[],t=db.transaction('items','readonly'),r=values?t.objectStore('items').openCursor():t.objectStore('items').openKeyCursor();r.onsuccess=()=>{const c=r.result;if(c){if(String(c.key).startsWith(prefix))out.push(values?[c.key,c.value]:c.key);c.continue();}};t.oncomplete=()=>{db.close();resolve(out);};t.onabort=()=>{db.close();reject(t.error);};});}
export const entries=(prefix='')=>scan(prefix,true);
export const keys=(prefix='')=>scan(prefix,false);
export async function flush(){while(pending.size)await Promise.all([...pending]);if(native()?.flush)await native().flush();}
