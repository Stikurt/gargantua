import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AUDIO_LIMITS,audioSegmentPath,validateAudioManifest,parseAudioManifest,audioSha256,validateAudioWav,verifyAudioChunk,audioSummary,assertAudioDownloadable,audioDownloadLimits,normalizeAudioPosition,absoluteAudioPosition,seekAudioPosition,advanceAudioPosition} from '../src/audio.mjs';

const jobId='a0000000-0000-4000-8000-000000000001',workId='a0000000-0000-4000-8000-000000000002',expressionId='a0000000-0000-4000-8000-000000000003',editionId='a0000000-0000-4000-8000-000000000004';
const digest='a'.repeat(64),source='b'.repeat(64),recipe='c'.repeat(64),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const options={manifestSha256:digest,updatedAt:123456};
function manifest(durations=[2,3,5]){
 return {schemaVersion:1,jobId,kind:'audio',sourceSha256:source,recipeSha256:recipe,quality:'technical-unlistened',workId,expressionId,editionId,
  segments:durations.map((durationSeconds,ordinal)=>({ordinal,sha256:digest,bytes:44+Math.round(durationSeconds*22050)*2,mediaType:'audio/wav',durationSeconds,sampleRate:22050,url:audioSegmentPath(jobId,ordinal)}))};
}
function wav(frames=2205,{dataFirst=false}={}){
 const bytes=Buffer.alloc(44+frames*2);bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);
 const fmt=dataFirst?20+frames*2:12,data=dataFirst?12:36;
 bytes.write('fmt ',fmt);bytes.writeUInt32LE(16,fmt+4);bytes.writeUInt16LE(1,fmt+8);bytes.writeUInt16LE(1,fmt+10);bytes.writeUInt32LE(22050,fmt+12);bytes.writeUInt32LE(44100,fmt+16);bytes.writeUInt16LE(2,fmt+20);bytes.writeUInt16LE(16,fmt+22);
 bytes.write('data',data);bytes.writeUInt32LE(frames*2,data+4);
 for(let index=0;index<frames;index++)bytes.writeInt16LE(Math.round(Math.sin(index/12)*4000),data+8+index*2);
 return bytes;
}
function descriptor(bytes,ordinal=0){const pcm=validateAudioWav(bytes);return {ordinal,sha256:hash(bytes),bytes:bytes.length,mediaType:'audio/wav',durationSeconds:pcm.durationSeconds,sampleRate:22050,url:audioSegmentPath(jobId,ordinal)};}
const integrity=fn=>assert.throws(fn,error=>error.code==='AUDIO_INTEGRITY');

