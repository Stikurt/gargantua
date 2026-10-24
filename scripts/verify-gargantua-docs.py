"""Verify the integrity of documentation exports, not the implementation of reader features."""
import collections,csv,gzip,hashlib,json,pathlib,re,urllib.parse,zipfile,datetime
ROOT=pathlib.Path(__file__).resolve().parents[1];D=ROOT/'docs/gargantua';results=[]
def check(name,condition):
 results.append({'check':name,'ok':bool(condition)})
 if not condition:raise AssertionError(name)
registry=json.loads((D/'research/registry.json').read_text(encoding='utf-8'))
check('At least 200 distinct project repositories',len(registry)>=200 and len({p['repository'].lower() for p in registry})==len(registry))
check('Each project has a retrieved README and issue body',all(p['readme']['status']==200 and p['feedback_source']['status']==200 and p['feedback_body_characters']>0 for p in registry))
check('README aliases with identical bytes not counted twice',len({p['readme']['sha256'] for p in registry})==len(registry))
check('Each project has strengths, limits and traceable feedback',all(p['advantage_analysis'] and p['limitation_analysis'] and p['feedback_url'] and p['readme']['url'] for p in registry))
platforms=json.loads((D/'research/websites-evidence.json').read_text(encoding='utf-8'))
check('40 platform entries with explicit retrieval outcomes',len(platforms)==40 and all('status' in x['retrieval'] for x in platforms))
stories=list(csv.DictReader((D/'SCENARIOS.tsv').open(encoding='utf-8'),delimiter='\t'))
check('200 authored stories with solutions and acceptance',len(stories)==200 and all(x['situation'] and x['solution'] and x['acceptance'] for x in stories))
manifest=json.loads((D/'scenarios/manifest.json').read_text(encoding='utf-8'));ids=set();triples=set();counter=collections.Counter()
with zipfile.ZipFile(D/'scenarios/gargantua-32000-scenarios.zip') as archive:
 check('ZIP entry hashes/CRC intact',archive.testzip() is None)
 for stage in manifest['stages']:
  compressed=(D/'scenarios'/stage['jsonlFile']).read_bytes();raw=gzip.decompress(compressed)
  check(stage['id']+' compressed and uncompressed hashes match',hashlib.sha256(compressed).hexdigest()==stage['compressedSha256'] and hashlib.sha256(raw).hexdigest()==stage['jsonlUncompressedSha256'])
  check(stage['id']+' ZIP and gzip contain identical JSONL',archive.read(stage['id']+'.jsonl')==raw)
  cases=[json.loads(line) for line in raw.decode('utf-8').splitlines()]
  check(stage['id']+' contains 2000 full NOT_EXECUTED cases',len(cases)==2000 and all(c['executionStatus']=='NOT_EXECUTED' and len(c['steps'])==4 and len(c['expected'])==3 for c in cases))
  for c in cases:
   check_id=c['id'];assert check_id not in ids;ids.add(check_id);triples.add((c['stage'],c['operationId'],c['fixtureId'],c['conditionId']));counter[c['stage']]+=1
check('32000 unique IDs and parameter tuples',len(ids)==len(triples)==32000 and len(counter)==16 and set(counter.values())=={2000})
broken=[]
for file in D.rglob('*.md'):
 for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)',file.read_text(encoding='utf-8')):
  if re.match(r'^[a-z]+:',target,re.I) or target.startswith('#'):continue
  path=urllib.parse.unquote(target.split('#')[0])
  if not (file.parent/path).exists():broken.append((str(file.relative_to(D)),target))
check('All relative Markdown file links resolve',not broken)
api=json.loads((D/'api.openapi.json').read_text(encoding='utf-8'));all_operation_ids=[]
def resolve_refs(value):
 if isinstance(value,dict):
  if '$ref' in value:
   pointer=value['$ref'];assert pointer.startswith('#/');current=api
   for token in pointer[2:].split('/'):current=current[token.replace('~1','/').replace('~0','~')]
  for item in value.values():resolve_refs(item)
 elif isinstance(value,list):
  for item in value:resolve_refs(item)
resolve_refs(api)
for path,item in api['paths'].items():
 for method,op in item.items():
  all_operation_ids.append(op['operationId']);params={p['name'] for p in op.get('parameters',[]) if p['in']=='path'};assert params==set(re.findall(r'{([^}]+)}',path))
