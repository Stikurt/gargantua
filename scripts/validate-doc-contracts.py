import copy,hashlib,io,json,pathlib,re,sys,wave
root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'.local/docs-validation'))
from openapi_spec_validator import validate_spec
from jsonschema import Draft202012Validator,FormatChecker,ValidationError
doc=root/'docs/gargantua'
spec=json.loads((doc/'api.openapi.json').read_text(encoding='utf-8'));validate_spec(spec)
theme=json.loads((doc/'brand/theme.schema.json').read_text(encoding='utf-8'));Draft202012Validator.check_schema(theme);validator=Draft202012Validator(theme)
good={'schemaVersion':1,'id':'gargantua-red-night','name':'Красная орбита','base':'dark','tokens':{'accent':'#CC2438','background':'#08080A','text':'#E9E9ED','fontScale':1.0,'radius':12},'reader':{'fontFamily':'serif','fontSize':21,'lineHeight':1.8,'maxWidth':760}}
validator.validate(good)
for bad in [{**good,'script':'alert(1)'},{**good,'tokens':{'accent':'url(https://invalid.example)'}},{**good,'reader':{'fontFamily':'remote-font','fontSize':10000}},{**good,'schemaVersion':999}]:assert list(validator.iter_errors(bad)),'Unsafe theme accepted'

# These checks exercise a documentation fixture, not the production importer or publisher.
def schema_validate(name,value):
 Draft202012Validator({'$ref':'#/components/schemas/'+name,'components':spec['components']},format_checker=FormatChecker()).validate(value)

def package_path(value):
 if not value or '\\' in value or ':' in value or value.startswith('/') or any(part in ('','.','..') for part in value.split('/')):
  raise ValueError('Unsafe or non-normalized package path')
 return value

def validate_example(manifest,files,locator):
 schema_validate('Publication',manifest);schema_validate('Locator',locator)
 paths=set();chapters={};chapter_ids=set()
 for resource in [*manifest['readingOrder'],*manifest['resources']]:
  path=package_path(resource['path'])
  if path in paths:raise ValueError('Duplicate resource path')
  paths.add(path)
  if path not in files:raise ValueError('Missing resource')
  data=files[path]
  if len(data)!=resource['bytes'] or hashlib.sha256(data).hexdigest()!=resource['sha256']:raise ValueError('Resource size/hash mismatch')
  if 'chapterId' in resource:
   if resource['chapterId'] in chapter_ids:raise ValueError('Duplicate chapter ID')
   chapter_ids.add(resource['chapterId'])
   if resource['mediaType']!='application/json':raise ValueError('Chapter media type mismatch')
   chapter=json.loads(data);schema_validate('Chapter',chapter)
   if chapter['id']!=resource['chapterId']:raise ValueError('Chapter ID mismatch')
   block_ids=[block['id'] for block in chapter['blocks']]
   if len(block_ids)!=len(set(block_ids)):raise ValueError('Duplicate block ID')
   chapters[chapter['id']]=chapter
 if paths!=set(files):raise ValueError('Unlisted resource')
 if locator['publicationId']!=manifest['id'] or locator['publicationRevision']!=manifest['revision']:raise ValueError('Locator targets another publication/revision')
 chapter=chapters.get(locator['chapterId'])
 if chapter is None:raise ValueError('Locator chapter missing')
 blocks={block['id']:block for block in chapter['blocks']}
 if 'blockId' in locator:
  block=blocks.get(locator['blockId'])
  if block is None:raise ValueError('Locator block missing')
  text=block.get('text','');offset=locator.get('offset',0)
  if offset>len(text):raise ValueError('Locator offset out of bounds')
  if 'quote' in locator and not text[offset:].startswith(locator['quote']['exact']):raise ValueError('Locator quote mismatch')

fixture=doc/'examples/publication-v2'
manifest=json.loads((fixture/'manifest.json').read_text(encoding='utf-8'))
locator=json.loads((doc/'examples/locator-v2.json').read_text(encoding='utf-8'))
files={p.relative_to(fixture).as_posix():p.read_bytes() for p in fixture.rglob('*') if p.is_file() and p.name!='manifest.json'}
assert not any(p.is_symlink() for p in fixture.rglob('*')),'Fixture contains a symlink'
validate_example(manifest,files,locator)
example_block=re.search(r'## 2\. Манифест публикации.*?```json\s*(.*?)```',(doc/'CONTRACTS.md').read_text(encoding='utf-8'),re.S)
assert example_block and json.loads(example_block[1])==manifest,'Contract example differs from its validated fixture'

