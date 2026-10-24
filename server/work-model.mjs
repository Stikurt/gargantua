import {randomUUID} from 'node:crypto';
import {canonicalJson,makePublicationManifest,sha256} from './publication-model.mjs';

// Identity hints are constructed by supported server adapters, never accepted
// wholesale from upload bodies. A title match alone never merges works.
export async function assignBookModel(client,book,{source=null}={}){
 let work;
 if(source){
  if(!['ranobelib','gutenberg','openlibrary'].includes(source.provider)||typeof source.remoteId!=='string'||!/^[-a-zA-Z0-9_/]{1,150}$/.test(source.remoteId)||typeof source.variant!=='string'||!source.variant||source.variant.length>250)throw new Error('Invalid source identity');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73))',[source.provider+':'+source.remoteId]);
  work=(await client.query('SELECT work_id AS id FROM work_sources WHERE provider=$1 AND remote_id=$2',[source.provider,source.remoteId])).rows[0];
 }
 if(!work){work={id:randomUUID()};await client.query('INSERT INTO works(id,title,authors,identity_state) VALUES($1,$2,$3,$4)',[work.id,book.title,JSON.stringify(book.author?[book.author]:[]),source?'source-bound':'unverified']);if(source)await client.query('INSERT INTO work_sources(provider,remote_id,work_id) VALUES($1,$2,$3)',[source.provider,source.remoteId,work.id]);}
 const expressionId=randomUUID(),variant=source?`${source.provider}:${source.variant}`:`unclassified:${expressionId}`;
 const language=book.language||'und',kind=source?.kind||'unclassified';
 let expression=(await client.query('INSERT INTO expressions(id,work_id,language,kind,variant_key,label) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(work_id,variant_key) DO NOTHING RETURNING id',[expressionId,work.id,language,kind,variant,source?.label||''])).rows[0];
 if(!expression){expression=(await client.query('SELECT id,language,kind FROM expressions WHERE work_id=$1 AND variant_key=$2 FOR SHARE',[work.id,variant])).rows[0];if(!expression||expression.language!==language||expression.kind!==kind)throw Object.assign(new Error('Источник изменил язык или тип существующего варианта книги. Требуется уточнение.'),{code:'EXPRESSION_CONFLICT'});}
 const coverage=source?.coverage||{kind:'source-file',declaredChapters:book.chapters.length};
 if(!coverage||typeof coverage!=='object'||Array.isArray(coverage)||JSON.stringify(coverage).length>8192)throw new Error('Invalid source coverage');
 const editionId=randomUUID();await client.query('INSERT INTO editions(id,expression_id,source_kind,external_ids,coverage) VALUES($1,$2,$3,$4,$5)',[editionId,expression.id,source?.provider||'upload',JSON.stringify(source?{provider:source.provider,id:source.remoteId}:{}),JSON.stringify(coverage)]);
 return {work_id:work.id,expression_id:expression.id,edition_id:editionId};
}
export async function sealPublicationModel(client,row,book){
 const manifest=makePublicationManifest(row,book),checksum=sha256(Buffer.from(canonicalJson(manifest)));
 await client.query('UPDATE books SET publication_manifest=$1,publication_sha256=$2 WHERE id=$3 AND publication_manifest IS NULL',[JSON.stringify(manifest),checksum,row.id]);
 return {...row,publication_manifest:manifest,publication_sha256:checksum};
}
