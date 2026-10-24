// One explicit acceptance import. No top-level network/file operations.
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SOURCE='https://www.gutenberg.org/ebooks/7256.epub3.images';
const fail=(message,code='EPUB_RECHECK_INTEGRITY')=>Object.assign(new Error(message),{code});
async function syncDirectory(directory){let handle;try{handle=await fs.open(directory,'r');await handle.sync();}catch(error){if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL','ENOTSUP'].includes(error.code))throw error;}finally{await handle?.close();}}
async function exclusiveIntent(filename,value,directory){let handle;try{handle=await fs.open(filename,'wx',0o600);}catch(error){if(error.code==='EEXIST')return false;throw error;}try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}await syncDirectory(directory);return true;}
async function saveState(stateFile,directory,state){const temporary=new URL('.state-'+randomUUID()+'.tmp',directory);let handle;try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(state,null,2)+'\n');await handle.sync();await handle.close();handle=null;await fs.rename(temporary,stateFile);await syncDirectory(directory);}finally{await handle?.close();await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
function checkedIntent(value,me){
 if(value?.schemaVersion!==1||value.action!=='recheck-book-epub'||!UUID.test(value.intentId??'')||value.ownerId!==me.id||value.sourceUrl!==SOURCE||!Number.isFinite(Date.parse(value.createdAt))||value.createdAt!==new Date(Date.parse(value.createdAt)).toISOString()||!Array.isArray(value.baselineImportIds)||value.baselineImportIds.some(id=>!UUID.test(id))||value.body?.kind!=='file'||value.body.url!==SOURCE||value.body.filename!==`The Gift of the Magi - EPUB recheck ${value.intentId}.epub`)throw fail('EPUB recheck intent does not match this owner and exact source');
 return value;
}
function exactMatches(imports,intent,state){
 if(!Array.isArray(imports))throw fail('Expected a bounded import list');const excluded=new Set([...intent.baselineImportIds,state.bookEpubImportId].filter(Boolean)),cutoff=Date.parse(intent.createdAt);
 return imports.filter(row=>row&&UUID.test(row.id??'')&&!excluded.has(row.id)&&row.kind==='file'&&row.source_url===SOURCE&&row.requested_by===intent.ownerId&&row.filename===intent.body.filename&&Number.isFinite(Date.parse(row.created_at))&&Date.parse(row.created_at)>=cutoff);
}
/** Existing intents are recovery-only, even if the original POST may not have
 * reached the server. This endpoint has no server idempotency key; silence is
 * not evidence that another POST is safe. The intent file's exclusive creation
 * grants exactly one invocation permission to dispatch the import. */
export async function recheckBookEpub({api,me,state,directory,stateFile}){
 if(me?.role!=='owner'||!UUID.test(me.id??''))throw fail('An authenticated server owner is required','EPUB_RECHECK_FORBIDDEN');
 const intentFile=new URL('book-epub-recheck-intent.json',directory);let intent,dispatch=false;
 try{intent=JSON.parse(await fs.readFile(intentFile,'utf8'));}catch(error){
  if(error.code!=='ENOENT')throw error;
  if(state.bookEpubRecheckImportId)throw fail('Saved recheck ID has no durable intent; refusing to create another import');
  const imports=await api('/imports');if(!Array.isArray(imports))throw fail('Expected a bounded import list');const intentId=randomUUID();intent={schemaVersion:1,action:'recheck-book-epub',intentId,ownerId:me.id,sourceUrl:SOURCE,createdAt:new Date().toISOString(),baselineImportIds:imports.filter(row=>row.source_url===SOURCE&&row.requested_by===me.id).map(row=>row.id),body:{url:SOURCE,kind:'file',filename:`The Gift of the Magi - EPUB recheck ${intentId}.epub`}};
  dispatch=await exclusiveIntent(intentFile,intent,directory);if(!dispatch)intent=JSON.parse(await fs.readFile(intentFile,'utf8'));
 }
 checkedIntent(intent,me);
 // Read before dispatch as well: recovery after a lost response must adopt
 // exactly one NEW row, including a blocked row, and never choose the old file.
 let matches=exactMatches(await api('/imports'),intent,state);
 if(matches.length>1)throw fail('Several new imports match the intent; no row was adopted','EPUB_RECHECK_AMBIGUOUS');
 let postError=null;
 if(!matches.length&&dispatch){
  try{const imported=await api('/imports/link',intent.body);if(!UUID.test(imported?.id??''))throw fail('Import response has no valid ID');}
  catch(error){postError=error;}
  // A transport failure can follow a committed INSERT. Resolve it using the
  // durable identity and timestamp instead of repeating the mutation.
  matches=exactMatches(await api('/imports'),intent,state);
 }
 if(matches.length!==1)throw fail('No unique new import found after the durable intent. Refusing a second POST; inspect server imports and this intent.','EPUB_RECHECK_UNCERTAIN');
 const imported=matches[0];if(state.bookEpubRecheckImportId&&state.bookEpubRecheckImportId!==imported.id)throw fail('Saved recheck ID differs from the exact accepted import');
 state.bookEpubRecheckImportId=imported.id;state.bookEpubRecheckIntent={intentId:intent.intentId,ownerId:intent.ownerId,createdAt:intent.createdAt,url:SOURCE,filename:intent.body.filename};await saveState(stateFile,directory,state);
 return {importId:imported.id,status:imported.status,newImport:true,recovered:!dispatch||Boolean(postError),intentId:intent.intentId,createdAfter:intent.createdAt,previousBlockedImportId:state.bookEpubImportId??null};
}