invalid=[]
def add_invalid(name,change):
 sample=(copy.deepcopy(manifest),dict(files),copy.deepcopy(locator));change(*sample);invalid.append((name,sample))
add_invalid('legacy-publication-id',lambda m,f,l:m.update(publicationId=m.pop('id')))
add_invalid('client-security-verdict',lambda m,f,l:m.update(security={'state':'passed'}))
add_invalid('missing-title',lambda m,f,l:m.pop('title'))
add_invalid('missing-chapter-id',lambda m,f,l:m['readingOrder'][0].pop('chapterId'))
add_invalid('hash-mismatch',lambda m,f,l:m['readingOrder'][0].update(sha256='0'*64))
add_invalid('size-mismatch',lambda m,f,l:m['readingOrder'][0].update(bytes=1))
add_invalid('remote-url',lambda m,f,l:m['readingOrder'][0].update(path='https://invalid.example/chapter.json'))
add_invalid('path-traversal',lambda m,f,l:m['readingOrder'][0].update(path='../chapter.json'))
add_invalid('duplicate-path',lambda m,f,l:m['resources'].append({k:v for k,v in m['readingOrder'][0].items() if k!='chapterId'}))
add_invalid('chapter-id-mismatch',lambda m,f,l:m['readingOrder'][0].update(chapterId='other'))
add_invalid('chapter-media-type',lambda m,f,l:m['readingOrder'][0].update(mediaType='text/html'))
add_invalid('publication-mismatch',lambda m,f,l:l.update(publicationId='ee5e12ce-9e4a-4c84-bd04-b4bd407aa6ba'))
add_invalid('revision-mismatch',lambda m,f,l:l.update(publicationRevision=2))
add_invalid('missing-block',lambda m,f,l:l.update(blockId='unknown'))
add_invalid('quote-mismatch',lambda m,f,l:l.update(quote={'exact':'unrelated'}))
add_invalid('offset-out-of-bounds',lambda m,f,l:l.update(offset=10000))
for name,sample in invalid:
 try:validate_example(*sample)
 except (ValidationError,ValueError):continue
 raise AssertionError('Invalid documentation fixture accepted: '+name)

def canonical_digest(value):
 return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()

def normalized_outputs(request):
 schema_validate('SearchRequest',request)
 # Explicit documentation of target server normalization; Schema defaults alone do not apply it.
 return request.get('outputs',['book','audio'])

