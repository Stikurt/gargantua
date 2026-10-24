/** Read-only presentation of immutable Ranobe snapshots as one logical book.
 * Publication IDs, chapter offsets and checksums come only from the source
 * ledger. A title, work ID or similar spelling never establishes membership.
 */
const LIMITS=Object.freeze({groups:100,parts:400,chapters:20000,bytes:4*1024*1024,books:20000});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA=/^[a-f0-9]{64}$/u;
const fail=message=>Object.assign(new Error(message),{status:503,code:'SERIAL_GROUPS_UNAVAILABLE'});
const id=value=>typeof value==='string'&&UUID.test(value);
const text=(value,max)=>typeof value==='string'&&value.isWellFormed()&&value.length<=max&&!/[\p{Cc}\p{Cf}]/u.test(value);

export function serialGroupView(feed,parts){
 if(!id(feed?.id)||!id(feed.snapshot_id)||!text(feed.title,300)||!feed.title||!text(feed.author,300)||!text(feed.language,30)||!text(feed.branch_key,20)||! /^(?:default|[0-9]{1,20})$/u.test(feed.branch_key)||!SHA.test(feed.inventory_sha256??'')||!['building','ready'].includes(feed.snapshot_status)||!Number.isSafeInteger(feed.chapter_count)||feed.chapter_count<1||feed.chapter_count>LIMITS.chapters||!Array.isArray(parts)||parts.length>LIMITS.parts)throw fail('Не удалось подтвердить состав объединённой книги');
 const seen=new Set();let end=0;
 const entries=parts.map(part=>{
  if(!id(part.book_id)||seen.has(part.book_id)||!Number.isSafeInteger(part.ordinal)||part.ordinal<end||!Number.isSafeInteger(part.chapter_count)||part.chapter_count<1||part.chapter_count>50||part.ordinal+part.chapter_count>feed.chapter_count||part.book_chapter_count!==part.chapter_count||!SHA.test(part.content_sha256??'')||!SHA.test(part.package_sha256??'')||part.package_sha256!==part.ledger_package_sha256||!['passed','blocked','pending','error','scanning'].includes(part.security_state))throw fail('Состав частей книги не прошёл проверку');
  seen.add(part.book_id);end=part.ordinal+part.chapter_count;
  return {publicationId:part.book_id,chapterOffset:part.ordinal,chapterCount:part.chapter_count,contentSha256:part.content_sha256,packageSha256:part.package_sha256,securityState:part.security_state==='passed'?'passed':part.security_state==='blocked'?'blocked':'pending'};
 });
 if(feed.snapshot_status==='ready'&&(end!==feed.chapter_count||entries.some((part,index)=>part.chapterOffset!==(index?entries[index-1].chapterOffset+entries[index-1].chapterCount:0))))throw fail('У готовой книги отсутствует часть оглавления');
 return {schemaVersion:1,id:feed.id,snapshotId:feed.snapshot_id,provider:'ranobelib',title:feed.title,author:feed.author,language:feed.language,branch:feed.branch_key,snapshotStatus:feed.snapshot_status,inventorySha256:feed.inventory_sha256,totalChapters:feed.chapter_count,parts:entries};
}

export async function listSerialGroups(pool,profile){
 if(!id(profile?.id)||typeof profile.role!=='string')throw fail('Не выбран профиль');
 const client=await pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='10s'");
  const feeds=(await client.query(`SELECT f.id,f.title,f.author,f.language,f.branch_key,r.id AS snapshot_id,r.status AS snapshot_status,r.inventory_sha256,r.chapter_count
   FROM ranobe_feeds f JOIN ranobe_runs r ON r.id=COALESCE(f.head_run_id,(SELECT current.id FROM ranobe_runs current WHERE current.feed_id=f.id AND current.status='building' LIMIT 1))
   WHERE $1::boolean OR f.head_run_id IS NOT NULL OR f.requested_by=$2 OR EXISTS(SELECT 1 FROM ranobe_feed_requests request WHERE request.feed_id=f.id AND request.profile_id=$2)
   ORDER BY f.updated_at DESC,f.id LIMIT $3`,[profile.role==='owner',profile.id,LIMITS.groups+1])).rows;
  if(feeds.length>LIMITS.groups)throw fail('Слишком много объединённых книг для одного списка');
  const rows=feeds.length?(await client.query(`SELECT p.run_id,p.book_id,p.ordinal,jsonb_array_length(p.source_keys) AS chapter_count,p.package_sha256 AS ledger_package_sha256,
    b.chapter_count AS book_chapter_count,b.content_sha256,b.package_sha256,b.security_state
    FROM ranobe_run_parts p JOIN books b ON b.id=p.book_id WHERE p.run_id=ANY($1::uuid[]) AND p.status='ready' ORDER BY p.run_id,p.ordinal LIMIT $2`,[feeds.map(feed=>feed.snapshot_id),LIMITS.groups*LIMITS.parts+1])).rows:[];
  if(rows.length>LIMITS.groups*LIMITS.parts)throw fail('Список частей превышает безопасный предел');
  const byRun=new Map(feeds.map(feed=>[feed.snapshot_id,[]]));for(const part of rows)byRun.get(part.run_id)?.push(part);
  const result={schemaVersion:1,groups:feeds.map(feed=>serialGroupView(feed,byRun.get(feed.snapshot_id)))};
  if(Buffer.byteLength(JSON.stringify(result))>LIMITS.bytes)throw fail('Список объединённых книг превышает безопасный размер');
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}

/** Stable membership hint, deliberately not a mutable snapshot pointer. A
 * publication reused by multiple snapshots stays byte-for-byte unchanged.
 * Cross-feed ambiguity is left explicit; clients must use the pinned manifest.
 */
export async function withSerialMembership(pool,books){
 if(!Array.isArray(books)||books.length>LIMITS.books||books.some(book=>!id(book?.id)))throw fail('Список публикаций превышает безопасный предел');
 if(!books.length)return books;
 const rows=(await pool.query('SELECT DISTINCT p.book_id,r.feed_id FROM ranobe_run_parts p JOIN ranobe_runs r ON r.id=p.run_id WHERE p.book_id=ANY($1::uuid[])',[books.map(book=>book.id)])).rows;
 const membership=new Map();for(const row of rows){const feeds=membership.get(row.book_id)??new Set();feeds.add(row.feed_id);membership.set(row.book_id,feeds);}
 return books.map(book=>{const feeds=membership.get(book.id);return feeds?.size===1?{...book,serial_feed_id:[...feeds][0]}:book;});
}
