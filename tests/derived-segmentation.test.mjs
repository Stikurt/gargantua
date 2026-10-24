import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makeDerivedPlan} from '../server/derived-plan.mjs';
import {PACKED_AUDIO_SEGMENTATION} from '../server/derived-audio-plan.mjs';
import {derivedSegmentationRevision,derivedPlanForRecipe,derivedSourceUnitForRecipe,requestDerived} from '../server/derived-orchestrator.mjs';

const source={sha256:'a'.repeat(64),parts:[{id:randomUUID()}]};
const content={title:'Оригинал',author:'Автор',language:'ru',assets:{},chapters:[{title:'Глава',blocks:[{type:'text',text:'Первый абзац.'},{type:'text',text:'Второй абзац.'}]}]};
const legacy={segmentationRevision:'derived-unicode-v1'},packed={segmentationRevision:PACKED_AUDIO_SEGMENTATION};
test('strict recipe dispatch preserves old audio/translation plans and selects packed new audio',async()=>{
 for(const kind of ['audio','translation'])assert.deepEqual(await derivedPlanForRecipe(source,async()=>content,kind,legacy),makeDerivedPlan(source,[content],kind));
 const plan=await derivedPlanForRecipe(source,async()=>content,'audio',packed);assert.equal(plan.segments,1);assert.equal(derivedSourceUnitForRecipe([content],plan.manifest.segments[0],'audio',packed),'Глава\n\nПервый абзац.\n\nВторой абзац.');
 assert.equal(derivedSourceUnitForRecipe([content],makeDerivedPlan(source,[content],'audio').manifest.segments[0],'audio',legacy),'Глава');
 assert.throws(()=>derivedSourceUnitForRecipe([content],plan.manifest.segments[0],'audio',legacy),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});
});
test('missing, unknown and wrong-kind segmentation revisions never silently fall back',async()=>{
 for(const recipe of [{},null,{segmentationRevision:'future-v9'},{segmentationRevision:PACKED_AUDIO_SEGMENTATION}]){
  if(recipe?.segmentationRevision===PACKED_AUDIO_SEGMENTATION){assert.throws(()=>derivedSegmentationRevision('translation',recipe),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});continue;}
  assert.throws(()=>derivedSegmentationRevision('audio',recipe),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});await assert.rejects(()=>derivedPlanForRecipe(source,async()=>{throw Error('Must not load source');},'audio',recipe),{code:'DERIVED_UNSUPPORTED_STRUCTURE'});
 }
});
test('same intent key resolves its original recipe before current profile registration',async()=>{
 const old={sha256:'b'.repeat(64),kind:'audio',manifest:{...legacy,glossary:{}}},calls=[],sentinel=Error('Pinned recipe reached existing transaction');
 const pool={query:async(sql,values)=>{calls.push({sql,values});return {rows:[old]};},connect:async()=>{throw sentinel;}};
 await assert.rejects(()=>requestDerived(pool,{id:randomUUID()},{idempotencyKey:randomUUID(),kind:'audio',publicationIds:[source.parts[0].id],sourceLanguage:'ru',audio:false}),error=>error===sentinel);
 assert.equal(calls.length,1);assert.match(calls[0].sql,/derived_idempotency/);
});
test('recipe reuse cannot hide a changed glossary or requested kind under a used key',async()=>{
 const old={sha256:'b'.repeat(64),kind:'translation',manifest:{...legacy,glossary:{Mira:'Мира'}}},pool={query:async()=>({rows:[old]}),connect:async()=>{throw Error('Must not enter transaction');}},profile={id:randomUUID()},input={idempotencyKey:randomUUID(),kind:'translation',publicationIds:[source.parts[0].id],sourceLanguage:'en',audio:false};
 for(const change of [{glossary:{Mira:'Другое имя'}},{kind:'audio'}])await assert.rejects(()=>requestDerived(pool,profile,{...input,...change}),{code:'DERIVED_IDEMPOTENCY',status:409});
 await assert.rejects(()=>requestDerived(pool,profile,{...input,glossary:{Mira:'Мира'}}),/Must not enter transaction/);
});