def validate_audio_contract(fixture,narration_manifest,audio_files):
 for name,key in [('SearchRequest','request'),('Plan','plan'),('Narration','narration'),('NarrationRevision','revision'),('Bundle','bundle'),('TtsRequest','ttsRequest'),('SessionContext','sessionContext')]:
  schema_validate(name,fixture[key])
 schema_validate('NarrationManifest',narration_manifest)
 source={'publicationId':manifest['id'],'publicationRevision':manifest['revision'],'manifestSha256':hashlib.sha256((doc/'examples/publication-v2/manifest.json').read_bytes()).hexdigest()}
 bundle,narration,nrevision,tts=fixture['bundle'],fixture['narration'],fixture['revision'],fixture['ttsRequest']
 if set(bundle['requiredOutputs'])!=set(normalized_outputs(fixture['request'])):raise ValueError('REQUIREMENTS_OUTPUT_MISMATCH')
 plan=fixture['plan']
 if plan['requestId']!=bundle['requestId'] or plan['requirementsRevision']!=bundle['requirementsRevision'] or set(plan['outputs'])!=set(bundle['requiredOutputs']):raise ValueError('PLAN_BUNDLE_REQUIREMENTS_MISMATCH')
 if bundle['targetLanguage']!=manifest['language'] or narration['language']!=manifest['language']:raise ValueError('TARGET_LANGUAGE_MISMATCH')
 if narration['expressionId']!=manifest['expressionId']:raise ValueError('EXPRESSION_MISMATCH')
 if any(item['sourceText']!=source for item in [nrevision,narration_manifest,tts]):raise ValueError('NARRATION_TEXT_REVISION_MISMATCH')
 if narration['id']!=nrevision['narrationId'] or nrevision['narrationId']!=narration_manifest['narrationId'] or nrevision['revision']!=narration_manifest['revision']:raise ValueError('NARRATION_REVISION_MISMATCH')
 recipe=nrevision['recipe']
 if recipe!=narration_manifest['recipe'] or recipe!=tts['recipe'] or recipe['language']!=manifest['language']:raise ValueError('VOICE_RECIPE_MISMATCH')
 if nrevision['segmentCount']!=len(narration_manifest['segments']):raise ValueError('SEGMENT_COUNT_MISMATCH')
 required_paths=set();segment_ids=set()
 def resource_bytes(resource):
  path=package_path(resource['path']);required_paths.add(path)
  if path not in audio_files:raise ValueError('AUDIO_RESOURCE_MISSING')
  data=audio_files[path]
  if len(data)!=resource['bytes'] or hashlib.sha256(data).hexdigest()!=resource['sha256']:raise ValueError('AUDIO_RESOURCE_HASH_MISMATCH')
  return data
 if 'manifest' not in nrevision:raise ValueError('AUDIO_MANIFEST_MISSING')
 if nrevision['manifest']['mediaType']!='application/json':raise ValueError('AUDIO_MANIFEST_MEDIA_TYPE')
 if json.loads(resource_bytes(nrevision['manifest']))!=narration_manifest:raise ValueError('AUDIO_MANIFEST_CONTENT_MISMATCH')
 total=0
 for segment in narration_manifest['segments']:
  identity=(segment['id'],segment['revision'])
  if identity in segment_ids:raise ValueError('DUPLICATE_AUDIO_SEGMENT')
  segment_ids.add(identity)
  if segment['sourceText']!=source:raise ValueError('SEGMENT_TEXT_REVISION_MISMATCH')
  if segment['recipeSha256']!=canonical_digest(recipe):raise ValueError('SEGMENT_RECIPE_MISMATCH')
  validate_example(manifest,files,segment['locator'])
  data=resource_bytes(segment['resource'])
  if segment['resource']['mediaType']!='audio/wav':raise ValueError('FIXTURE_EXPECTS_WAV_ONLY')
  with wave.open(io.BytesIO(data),'rb') as sample:
   duration=sample.getnframes()*1000//sample.getframerate()
   if duration!=segment['durationMs']:raise ValueError('AUDIO_DURATION_MISMATCH')
  total+=segment['durationMs']
 if total!=narration_manifest['totalDurationMs']:raise ValueError('TOTAL_AUDIO_DURATION_MISMATCH')
 if required_paths!=set(audio_files):raise ValueError('UNLISTED_AUDIO_RESOURCE')
 expected_book={'kind':'publication','id':manifest['id'],'revision':manifest['revision'],'manifestSha256':source['manifestSha256']}
 if bundle['book'].get('result')!=expected_book:raise ValueError('BUNDLE_BOOK_REVISION_MISMATCH')
 if bundle['translation']['state']=='ready' and bundle['translation'].get('result')!=expected_book:raise ValueError('TRANSLATION_RESULT_MISMATCH')
 if 'audio' in bundle['requiredOutputs'] and bundle['audio']['state']=='not-required':raise ValueError('REQUIRED_AUDIO_CANNOT_BE_DISABLED')
 if 'result' in bundle['audio']:
  expected_audio={'kind':'narration','id':nrevision['narrationId'],'revision':nrevision['revision'],'manifestSha256':nrevision['manifest']['sha256']}
  if bundle['audio']['result']!=expected_audio:raise ValueError('BUNDLE_AUDIO_REVISION_MISMATCH')
 if nrevision['state']=='ready' or bundle['audio']['state']=='ready':
  if any(segment['contentKind']=='synthetic-sample' for segment in narration_manifest['segments']):raise ValueError('SYNTHETIC_SAMPLE_IS_NOT_ACCEPTED_TTS')
  if nrevision['state']!='ready' or not nrevision['complete'] or nrevision['quality']!='accepted':raise ValueError('AUDIO_NOT_ACCEPTED_COMPLETE')
 if bundle['delivery']['state']=='ready':
  report=bundle['delivery']['deliveryReport']
  if report['textLocalState']!='committed' or ('audio' in bundle['requiredOutputs'] and report['audioLocalState']!='committed'):raise ValueError('DELIVERY_REQUIRES_CLIENT_COMMIT')

