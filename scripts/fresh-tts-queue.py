"""One explicit isolated DB/library, using the existing single CPU Piper daemon.

No production environment/configuration is written; no host executor is started.
Only the trusted GUID queue reaches the existing daemon via normal spool permits.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time
import urllib.request
import uuid

if not __debug__:
    raise SystemExit('Safety checks require Python without optimization (-O).')

ROOT = Path(__file__).resolve().parent.parent
TOKEN = uuid.uuid4().hex
HERE = ROOT / '.local/test-results' / ('tts-fresh-' + TOKEN)
FIXTURE = ROOT / 'tests/fresh-tts-queue.fixture.mjs'
PREFIX = 'gargantua-tts-' + TOKEN[:12]
DB, RUNNER, INIT = (PREFIX + '-' + suffix for suffix in ('db', 'runner', 'init'))
NETWORK = PREFIX + '-net'
LIBRARY = PREFIX + '-library'
DB_VOLUME = PREFIX + '-dbdata'
DOCKER_BINARY = shutil.which('docker')
if not DOCKER_BINARY:
    raise SystemExit('Docker must be available in PATH.')
DOCKER = Path(DOCKER_BINARY)
CONTEXT = 'desktop-linux'
IMAGE = None
PG_IMAGE = None
PRODUCTION = ['cotology-app-1','cotology-worker-1','cotology-db-1','cotology-parser-1','cotology-clamav-1']
LABELS = ['--label','org.gargantua.fixture=fresh-tts-isolated-v1','--label','org.gargantua.fixture-token='+TOKEN]
RUNTIME = ROOT / '.local/inference-runtime'
REPORTS = HERE / 'reports'
resources_created = {'containers':[], 'volumes':[], 'network':False}
samples=[]

def call(args, *, check=True, timeout=30):
    result=subprocess.run([str(DOCKER),'--context',CONTEXT,*map(str,args)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=timeout,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if check and result.returncode:
        raise RuntimeError('Docker operation '+str(args[:3])+' failed: '+result.stderr[-1800:])
    return result

def write(name, value):
    (HERE/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def before_state():
    state={}
    for name in PRODUCTION:
        row=json.loads(call(['inspect',name]).stdout)[0]
        assert row['State']['Running'], name+' must already be running'
        state[name]={'id':row['Id'],'image':row['Image'],'startedAt':row['State']['StartedAt'],'restartCount':row['RestartCount'],'environmentSha256':hashlib.sha256(json.dumps(row['Config']['Env'],sort_keys=True).encode()).hexdigest()}
    state['daemon']=json.loads((RUNTIME/'daemon.json').read_text(encoding='utf-8'))
    state['monitorPid']=(ROOT/'.local/runtime/monitor.pid').read_text().strip()
    state['resource']=json.loads((ROOT/'.local/runtime/resources.json').read_text(encoding='utf-8'))
    state['inferenceFilesSha256']={str(p.relative_to(ROOT)):digest(p) for p in [ROOT/'inference/executor.py',ROOT/'inference/container_worker.py',ROOT/'inference/protocol.py',ROOT/'inference/profiles.json',ROOT/'inference/profiles.lock.json']}
    return state

def sample():
    started=time.time()
    try:
        with urllib.request.urlopen('http://127.0.0.1:3080/api/health', timeout=4) as response:
            health=response.status==200 and json.load(response)=={'ok':True}
    except Exception as exc:
        health=False
    models=call(['ps','--filter','label=org.gargantua.inference=derived-v1','--format','{{.Names}}'],timeout=10).stdout.strip().splitlines()
    daemon=json.loads((RUNTIME/'daemon.json').read_text(encoding='utf-8'))
    budget=json.loads((ROOT/'.local/runtime/resources.json').read_text(encoding='utf-8'))
    row={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'health':health,'models':models,'daemon':daemon,'resource':budget,'seconds':time.time()-started}
    samples.append(row)
    assert health,'Production HTTP health failed during isolated fixture'
    assert len(models)<=1,'More than one model container observed'
    assert not any('-mt-' in name or '-health-' in name for name in models),'Unexpected GPU/translation model container'
    return row

def assert_budget():
    row=sample(); r=row['resource']; age=time.time()*1000-r['updatedAt']
    assert r['schemaVersion']==2 and r['metricsAvailable'] is True and r['dockerStorageKnown'] is True and r['allowHeavy'] is True and r['maxHeavyJobs']==1 and -5000<=age<=30000
    d=row['daemon'];assert d['state']=='idle' and d['cleanupVerified'] is True and -5000<=time.time()*1000-d['updatedAt']<=30000

def ownership(kind, name):
    allowed={'container':{INIT,DB,RUNNER},'network':{NETWORK},'volume':{LIBRARY,DB_VOLUME}}
    assert name in allowed.get(kind,set()) and name.startswith(PREFIX+'-'), 'Resource name is not owned by this run'
    row=json.loads(call([kind,'inspect',name]).stdout)[0]
    labels=(row.get('Config',{}).get('Labels') if kind=='container' else row.get('Labels')) or {}
    assert labels.get('org.gargantua.fixture-token')==TOKEN and labels.get('org.gargantua.fixture')=='fresh-tts-isolated-v1', 'Ownership mismatch for '+name
    return row

def cleanup():
    result=[]
    for name in reversed(resources_created['containers']):
        if call(['container','inspect',name],check=False).returncode:continue
        row=ownership('container',name)
        # Normal queue already retired all generated model calls. Stop/rm only
        # this isolated test runner or this isolated PostgreSQL, never daemon.
        if row['State']['Running']:
            call(['stop','--time','80',name],timeout=90)
        row=ownership('container',name);assert not row['State']['Running']
        call(['rm',name]);result.append({'container':name,'removed':True})
    if resources_created['network']:
        ownership('network',NETWORK);call(['network','rm',NETWORK]);result.append({'network':NETWORK,'removed':True})
    for name in resources_created['volumes']:
        ownership('volume',name);call(['volume','rm',name]);result.append({'volume':name,'removed':True})
    for name in ('database.env','runner.env'):
        p=HERE/name
        if p.exists():p.unlink()
    write('fixture-cleanup.json',result)
    return result

def preflight():
    global IMAGE, PG_IMAGE
    assert FIXTURE.is_file() and (ROOT/'ops/10-roles.sh').is_file()
    before=before_state()
    IMAGE,PG_IMAGE=before['cotology-app-1']['image'],before['cotology-db-1']['image']
    for image in [IMAGE,PG_IMAGE]:
        assert len(image)==71 and image.startswith('sha256:') and set(image[7:])<=set('0123456789abcdef')
        assert call(['image','inspect',image,'--format','{{.Id}}']).stdout.strip()==image
    assert json.loads(call(['network','inspect','cotology_data']).stdout)[0]['Internal'] is True
    selected=json.loads((ROOT/'inference/profiles.json').read_text(encoding='utf-8'))['profiles']['tts']
    assert selected['descriptor']['kind']=='tts' and selected['descriptor']['id']=='piper-denis-ru-v1'
    assert selected['descriptor']['recipe']['threads']==2
    for filename,expected in selected['descriptor']['implementation'].items():
        assert filename in {'protocol.py','container_worker.py','executor.py'}
        assert digest(ROOT/'inference'/filename)==expected,'TTS implementation differs from admitted profile'
    model_image=selected['descriptor']['runtimeImage']
    assert len(model_image)==71 and model_image.startswith('sha256:')
    assert call(['image','inspect',model_image,'--format','{{.Id}}']).stdout.strip()==model_image
    admitted=json.loads((ROOT/'inference/profiles.lock.json').read_text(encoding='utf-8'))['tts']
    model_root=(ROOT/admitted['modelRoot']).resolve(strict=True)
    assert model_root.is_relative_to((ROOT/'.local').resolve(strict=True)) and model_root.is_dir()
    assert_budget()
    return before

def main(run=False):
    before=preflight()
    if not run:
        # Default invocation is strictly inspect/read only: no fixture directory,
        # database, network, container, model process, permit or credential file.
        result={'status':'READY','mode':'READ_ONLY_PREFLIGHT','modelStarted':False,'productionChanged':False,'modelProfile':json.loads((ROOT/'inference/profiles.json').read_text(encoding='utf-8'))['profiles']['tts']['descriptor']['id'],'existingDaemonPid':before['daemon']['pid'],'appImageId':IMAGE,'postgresImageId':PG_IMAGE,'nextStep':'Explicit --run starts an isolated 3-chapter CPU-only queue fixture; models are never downloaded.'}
        print(json.dumps(result,ensure_ascii=False));return result
    assert HERE.name=='tts-fresh-'+TOKEN and HERE.resolve().parent==(ROOT/'.local/test-results').resolve()
    HERE.mkdir(parents=True,exist_ok=False)
    assert not (HERE/'report.json').exists(),'Do not overwrite a previous result'
    REPORTS.mkdir()
    write('host-before.json',before)
    admin,app=secrets.token_hex(32),secrets.token_hex(32)
    (HERE/'database.env').write_text('POSTGRES_DB=library\nPOSTGRES_USER=cotology_admin\nPOSTGRES_PASSWORD='+admin+'\nCOTOLOGY_ADMIN_PASSWORD='+admin+'\nCOTOLOGY_APP_PASSWORD='+app+'\n',encoding='utf-8')
    (HERE/'runner.env').write_text('DATABASE_URL=postgres://cotology_app:'+app+'@'+DB+':5432/library\nCLAM_HOST=clamav\nCLAM_PORT=3310\nGARGANTUA_FRESH_TTS_TOKEN='+TOKEN+'\n',encoding='utf-8')
    resources_created['network']=True;call(['network','create','--internal',*LABELS,NETWORK])
    for name in [LIBRARY,DB_VOLUME]:
        resources_created['volumes'].append(name);call(['volume','create',*LABELS,name])
    resources_created['containers'].append(INIT)
    call(['run','--pull=never','--name',INIT,*LABELS,'--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','FOWNER','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges','--memory','128m','--memory-swap','128m','--cpus','0.25','--pids-limit','32','--mount','type=volume,source='+LIBRARY+',target=/library','--entrypoint','sh',IMAGE,'-c','mkdir -p /library/books /library/derived && chown -R 1000:1000 /library && chmod 700 /library'])
    resources_created['containers'].append(DB)
    call(['run','--pull=never','--detach','--name',DB,*LABELS,'--network',NETWORK,'--memory','320m','--memory-swap','320m','--cpus','0.5','--pids-limit','128','--env-file',HERE/'database.env','--mount','type=volume,source='+DB_VOLUME+',target=/var/lib/postgresql/data','--mount','type=bind,source='+str(ROOT/'ops/10-roles.sh')+',target=/docker-entrypoint-initdb.d/10-roles.sh,readonly',PG_IMAGE])
    deadline=time.monotonic()+70
    while time.monotonic()<deadline:
        result=call(['exec',DB,'psql','-U','cotology_admin','-d','library','-Atc',"SELECT count(*) FROM pg_roles WHERE rolname='cotology_app'"],check=False,timeout=8)
        if result.returncode==0 and result.stdout.strip()=='1':break
        time.sleep(1)
    else:raise RuntimeError('Isolated DB readiness timeout')
    assert_budget()
    args=['create','--pull=never','--name',RUNNER,*LABELS,'--network',NETWORK,'--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','384m','--memory-swap','384m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m','--env-file',HERE/'runner.env']
    for kind,source,target,ro in [('volume',LIBRARY,'/library',False),('bind',ROOT/'.local/inference-spool','/inference-spool',False),('bind',RUNTIME,'/inference-runtime',True),('bind',ROOT/'.local/runtime','/resources',True),('bind',REPORTS,'/fixture-report',False),('bind',FIXTURE,'/app/tests/fresh-tts-isolated.mjs',True)]:
        args+=['--mount','type='+kind+',source='+str(source)+',target='+target+(',readonly' if ro else '')]
    args+=['--entrypoint','node',IMAGE,'tests/fresh-tts-isolated.mjs']
    resources_created['containers'].append(RUNNER);call(args)
    call(['network','connect','cotology_data',RUNNER])
    inspected=ownership('container',RUNNER)
    assert set(inspected['NetworkSettings']['Networks'])=={NETWORK,'cotology_data'}
    assert not inspected['HostConfig']['PortBindings']
    # Only this trusted GUID runner sees the shared spool. No production library,
    # DB volume, Docker socket, host user directory, model directory or GPU mount.
    assert all(m['Destination'] in ['/library','/inference-spool','/inference-runtime','/resources','/fixture-report','/app/tests/fresh-tts-isolated.mjs'] for m in inspected['Mounts'])
    assert not inspected['HostConfig'].get('DeviceRequests')
    write('topology.json',{'token':TOKEN,'appImage':IMAGE,'postgresImage':PG_IMAGE,'network':NETWORK,'library':LIBRARY,'database':DB,'runner':RUNNER,'runnerMemoryBytes':inspected['HostConfig']['Memory'],'runnerNanoCpus':inspected['HostConfig']['NanoCpus'],'productionLibraryMounted':False,'productionDatabaseUsed':False,'sharedSpool':str(ROOT/'.local/inference-spool'),'newHostExecutor':False,'mountDestinations':[{'destination':m['Destination'],'readOnly':not m['RW']} for m in inspected['Mounts']]})
    call(['start',RUNNER])
    deadline=time.monotonic()+390
    while time.monotonic()<deadline:
        state=json.loads(call(['inspect',RUNNER,'--format','{{json .State}}']).stdout)
        sample()
        if not state['Running']:
            (HERE/'runner.log').write_text(call(['logs',RUNNER],check=False).stdout,encoding='utf-8')
            stderr=call(['logs',RUNNER],check=False).stderr
            (HERE/'runner.stderr.log').write_text(stderr,encoding='utf-8')
            assert state['ExitCode']==0,'Runner failed: '+stderr[-1800:]
            break
        time.sleep(2)
    else:raise RuntimeError('Runner outer deadline exceeded')
    report=json.loads((REPORTS/'model-queue-report.json').read_text(encoding='utf-8'));assert report['status']=='PASS'
    # Save an inert compact DB proof before its disposable volume is removed.
    dbproof=call(['exec',DB,'psql','-U','cotology_app','-d','library','-Atc',"SELECT json_build_object('books',(SELECT count(*) FROM books),'jobs',(SELECT json_agg(json_build_object('id',id,'kind',kind,'status',status,'completed',completed_segments,'total',total_segments)) FROM derived_jobs),'requests',(SELECT count(*) FROM derived_requests),'checkpoints',(SELECT count(*) FROM derived_checkpoints),'schema',(SELECT max(version) FROM schema_migrations));"]).stdout
    (HERE/'database-proof.json').write_text(dbproof,encoding='utf-8')
    after=before_state();write('host-after.json',after)
    for name in PRODUCTION:assert before[name]==after[name],name+' identity/start/environment changed unexpectedly'
    assert before['daemon']['pid']==after['daemon']['pid']
    assert before['monitorPid']==after['monitorPid']
    assert before['inferenceFilesSha256']==after['inferenceFilesSha256']
    assert after['daemon']['state']=='idle' and after['daemon']['cleanupVerified'] is True
    sample();assert not samples[-1]['models']
    write('host-samples.json',samples)
    cleanup_result=cleanup()
    summary={'schemaVersion':1,'status':'PASS','completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'token':TOKEN,'realFreshModel':True,'realClamAV':True,'productionDaemonPidUnchanged':after['daemon']['pid'],'productionMonitorPidUnchanged':after['monitorPid'],'productionServicesIdentityAndStartUnchanged':True,'productionEnvironmentUnchanged':True,'inferenceImplementationAndProfileFilesUnchanged':True,'productionHttpSamples':len(samples),'productionHttpSamplesAllHealthy':all(s['health'] for s in samples),'maxModelContainersObserved':max(len(s['models']) for s in samples),'gpuModelContainersObserved':False,'allThreeChaptersFullySynthesized':True,'originalPreservedSeparately':True,'durationsSeconds':[s['pcm']['durationSeconds'] for s in report['segments']],'samplePath':str(REPORTS/'audio-three-chapters.wav'),'sampleSha256':digest(REPORTS/'audio-three-chapters.wav'),'samplePcm':report['sample']['pcm'],'auditoryReview':'NOT_LISTENED','weightsAntivirus':'NOT_FULLY_SCANNED','sourceProof':str(REPORTS/'original-book.json'),'queueProof':str(REPORTS/'model-queue-report.json'),'sourceRunnerSha256':digest(FIXTURE),'sourceHarnessSha256':digest(__file__),'sourceWrapperSha256':digest(ROOT/'scripts/test-fresh-tts-queue.ps1'),'ownedFixtureResourcesRemoved':cleanup_result}
    write('report.json',summary)
    print(json.dumps(summary,ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',action='store_true',help='Explicitly synthesize 3 short original Russian chapters through the existing executor. Default is read-only preflight.')
    parser.add_argument('--docker',type=Path,default=DOCKER)
    parser.add_argument('--context',default=CONTEXT)
    args=parser.parse_args();DOCKER=args.docker;CONTEXT=args.context
    try:
        main(run=args.run)
    except Exception as exc:
        if HERE.is_dir():
            write('host-samples.json',samples)
            if RUNNER in resources_created['containers']:
                result=call(['logs',RUNNER],check=False)
                (HERE/'runner.log').write_text(result.stdout,encoding='utf-8');(HERE/'runner.stderr.log').write_text(result.stderr,encoding='utf-8')
            write('host-failure.json',{'status':'FAIL','type':type(exc).__name__,'error':str(exc)})
            # Do not stop the daemon: SIGTERM only to the trusted isolated runner
            # revokes its own permit and the unchanged daemon cleans up its model.
            cleanup()
        raise