check('OpenAPI references, parameters and operation IDs are coherent',len(all_operation_ids)==len(set(all_operation_ids)) and api['openapi']=='3.1.0')
html=(D/'index.html').read_text(encoding='utf-8')
check('Viewer has no remote runtime dependencies',not re.search(r'<(?:script|link)[^>]+(?:src|href)=["\']https?://',html))
check('Viewer states design/test status explicitly','NOT_EXECUTED' in html and '32 000' in html and '222' in html)
roadmap=(D/'IMPLEMENTATION_ROADMAP.md').read_text(encoding='utf-8')
stage_order=['S0.','S1.','S2.','S3.','S4.','S5.','S6.','G-S.','C1.','C2.','E.']
positions=[roadmap.find('| '+stage) for stage in stage_order]
check('Server-first delivery gates precede Windows and Android client delivery',all(p>=0 for p in positions) and positions==sorted(positions))
check('Roadmap preserves comfort and autonomous reading acceptance','## 8. Удобство читалки' in roadmap and 'без обязательного логина' in roadmap and 'после полного перезапуска' in roadmap)
check('Viewer includes updated server roadmap and source review','id="roadmap"' in html and 'id="review"' in html and 'S0. Сохранность' in html)
required_sections=['reassessment','request-audio','ux-review','walkthrough','backend-review','automation-review','simulations']
check('Viewer includes all focused reassessment reports',all('id="'+section+'"' in html for section in required_sections))
check('Viewer includes the C2 Windows unified search and previous client release','id="windows-c2"' in html and 'id="windows-c1"' in html and 'C2 Windows: единый поиск книг и аудио' in html)
c2=(D/'C2_WINDOWS_SEARCH.md').read_text(encoding='utf-8')
check('C2 documentation separates the current 100-file release from historical 108 assertions and voice-quality acceptance','Историческая приёмка 0.4.1' in c2 and '108' in c2 and '0 запросов текста глав' in c2 and 'голоса и перевода этим не принято' in c2 and '100 файлов' in c2 and '78 пользовательских файлов' in c2)
check('Viewer exposes the installed C3 evidence and explicitly planned book-card redesign','id="windows-c3"' in html and 'id="book-card"' in html and 'Это план следующей переработки интерфейса' in html)
sim=json.loads((D/'research/simulation-results.json').read_text(encoding='utf-8'))
seeds=sim['seedRange'][1]-sim['seedRange'][0]+1;faults=sim['faultTypes'];combinations=1+faults+faults*(faults-1)//2
check('Finite-model counts match seeds and zero/single/pair combinations',sim['scope']=='EXECUTED_FINITE_PROTOCOL_MODEL_ONLY_NOT_PRODUCTION_SERVER_TESTS' and sim['faultCombinationsPerSeed']==combinations and sim['traces']==seeds*combinations==sum(sim['traceCountsByFaultCount'].values()))
check('Mutation sensitivity includes the expected invariant and a counterexample',sim['mutantsInjected']==sim['mutantsDetected']==len(sim['mutations']) and all(m['detected'] and m['invariant']==m['expectedInvariant'] and m['counterexamplePrefix'] for m in sim['mutations']))
check('Model retains limits and does not mark the old product scenarios executed','remain NOT_EXECUTED' in sim['productionScenarioCatalogStatus'] and bool(sim['limitations']) and sim['counterexamplesArePrefixesNotProvenMinimal'])
storage=json.loads((D/'research/storage-durability-results.json').read_text(encoding='utf-8'))
check('Process probe has successful observations and actual abrupt child exits',storage['scope']=='NOT_PRODUCTION_POSTGRES_OR_CLIENT' and storage['passed'] and storage['counts']['cases']==len(storage['cases']) and storage['counts']['asserted_observations']==sum(len(c['asserted_observations']) for c in storage['cases']) and storage['counts']['abrupt_child_terminations']==len(storage['abrupt_child_returncodes']) and all(code!=0 for code in storage['abrupt_child_returncodes']) and bool(storage['limitations']))
ux=json.loads((D/'research/reassessment-ux.json').read_text(encoding='utf-8'))
source_ids={s['id'] for s in ux['sources']}
check('Focused UX retains source and product identities plus unexecuted acceptance',len(ux['products'])>=16 and len(source_ids)==len(ux['sources']) and len({p['id'] for p in ux['products']})==len(ux['products']) and len(ux['mechanics'])>=20 and all(c['status']=='NOT_EXECUTED' for c in ux['acceptance']) and not ux['handsOn'])
automation=json.loads((D/'research/reassessment-automation.json').read_text(encoding='utf-8'))
check('Automation research records uninstalled models and future quality pilot',len(automation['components'])>=17 and len(automation['reviews'])>=10 and automation['pilotStatus']=='NOT_EXECUTED' and not automation['modelsInstalled'])
samples=[json.loads((D/'examples/catalogs/reports'/sample/'catalog.json').read_text(encoding='utf-8')) for sample in ['warriors-first-arc','clarke-candidates','clarke-selected']]
check('Published discovery samples remain metadata-only',all(sample['metadataOnly'] and sample['provider']=='Open Library' for sample in samples))
check('Audio is a core S5 deliverable and missing provider is not full success','| S5. Переводчик и аудиоверсия' in roadmap and 'при требовании book+audio общая приёмка и запрос остаются незавершёнными' in roadmap and 'tts.request' in roadmap)
check('Brand SVG has no script or external image',not re.search(r'<script|https?://(?!www.w3.org)',(D/'brand/gargantua-icon.svg').read_text(encoding='utf-8')))
evidence_paths=['research/simulation-results.json','research/storage-durability-results.json','research/reassessment-ux.json','research/reassessment-automation.json','research/host-capability-snapshot.json']
fingerprints={path:hashlib.sha256((D/path).read_bytes()).hexdigest() for path in evidence_paths}
for path in ['scripts/simulate-library-pipeline.py','scripts/probe-storage-durability.py','scripts/catalog-discovery.py','tests/test_pipeline_simulation.py','tests/test_storage_durability.py','tests/test_catalog_discovery.py']:
 fingerprints['repository:'+path]=hashlib.sha256((ROOT/path).read_bytes()).hexdigest()
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Проверка целостности документов и экспортов; не тесты продукта','ok':True,'counts':{'projects':len(registry),'platforms':len(platforms),'authoredStories':len(stories),'stages':len(counter),'parameterizedCases':len(ids),'openApiOperations':len(all_operation_ids),'modelTraces':sim['traces'],'processProbeCases':storage['counts']['cases']},'evidenceFingerprintsAtValidation':fingerprints,'fingerprintScope':'Snapshot at documentation validation, not cryptographic attestation of prior executions','results':results}
(D/'DOCUMENT_VALIDATION.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'ok':True,'checks':len(results),'counts':report['counts']},ensure_ascii=False))