audio_dir=doc/'examples/audio-contract-v1'
audio_fixture=json.loads((audio_dir/'fixture.json').read_text(encoding='utf-8'))
narration_manifest=json.loads((audio_dir/'narration-manifest.json').read_text(encoding='utf-8'))
audio_files={p.relative_to(audio_dir).as_posix():p.read_bytes() for p in audio_dir.rglob('*') if p.is_file() and p.name!='fixture.json'}
assert not any(p.is_symlink() for p in audio_dir.rglob('*')),'Audio fixture contains a symlink'
assert audio_fixture['fixtureOnly'] and audio_fixture['revision']['quality']=='not-evaluated' and not audio_fixture['revision']['complete']
with wave.open(io.BytesIO(audio_files['audio/sample.wav']),'rb') as sample:
 assert sample.getnframes()==800 and sample.getframerate()==8000 and sample.getnchannels()==1 and sample.getsampwidth()==2
 assert set(sample.readframes(800))=={0},'The fixture must remain synthetic silence, not purported TTS'
validate_audio_contract(audio_fixture,narration_manifest,audio_files)
assert normalized_outputs(audio_fixture['request'])==['book','audio']
same_outputs=copy.deepcopy(audio_fixture)
same_outputs['request']['outputs']=['audio','book']
validate_audio_contract(same_outputs,narration_manifest,audio_files)
text_only=copy.deepcopy(audio_fixture)
text_only['request']['outputs']=['book'];text_only['bundle']['requiredOutputs']=['book'];text_only['bundle']['state']='server-ready';text_only['bundle']['audio']={'state':'not-required','reasonCode':'EXPLICIT_TEXT_ONLY'}
text_only['plan']['outputs']=['book']
validate_audio_contract(text_only,narration_manifest,audio_files)
assert text_only['bundle']['delivery']['state']=='waiting','Server-ready is not a local commit'
waiting_revision=copy.deepcopy(audio_fixture['revision'])
waiting_revision.update(state='waiting',segmentCount=0);waiting_revision.pop('manifest')
schema_validate('NarrationRevision',waiting_revision)
waiting_bundle=copy.deepcopy(audio_fixture['bundle'])
waiting_bundle['audio']={'state':'waiting','reasonCode':'PROVIDER_MISSING'}
schema_validate('Bundle',waiting_bundle)
assert waiting_bundle['state']=='partial'

audio_invalid=[]
def add_audio_invalid(name,change,expected_code=None):
 sample=(copy.deepcopy(audio_fixture),copy.deepcopy(narration_manifest),dict(audio_files));change(*sample);audio_invalid.append((name,sample,expected_code))
add_audio_invalid('audio-only-output',lambda f,m,b:f['request'].update(outputs=['audio']))
add_audio_invalid('empty-output-selection',lambda f,m,b:f['request'].update(outputs=[]))
add_audio_invalid('duplicate-output-selection',lambda f,m,b:f['request'].update(outputs=['book','book']))
add_audio_invalid('bundle-output-mismatch',lambda f,m,b:f['bundle'].update(requiredOutputs=['book']),'REQUIREMENTS_OUTPUT_MISMATCH')
add_audio_invalid('plan-bundle-revision-mismatch',lambda f,m,b:f['plan'].update(requirementsRevision=2),'PLAN_BUNDLE_REQUIREMENTS_MISMATCH')
add_audio_invalid('narration-wrong-text-revision',lambda f,m,b:m['sourceText'].update(publicationRevision=2),'NARRATION_TEXT_REVISION_MISMATCH')
add_audio_invalid('tts-request-wrong-text-hash',lambda f,m,b:f['ttsRequest']['sourceText'].update(manifestSha256='0'*64),'NARRATION_TEXT_REVISION_MISMATCH')
add_audio_invalid('tts-work-id-is-insufficient',lambda f,m,b:f['ttsRequest'].update(workId=manifest['workId']))
add_audio_invalid('voice-config-mismatch',lambda f,m,b:f['ttsRequest']['recipe'].update(configSha256='0'*64),'VOICE_RECIPE_MISMATCH')
add_audio_invalid('audio-ready-without-manifest',lambda f,m,b:(f['revision'].update(state='ready',complete=True,quality='accepted'),f['revision'].pop('manifest')))
add_audio_invalid('required-bundle-missing-audio',lambda f,m,b:f['bundle'].update(state='server-ready'))
add_audio_invalid('required-audio-disabled',lambda f,m,b:f['bundle'].update(audio={'state':'not-required'}),'REQUIRED_AUDIO_CANNOT_BE_DISABLED')
add_audio_invalid('waiting-stage-without-reason',lambda f,m,b:f['bundle']['delivery'].pop('reasonCode'))
add_audio_invalid('sample-mislabelled-as-ready',lambda f,m,b:(f['revision'].update(state='ready',complete=True,quality='accepted'),f['bundle']['audio'].update(state='ready')),'SYNTHETIC_SAMPLE_IS_NOT_ACCEPTED_TTS')
add_audio_invalid('segment-count-mismatch',lambda f,m,b:f['revision'].update(segmentCount=2),'SEGMENT_COUNT_MISMATCH')
add_audio_invalid('corrupt-audio-bytes',lambda f,m,b:b.update({'audio/sample.wav':b['audio/sample.wav']+b'changed'}),'AUDIO_RESOURCE_HASH_MISMATCH')
add_audio_invalid('session-without-csrf',lambda f,m,b:f['sessionContext'].pop('csrfToken'))
add_audio_invalid('session-without-expiry',lambda f,m,b:f['sessionContext'].pop('expiresAt'))
def device_without_commit(f,m,b):
 f['request']['outputs']=['book'];f['bundle']=copy.deepcopy(text_only['bundle']);f['bundle']['state']='device-ready'
 f['plan']['outputs']=['book']
