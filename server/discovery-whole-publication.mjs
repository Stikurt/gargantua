import {canonicalJson,sha256} from './publication-model.mjs';
import {sourceChapterSelection,assertSelectionBooks} from './derived-selection.mjs';
import {validateDerivedManifest} from './derived-files.mjs';

// These markers come from server-owned relations, never titles or client DTOs.
// b is the fixed books alias used by every caller of this fragment.
export const WHOLE_PUBLICATION_METADATA_SQL=`
 (SELECT e.kind FROM expressions e WHERE e.id=b.expression_id) AS expression_kind,
 (SELECT i.kind FROM imports i WHERE i.id=b.import_id) AS import_kind,
 EXISTS(SELECT 1 FROM derived_results r WHERE r.manifest->'publicationIds' ? b.id::text) AS has_derived_lineage,
 EXISTS(SELECT 1 FROM ranobe_run_parts p WHERE p.book_id=b.id) AS is_ranobe_part`;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const no=reason=>({whole:false,reason,books:[]});
const seal=book=>HASH.test(book.publication_sha256??'')&&HASH.test(book.package_sha256??'')&&Number.isSafeInteger(book.chapter_count)&&book.chapter_count>=1&&book.chapter_count<=1000;

/** Whole-book reuse is separate from reading a valid partial publication.
 * v2 full coverage of an already partial ancestor is still partial: recurse.
 * Files are checked by the acquisition callback, under these same row locks.
 */
