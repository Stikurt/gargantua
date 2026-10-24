// Local test evidence, bound to the complete immutable desktop release. A bare
// caller-supplied capability object is never sufficient to raise capture limits.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {audioDownloadLimits} from '../src/audio.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const samePath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
async function ordinary(file,root){let current=file;for(;;){const info=await fs.lstat(current);if(info.isSymbolicLink())throw Error('Linked desktop proof/release path');if(current===root)break;const parent=path.dirname(current);if(parent===current)throw Error('Desktop proof path escaped release root');current=parent;}const info=await fs.stat(file);if(!info.isFile())throw Error('Desktop proof file is not ordinary');return info;}
async function fileHash(file){const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
export async function loadDesktopAudioProof({proofPath,desktopExe,now=Date.now()}={}){
 if(typeof proofPath!=='string'||typeof desktopExe!=='string'||!Number.isFinite(now))throw Error('Native audio proof and exact desktop executable are both required');
 const executable=path.resolve(desktopExe),root=path.dirname(executable),proofFile=path.resolve(proofPath);if(path.basename(executable)!=='Cotology.exe')throw Error('Native audio proof must identify Cotology.exe');
 const proofInfo=await ordinary(proofFile,path.dirname(proofFile));if(proofInfo.size<1||proofInfo.size>1024*1024)throw Error('Native audio proof exceeded its bound');
 const proofBytes=await fs.readFile(proofFile),report=JSON.parse(proofBytes),proof=report.nativeAudioProof;
 if(report.ok!==true||!proof||proof.schemaVersion!==1||proof.kind!=='gargantua-native-audio-capability-proof'||proof.rendererIpcEchoMatches!==true||!samePath(proof.executable,executable)||!Array.isArray(report.results)||!report.results.some(row=>row.name==='Windows native audio capability is confirmed through restricted IPC'&&row.ok===true))throw Error('Successful native IPC audio capability evidence is required');
 const observed=Date.parse(proof.observedAt);if(!Number.isFinite(observed)||observed>now+60000||now-observed>24*60*60*1000)throw Error('Native audio capability proof is stale or has a future timestamp');
 const limits=audioDownloadLimits(proof.capabilities),manifestPath=path.join(root,'release-manifest.json'),checksumPath=path.join(root,'release-manifest.sha256');
 const manifestInfo=await ordinary(manifestPath,root),checksumInfo=await ordinary(checksumPath,root);if(manifestInfo.size>1024*1024||checksumInfo.size>100)throw Error('Desktop release manifest exceeds its bound');
 const bytes=await fs.readFile(manifestPath),manifestSha256=hash(bytes),checksum=(await fs.readFile(checksumPath,'utf8')).trim();
 if(proof.releaseManifestSha256!==manifestSha256||checksum!==manifestSha256+'  release-manifest.json')throw Error('Native audio proof belongs to a different release');
 const manifest=JSON.parse(bytes);if(manifest.schemaVersion!==1||manifest.kind!=='gargantua-desktop-release'||manifest.status!=='complete'||!Array.isArray(manifest.files)||manifest.files.length<10||manifest.files.length>2000)throw Error('Invalid complete desktop release manifest');
 const seen=new Set();let totalBytes=0;
 for(const entry of manifest.files){
  const relative=entry.path;if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||/[\\:]/.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))||seen.has(relative.toLowerCase())||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>1024**3||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Unsafe desktop release inventory');
  seen.add(relative.toLowerCase());totalBytes+=entry.bytes;if(totalBytes>2*1024**3)throw Error('Desktop release inventory exceeds its bound');
  const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep))throw Error('Desktop release path escaped its root');const info=await ordinary(file,root);if(info.size!==entry.bytes||await fileHash(file)!==entry.sha256)throw Error('Desktop release file hash mismatch');
 }
 for(const required of ['Cotology.exe','resources/app/main.cjs','resources/app/preload.cjs','resources/app/audio-store.cjs','resources/app/audio-service.cjs','resources/app/audio.mjs','resources/app/dist/index.html'])if(!seen.has(required.toLowerCase()))throw Error('Native audio release omitted required files');
 if(hash(await fs.readFile(manifestPath))!==manifestSha256)throw Error('Desktop release changed during capability verification');
 return {schemaVersion:1,kind:'verified-local-native-audio-evidence',observedAt:proof.observedAt,executable,releaseManifestSha256:manifestSha256,proofSha256:hash(proofBytes),allReleaseFilesSha256Verified:true,filesChecked:seen.size,capabilities:structuredClone(proof.capabilities),limits};
}
