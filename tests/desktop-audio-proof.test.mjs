// Synthetic evidence parser tests only. These never execute a fake EXE and do
// not claim a real native capability observation or any actual voice output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadDesktopAudioProof} from '../scripts/desktop-audio-proof.mjs';
import {captureRealDelivery} from '../scripts/real-delivery-capture.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const capabilities={schemaVersion:1,platform:'windows',maxAudioBytes:16*1024**3,freeReserveBytes:512*1024**2,maxSegments:8192};
async function fixture(run){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-native-audio-proof-')),release=path.join(root,'release'),proofPath=path.join(root,'audio-online-report.json'),desktopExe=path.join(release,'Cotology.exe');await fs.mkdir(release);
 const paths=['Cotology.exe','resources/app/main.cjs','resources/app/preload.cjs','resources/app/audio-store.cjs','resources/app/audio-service.cjs','resources/app/audio.mjs','resources/app/dist/index.html','resources/app/package.json','LICENSE','resources/app/dist/assets/app.js'],files=[];
 for(const relative of paths){const bytes=Buffer.from('Synthetic evidence parser fixture: '+relative),file=path.join(release,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);files.push({path:relative,bytes:bytes.length,sha256:sha(bytes)});}
 const manifest={schemaVersion:1,kind:'gargantua-desktop-release',status:'complete',files},manifestBytes=Buffer.from(JSON.stringify(manifest)),manifestPath=path.join(release,'release-manifest.json');await fs.writeFile(manifestPath,manifestBytes);await fs.writeFile(path.join(release,'release-manifest.sha256'),sha(manifestBytes)+'  release-manifest.json\n');
 const report={ok:true,results:[{name:'Windows native audio capability is confirmed through restricted IPC',ok:true}],nativeAudioProof:{schemaVersion:1,kind:'gargantua-native-audio-capability-proof',executable:desktopExe,observedAt:new Date().toISOString(),releaseManifestSha256:sha(manifestBytes),rendererIpcEchoMatches:true,capabilities}},save=async()=>fs.writeFile(proofPath,JSON.stringify(report));await save();
 try{await run({root,release,proofPath,desktopExe,report,manifest,manifestPath,save});}finally{await fs.rm(root,{recursive:true,force:true});}
}
test('a complete local proof binds strict native capability and every exact release file',()=>fixture(async({proofPath,desktopExe})=>{
 const proof=await loadDesktopAudioProof({proofPath,desktopExe});assert.equal(proof.allReleaseFilesSha256Verified,true);assert.equal(proof.filesChecked,10);assert.equal(proof.limits.maxBytes,16*1024**3);assert.deepEqual(proof.capabilities,capabilities);assert.match(proof.proofSha256,/^[a-f0-9]{64}$/);
}));
test('a bare, failed, stale or wrong-executable capability claim never raises the capture limit',()=>fixture(async({proofPath,desktopExe,report,save})=>{
 const original=structuredClone(report);
 for(const mutate of [value=>value.ok=false,value=>value.results=[],value=>value.nativeAudioProof.rendererIpcEchoMatches=false,value=>value.nativeAudioProof.observedAt=new Date(Date.now()-25*60*60*1000).toISOString(),value=>value.nativeAudioProof.executable=path.join(path.dirname(desktopExe),'other','Cotology.exe'),value=>value.nativeAudioProof.capabilities.maxAudioBytes=32*1024**3,value=>value.nativeAudioProof.releaseManifestSha256='0'.repeat(64)]){
  Object.keys(report).forEach(key=>delete report[key]);Object.assign(report,structuredClone(original));mutate(report);await save();await assert.rejects(()=>loadDesktopAudioProof({proofPath,desktopExe}));
 }
 await fs.writeFile(proofPath,JSON.stringify(capabilities));await assert.rejects(()=>loadDesktopAudioProof({proofPath,desktopExe}),/evidence/);
}));
test('modified release bytes cannot be justified by a previously successful native report',()=>fixture(async({proofPath,desktopExe,release})=>{
 await fs.appendFile(path.join(release,'resources/app/audio-store.cjs'),'changed');await assert.rejects(()=>loadDesktopAudioProof({proofPath,desktopExe}),/hash mismatch/);
}));
test('capture rejects incomplete proof parameters before credentials, network or destination writes',async()=>{
 const missing=path.join(os.tmpdir(),'nonexistent-'+Date.now()),spec={schemaVersion:1,kind:'gargantua-real-delivery-spec',groups:[{requestId:'b1000000-0000-4000-8000-000000000001',expectedChapters:275}]};
 for(const input of [{desktopExe:missing},{desktopAudioProof:missing}])await assert.rejects(()=>captureRealDelivery({spec,destination:missing,credentials:missing,...input}),/both required/);
 await assert.rejects(()=>fs.stat(missing),{code:'ENOENT'});
});
test('linked or escaped release inventory entries cannot become capability proof',()=>fixture(async({proofPath,desktopExe,release,manifest,manifestPath,report,save})=>{
 manifest.files[0].path='../Cotology.exe';const bytes=Buffer.from(JSON.stringify(manifest));await fs.writeFile(manifestPath,bytes);await fs.writeFile(path.join(release,'release-manifest.sha256'),sha(bytes)+'  release-manifest.json\n');report.nativeAudioProof.releaseManifestSha256=sha(bytes);await save();await assert.rejects(()=>loadDesktopAudioProof({proofPath,desktopExe}),/Unsafe/);
}));