export async function wholeLibraryPublication(client,book,{lock=false,ancestors=new Set()}={}){
 if(!book||!UUID.test(book.id??'')||ancestors.has(book.id)||ancestors.size>=16)return no('MISSING_OR_CYCLIC_LINEAGE');
 if(book.security_state!==undefined&&book.security_state!=='passed')return no('PUBLICATION_BLOCKED');
 if(book.is_ranobe_part===true)return no('SOURCE_ADAPTER_PACKET');
 const machine=book.expression_kind==='machine-translation'||book.import_kind==='derived-translation'||book.has_derived_lineage===true;
 if(!machine)return {whole:true,reason:'ORDINARY_PUBLICATION',books:[book]};
 if(book.expression_kind!=='machine-translation'||!UUID.test(book.expression_id??'')||!UUID.test(book.work_id??'')||!UUID.test(book.edition_id??'')||!seal(book))return no('MISSING_TRANSLATION_LINEAGE');
 const share=lock?' FOR SHARE':'',expression=(await client.query('SELECT * FROM expressions WHERE id=$1'+share,[book.expression_id])).rows[0];
 if(expression?.kind!=='machine-translation'||expression.work_id!==book.work_id||expression.language!==book.language)return no('TRANSLATION_EXPRESSION_MISMATCH');
 const origins=(await client.query(`SELECT r.*,j.kind AS job_kind,j.status AS job_status,j.total_segments AS job_total_segments,j.completed_segments AS job_completed_segments,j.source_sha256 AS pinned_source_sha256,j.recipe_sha256 AS pinned_recipe_sha256,
  s.manifest AS source_manifest,s.work_id AS source_work_id,s.expression_id AS source_expression_id,s.snapshot_id AS source_snapshot_id,
  recipe.kind AS recipe_kind,recipe.language AS recipe_language,recipe.manifest AS recipe_manifest
  FROM derived_results r JOIN derived_jobs j ON j.id=r.job_id JOIN derived_sources s ON s.sha256=j.source_sha256 JOIN derived_recipes recipe ON recipe.sha256=j.recipe_sha256
  WHERE r.expression_id=$1 AND r.manifest->'publicationIds' ? $2 ORDER BY r.job_id LIMIT 2${lock?' FOR SHARE OF r,j,s,recipe':''}`,[book.expression_id,book.id])).rows;
 if(origins.length!==1)return no('MISSING_OR_AMBIGUOUS_TRANSLATION_ORIGIN');
 const origin=origins[0],manifest=origin.manifest,source=origin.source_manifest;
 try{validateDerivedManifest(manifest,origin.job_id);}catch{return no('MULTIPART_OR_INVALID_TRANSLATION_RESULT');}
 if(origin.job_kind!=='translation'||origin.job_status!=='completed'||origin.recipe_kind!=='translation'||origin.recipe_language!==book.language||!record(origin.recipe_manifest)||origin.work_id!==book.work_id||origin.edition_id!==book.edition_id||origin.source_work_id!==book.work_id||expression.source_expression_id!==origin.source_expression_id||manifest.kind!=='translation'||manifest.sourceSha256!==origin.pinned_source_sha256||manifest.recipeSha256!==origin.pinned_recipe_sha256||manifest.publicationIds.length!==1||manifest.publicationIds[0]!==book.id||!Number.isSafeInteger(origin.job_total_segments)||origin.job_total_segments<1||origin.job_total_segments>50000||origin.job_completed_segments!==origin.job_total_segments||manifest.segments.length!==origin.job_total_segments)return no('MULTIPART_OR_INVALID_TRANSLATION_RESULT');
 if(!record(source)||![1,2].includes(source.schemaVersion)||source.workId!==origin.source_work_id||source.expressionId!==origin.source_expression_id||source.snapshotId!==origin.source_snapshot_id||!Array.isArray(source.parts)||source.parts.length!==1||!record(source.parts[0])||source.parts[0].ordinal!==0||!Number.isSafeInteger(source.parts[0].chapterCount)||source.parts[0].chapterCount!==book.chapter_count)return no('MULTIPART_OR_PARTIAL_TRANSLATION_SOURCE');
 if(sha256(Buffer.from(canonicalJson(source)))!==origin.pinned_source_sha256||sha256(Buffer.from(canonicalJson({kind:origin.recipe_kind,language:origin.recipe_language,manifest:origin.recipe_manifest})))!==origin.pinned_recipe_sha256||sha256(Buffer.from(canonicalJson(manifest)))!==origin.sha256||Buffer.byteLength(canonicalJson(manifest))!==Number(origin.bytes))return no('TRANSLATION_LINEAGE_HASH_MISMATCH');
 let selection;try{selection=sourceChapterSelection({manifest:source});}catch{return no('INVALID_TRANSLATION_COVERAGE');}
 if(selection&&(selection.start!==1||selection.count!==selection.total||selection.total!==book.chapter_count))return no('PARTIAL_TRANSLATION_COVERAGE');
 const parts=(await client.query(`SELECT b.*,p.ordinal,p.publication_sha256 AS pinned_publication_sha256,p.package_sha256 AS pinned_package_sha256,${WHOLE_PUBLICATION_METADATA_SQL}
  FROM derived_source_parts p JOIN books b ON b.id=p.book_id WHERE p.source_sha256=$1 ORDER BY p.ordinal${lock?' FOR SHARE OF p,b':''}`,[origin.pinned_source_sha256])).rows;
 const original=parts[0],pin=source.parts[0];
 if(parts.length!==1||original.ordinal!==0||original.id!==pin.publicationId||original.work_id!==book.work_id||original.expression_id!==origin.source_expression_id||original.edition_id!==pin.editionId||original.chapter_count!==pin.chapterCount||original.security_state!=='passed'||!original.artifact_manifest||!original.publication_manifest||!seal(original)||original.publication_sha256!==pin.publicationSha256||original.package_sha256!==pin.packageSha256||original.publication_sha256!==original.pinned_publication_sha256||original.package_sha256!==original.pinned_package_sha256)return no('TRANSLATION_SOURCE_BLOCKED_OR_CHANGED');
 try{assertSelectionBooks({manifest:source,parts:[original]});}catch{return no('TRANSLATION_CHAPTER_IDENTITY_MISMATCH');}
 const edition=(await client.query('SELECT expression_id FROM editions WHERE id=$1'+share,[book.edition_id])).rows[0];if(edition?.expression_id!==book.expression_id)return no('TRANSLATION_EDITION_MISMATCH');
 const previous=await wholeLibraryPublication(client,original,{lock,ancestors:new Set([...ancestors,book.id])});
 return previous.whole?{whole:true,reason:'VERIFIED_COMPLETE_SINGLE_TRANSLATION',books:[book,...previous.books]}:no(previous.reason);
}