test('public manifest is a detached, path-independent DTO with exact expected identity',()=>{
 const original=manifest(),checked=validateAudioManifest(original,{expectedJobId:jobId});assert.deepEqual(checked,original);assert.notEqual(checked,original);assert.notEqual(checked.segments,original.segments);assert.notEqual(checked.segments[0],original.segments[0]);
 original.segments[0].url='https://evil.invalid/';assert.equal(checked.segments[0].url,audioSegmentPath(jobId,0));
 integrity(()=>validateAudioManifest(checked,{expectedJobId:workId}));
});
test('untrusted URL destinations, traversal and alternate job routes never become audio locations',()=>{
 for(const url of ['https://evil.invalid/audio.wav','//evil.invalid/audio.wav','file:///C:/Windows/x','javascript:alert(1)','data:audio/wav;base64,AAAA','/api/derived/jobs/'+jobId+'/segments/0','/api/derived/jobs/'+workId+'/audio/segments/0','/api/derived/jobs/'+jobId+'/audio/segments/00','/api/derived/jobs/'+jobId+'/audio/segments/0?x=1','/api/derived/jobs/'+jobId+'/audio/segments/0/../1','/api/derived/jobs/'+jobId+'/audio/segments/%30']){
  const value=manifest();value.segments[0].url=url;integrity(()=>validateAudioManifest(value));
 }
});
test('strict top-level and segment fields reject paths, HTML metadata and prototype payloads',()=>{
 for(const extra of [{filePath:'C:/private'},{publications:[]},{title:'<img src=x onerror=alert(1)>'},{__extra:true}])integrity(()=>validateAudioManifest({...manifest(),...extra}));
 for(const extra of [{path:'../../x'},{html:'<script>'},{channels:1},{attemptId:workId}]){const value=manifest();Object.assign(value.segments[0],extra);integrity(()=>validateAudioManifest(value));}
 integrity(()=>validateAudioManifest(JSON.parse('{"__proto__":{"polluted":true}}')));
 integrity(()=>validateAudioManifest(Object.assign(Object.create({inherited:true}),manifest())));
 assert.equal({}.polluted,undefined);
});
test('manifest identity, hashes, version, kind and technical quality are mandatory',()=>{
 for(const [key,value]of [['jobId',jobId.toUpperCase()],['jobId','../x'],['workId',null],['expressionId',workId.replace('-4000-','-0000-')],['editionId','x'.repeat(36)],['sourceSha256','A'.repeat(64)],['recipeSha256','c'.repeat(63)],['schemaVersion','1'],['kind','translation'],['quality','human-approved']])integrity(()=>validateAudioManifest({...manifest(),[key]:value}));
});
test('segments are dense, ordered, finite and bound to exact PCM byte counts',()=>{
 for(const change of [s=>s.ordinal=1,s=>s.ordinal='0',s=>s.sha256='x'.repeat(64),s=>s.bytes++,s=>s.bytes=Infinity,s=>s.mediaType='text/html',s=>s.durationSeconds=NaN,s=>s.durationSeconds=0,s=>s.durationSeconds=180.1,s=>s.durationSeconds+=0.5/22050,s=>s.sampleRate=44100]){const value=manifest();change(value.segments[0]);integrity(()=>validateAudioManifest(value));}
 for(const segments of [[],null,[,manifest().segments[0]],Array(AUDIO_LIMITS.segments+1)])integrity(()=>validateAudioManifest({...manifest(),segments}));
});
test('format accepts large server plans while local downloads enforce both independent budgets',()=>{
 const large=manifest(Array.from({length:AUDIO_LIMITS.downloadSegments+1},()=>0.1));assert.equal(validateAudioManifest(large).segments.length,8193);assert.throws(()=>assertAudioDownloadable(large),error=>error.code==='AUDIO_STORAGE_LIMIT');
 const expensive=manifest(Array.from({length:1100},()=>180));assert.ok(audioSummary(expensive).totalBytes>AUDIO_LIMITS.totalBytes);assert.throws(()=>assertAudioDownloadable(expensive),error=>error.code==='AUDIO_STORAGE_LIMIT');
 const small=manifest([0.1]);assert.deepEqual(assertAudioDownloadable(small),audioSummary(small));assert.throws(()=>assertAudioDownloadable(small,{maxBytes:small.segments[0].bytes-1}),error=>error.code==='AUDIO_STORAGE_LIMIT');
 for(const value of [{maxBytes:AUDIO_LIMITS.totalBytes+1},{maxSegments:8193},{maxBytes:0},{maxSegments:0},{maxBytes:Infinity}])integrity(()=>assertAudioDownloadable(small,value));
});
test('only an explicit bounded Windows native capability admits more than the default 8 GiB',()=>{
 const capabilities={schemaVersion:1,platform:'windows',maxAudioBytes:16*1024**3,freeReserveBytes:512*1024**2,maxSegments:8192},large=manifest(Array(1200).fill(180));
 assert.equal(AUDIO_LIMITS.totalBytes,8*1024**3);assert.ok(audioSummary(large).totalBytes>8*1024**3);assert.throws(()=>assertAudioDownloadable(large),{code:'AUDIO_STORAGE_LIMIT'});assert.equal(assertAudioDownloadable(large,{capabilities}).segments,1200);
 assert.deepEqual(audioDownloadLimits(),{maxBytes:8*1024**3,maxSegments:8192});assert.deepEqual(audioDownloadLimits(capabilities),{maxBytes:16*1024**3,maxSegments:8192});
 assert.throws(()=>assertAudioDownloadable(manifest(Array(2200).fill(180)),{capabilities}),{code:'AUDIO_STORAGE_LIMIT'});assert.throws(()=>assertAudioDownloadable(manifest(Array(8193).fill(.1)),{capabilities}),{code:'AUDIO_STORAGE_LIMIT'});
 for(const change of [{maxAudioBytes:32*1024**3},{platform:'android'},{freeReserveBytes:0},{maxSegments:50000},{schemaVersion:2},{maxAudioBytes:'17179869184'},{freeBytes:100000000000}])integrity(()=>audioDownloadLimits({...capabilities,...change}));
 for(const value of [null,{},Object.assign(Object.create(capabilities),{})])integrity(()=>audioDownloadLimits(value));
 integrity(()=>assertAudioDownloadable(large,{maxBytes:16*1024**3}));integrity(()=>assertAudioDownloadable(large,{capabilities,maxBytes:16*1024**3+1}));
});
test('summary uses original recording duration, independent of playback rate',()=>{
 assert.deepEqual(audioSummary(manifest()),{totalBytes:3*44+10*44100,totalDurationSeconds:10,segments:3});
 assert.equal(seekAudioPosition(manifest(),4,{...options,rate:2}).seconds,2);
});
test('manifest byte SHA binds the exact response, including noncanonical whitespace',async()=>{
 const bytes=Buffer.from(JSON.stringify(manifest(),null,2)),expectedSha256=hash(bytes),parsed=await parseAudioManifest(bytes,{expectedSha256,expectedJobId:jobId});
 assert.equal(parsed.sha256,expectedSha256);assert.deepEqual(parsed.manifest,manifest());assert.equal(await audioSha256(bytes.subarray()),expectedSha256);
 const changed=Buffer.from(JSON.stringify(manifest()));assert.notEqual(hash(changed),expectedSha256);await assert.rejects(parseAudioManifest(changed,{expectedSha256}),error=>error.code==='AUDIO_INTEGRITY');
});
test('manifest parser rejects HTML, malformed UTF-8, oversized data and wrong binding',async()=>{
 for(const bytes of [new Uint8Array(),Buffer.from('<html>Login</html>'),Uint8Array.of(0xff,0xfe),new Uint8Array(AUDIO_LIMITS.manifestBytes+1)])await assert.rejects(parseAudioManifest(bytes),error=>error.code==='AUDIO_INTEGRITY');
 const bytes=Buffer.from(JSON.stringify(manifest()));await assert.rejects(parseAudioManifest(bytes,{expectedSha256:'A'.repeat(64)}),error=>error.code==='AUDIO_INTEGRITY');await assert.rejects(parseAudioManifest(bytes,{expectedJobId:workId}),error=>error.code==='AUDIO_INTEGRITY');
 await assert.rejects(parseAudioManifest('not binary'),error=>error.code==='AUDIO_INTEGRITY');
});
test('canonical segment route never accepts UUID or ordinal string interpolation attacks',()=>{
 assert.equal(audioSegmentPath(jobId,49999),`/api/derived/jobs/${jobId}/audio/segments/49999`);
 for(const id of [null,jobId.toUpperCase(),jobId+'/../../x','00000000-0000-0000-0000-000000000000'])integrity(()=>audioSegmentPath(id,0));
 for(const ordinal of [-1,50000,0.5,'0',NaN,Infinity])integrity(()=>audioSegmentPath(jobId,ordinal));
});
test('verified chunk binds PCM, descriptor size, checksum and duration',async()=>{
 const bytes=wav(),segment=descriptor(bytes),checked=await verifyAudioChunk(bytes,segment);
 assert.deepEqual(checked,{frames:2205,sampleRate:22050,channels:1,sampleWidth:2,durationSeconds:0.1,sha256:hash(bytes),bytes:bytes.length});
 await assert.rejects(verifyAudioChunk(bytes.subarray(0,-2),segment),error=>error.code==='AUDIO_INTEGRITY');
 const changed=Buffer.from(bytes);changed[100]^=1;await assert.rejects(verifyAudioChunk(changed,segment),error=>error.code==='AUDIO_INTEGRITY');
 await assert.rejects(verifyAudioChunk(bytes,{...segment,sha256:source}),error=>error.code==='AUDIO_INTEGRITY');
 await assert.rejects(verifyAudioChunk(bytes,{...segment,durationSeconds:0.2}),error=>error.code==='AUDIO_INTEGRITY');
 await assert.rejects(verifyAudioChunk(bytes,{...segment,url:audioSegmentPath(jobId,1)}),error=>error.code==='AUDIO_INTEGRITY');
});
test('PCM verification respects Uint8Array slice boundaries and permits safe data-first WAV',async()=>{
 for(const bytes of [wav(),wav(2205,{dataFirst:true})]){
  const surrounded=Buffer.concat([Buffer.alloc(13,9),bytes,Buffer.alloc(19,8)]),slice=new Uint8Array(surrounded.buffer,surrounded.byteOffset+13,bytes.length);
  assert.equal((await verifyAudioChunk(slice,descriptor(bytes))).bytes,bytes.length);
  assert.equal((await verifyAudioChunk(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),descriptor(bytes))).frames,2205);
 }
});
test('strict WAV reader rejects format confusion, trailing payloads, truncation and unsupported chunks',()=>{
 const base=wav();
 for(const mutate of [b=>b.write('RF64',0),b=>b.write('HTML',8),b=>b.writeUInt32LE(2,4),b=>b.writeUInt32LE(17,16),b=>b.writeUInt16LE(3,20),b=>b.writeUInt16LE(2,22),b=>b.writeUInt32LE(44100,24),b=>b.writeUInt32LE(44099,28),b=>b.writeUInt16LE(4,32),b=>b.writeUInt16LE(32,34),b=>b.write('LIST',36),b=>b.writeUInt32LE(0xffffffff,40)]){const bytes=Buffer.from(base);mutate(bytes);integrity(()=>validateAudioWav(bytes));}
 integrity(()=>validateAudioWav(base.subarray(0,-1)));
 const appended=Buffer.concat([base,Buffer.from('<script>evil</script>')]);integrity(()=>validateAudioWav(appended));appended.writeUInt32LE(appended.length-8,4);integrity(()=>validateAudioWav(appended));
 const repeated=Buffer.concat([base,Buffer.from('data\0\0\0\0')]);repeated.writeUInt32LE(repeated.length-8,4);integrity(()=>validateAudioWav(repeated));
});
test('silence, clipping, too-short recordings and overlong recordings fail closed',()=>{
 const silent=wav();silent.fill(0,44);integrity(()=>validateAudioWav(silent));
 const clipped=wav();for(let offset=44;offset<clipped.length;offset+=2)clipped.writeInt16LE(32767,offset);integrity(()=>validateAudioWav(clipped));
 integrity(()=>validateAudioWav(wav(2204)));integrity(()=>validateAudioWav(wav(180*22050+1)));
});
test('a correctly checksummed foreign WAV still fails the PCM contract',async()=>{
 const bytes=wav(),segment=descriptor(bytes);bytes.writeUInt32LE(44100,24);segment.sha256=hash(bytes);
 await assert.rejects(verifyAudioChunk(bytes,segment),error=>error.code==='AUDIO_INTEGRITY');
});
test('seeking at chapter boundaries advances exactly once and completion is only at recording end',()=>{
 const value=manifest();assert.deepEqual(seekAudioPosition(value,0,options),{jobId,manifestSha256:digest,ordinal:0,seconds:0,rate:1,updatedAt:123456,completed:false});
 assert.equal(seekAudioPosition(value,1.25,options).seconds,1.25);
 assert.deepEqual(seekAudioPosition(value,2,options),{jobId,manifestSha256:digest,ordinal:1,seconds:0,rate:1,updatedAt:123456,completed:false});
 assert.deepEqual(seekAudioPosition(value,5,options),{jobId,manifestSha256:digest,ordinal:2,seconds:0,rate:1,updatedAt:123456,completed:false});
 assert.deepEqual(seekAudioPosition(value,10,options),{jobId,manifestSha256:digest,ordinal:2,seconds:5,rate:1,updatedAt:123456,completed:true});
});
test('seek clamps only explicit user requests, never NaN or Infinity from media metadata',()=>{
 const value=manifest();assert.equal(seekAudioPosition(value,-10,options).seconds,0);assert.equal(seekAudioPosition(value,99,options).seconds,5);assert.equal(seekAudioPosition(value,99,options).completed,true);
 for(const seconds of [NaN,Infinity,-Infinity,'4'])integrity(()=>seekAudioPosition(value,seconds,options));
});
test('saved boundary positions normalize without resetting progress or updating the timestamp',()=>{
 const value=manifest(),saved={jobId,manifestSha256:digest,ordinal:0,seconds:2,rate:1.25,updatedAt:42,completed:false};
 assert.deepEqual(normalizeAudioPosition(value,saved,{manifestSha256:digest}),{...saved,ordinal:1,seconds:0});assert.equal(saved.ordinal,0);
 assert.equal(normalizeAudioPosition(value,{...saved,ordinal:2,seconds:5}).completed,true);
 assert.equal(normalizeAudioPosition(value,{...saved,ordinal:1,seconds:1,completed:true}).completed,false);
});
test('invalid, foreign or unavailable local positions return null and leave good progress intact',()=>{
 const value=manifest(),saved=seekAudioPosition(value,6,{...options,rate:1.5});const before=structuredClone(saved);
 for(const position of [null,{}, {...saved,jobId:workId},{...saved,manifestSha256:source},{...saved,ordinal:-1},{...saved,ordinal:3},{...saved,seconds:NaN},{...saved,seconds:Infinity},{...saved,seconds:-1},{...saved,seconds:6},{...saved,updatedAt:-1},{...saved,completed:'yes'},{...saved,rate:3}])assert.equal(normalizeAudioPosition(value,position,{manifestSha256:digest}),null);
 assert.deepEqual(saved,before);assert.deepEqual(normalizeAudioPosition(value,saved,{manifestSha256:digest}),saved);assert.equal(absoluteAudioPosition(value,{...saved,seconds:NaN}),null);
});
test('speed is bounded, survives resume and does not alter absolute reading position',()=>{
 const value=manifest();for(const rate of [0.5,1,1.25,2]){const saved=seekAudioPosition(value,6,{...options,rate});assert.equal(normalizeAudioPosition(value,saved).rate,rate);assert.equal(absoluteAudioPosition(value,saved),6);assert.equal(advanceAudioPosition(value,saved,1,{updatedAt:200}).rate,rate);}
 for(const rate of [0.49,2.01,NaN,Infinity,'1'])integrity(()=>seekAudioPosition(value,1,{...options,rate}));
 const legacy=seekAudioPosition(value,3,options);delete legacy.rate;assert.equal(normalizeAudioPosition(value,legacy).rate,1);
});
test('position arithmetic roundtrips fractions across every segment and preserves completion boundaries',()=>{
 const value=manifest([0.1,1.7,0.2,3.1,0.1]),total=audioSummary(value).totalDurationSeconds;
 for(let index=0;index<=104;index++){const seconds=Math.min(total,index*0.05),position=seekAudioPosition(value,seconds,options),absolute=absoluteAudioPosition(value,position,{manifestSha256:digest});assert.ok(Math.abs(absolute-seconds)<0.000000001,`${seconds} -> ${absolute}`);assert.equal(position.completed,seconds>=total);}
});
test('skip commands cross chunk boundaries, preserve rate and cannot operate on another recording',()=>{
 const value=manifest(),saved=seekAudioPosition(value,1.5,{...options,rate:1.25});assert.deepEqual(advanceAudioPosition(value,saved,4,{updatedAt:999}),{jobId,manifestSha256:digest,ordinal:2,seconds:0.5,rate:1.25,updatedAt:999,completed:false});
 assert.equal(advanceAudioPosition(value,saved,-15,{updatedAt:999}).seconds,0);assert.equal(advanceAudioPosition(value,saved,60,{updatedAt:999}).completed,true);
 integrity(()=>advanceAudioPosition(value,{...saved,jobId:workId},1,options));integrity(()=>advanceAudioPosition(value,saved,NaN,options));
});