add_audio_invalid('device-ready-without-client-commit',device_without_commit)
rejection_mechanisms={}
for name,sample,expected_code in audio_invalid:
 try:validate_audio_contract(*sample)
 except ValidationError as error:
  assert expected_code is None,'Expected relational rejection, got Schema error: '+name
  rejection_mechanisms[name]='JSON_SCHEMA_'+error.validator
  continue
 except ValueError as error:
  if expected_code is not None:assert str(error)==expected_code,(name,str(error),expected_code)
  rejection_mechanisms[name]=str(error)
  continue
 raise AssertionError('Invalid audio/bundle/session documentation fixture accepted: '+name)

immutable_routes=['/publications/{id}','/publications/{id}/chapters/{chapterId}','/narrations/{id}','/audio-segments/{id}','/artifacts/{id}','/artifacts/{id}/package']
for path in immutable_routes:
 assert any(p['name']=='revision' and p['in']=='query' and p.get('required') for p in spec['paths'][path]['get']['parameters']),path+' misses exact revision'
for path,method in [('/session','post'),('/me','get')]:
 assert spec['paths'][path][method]['responses']['200']['content']['application/json']['schema']['$ref'].endswith('/SessionContext')
assert 'Set-Cookie' in spec['paths']['/session']['post']['responses']['200']['headers']
assert spec['components']['securitySchemes']['serverSession']['name']=='gargantua_session'
assert {'requestId','requirementsRevision','outputs'}<=set(spec['components']['schemas']['Plan']['required'])
assert all(op.get('x-design-status')=='NOT_IMPLEMENTED' for methods in spec['paths'].values() for op in methods.values())

report={'ok':True,'scope':'DOCUMENTATION_ONLY: OpenAPI/JSON Schema, linked fixture bytes/relations and design invariants. Not server/auth/AV/sandbox/inference/audio-quality/APK/EXE tests. Synthetic WAV is 100ms silence, NOT accepted narration.','openApi':'valid','themeSchema':'valid','validThemeAccepted':True,'invalidThemeSamplesRejected':4,'publicationFixture':'valid','publicationExampleMatchesFixture':True,'resourceHashesAndLocators':'valid','invalidPublicationSamplesRejected':len(invalid),'rejectedPublicationCases':[name for name,_ in invalid],'audioFixture':'100ms synthetic silence; no TTS run; quality not-evaluated','defaultOutputs':['book','audio'],'positiveBundleCases':['linked fixture: required audio remains partial for synthetic sample','linked fixture: explicit text-only can be server-ready while delivery waits','schema only: missing provider allows a waiting revision without manifest, never audio ready'],'invalidAudioBundleSessionSamplesRejected':len(audio_invalid),'rejectedAudioBundleSessionCases':[name for name,_,_ in audio_invalid],'audioBundleRejectionMechanisms':rejection_mechanisms,'immutableRevisionSelectorsChecked':len(immutable_routes),'sessionContextFlow':'schema/header consistency only, not executed authentication','allOperationsDesignStatus':'NOT_IMPLEMENTED'}
(doc/'CONTRACT_VALIDATION.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False))
