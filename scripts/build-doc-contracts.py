import json,pathlib
P=pathlib.Path(__file__).resolve().parents[1]/'docs/gargantua'
def ref(name):return {'$ref':'#/components/schemas/'+name}
def string(maximum=250,**kw):return {'type':'string','maxLength':maximum,**kw}
def obj(properties,required=()):return {'type':'object','additionalProperties':False,'properties':properties,'required':list(required)}
uuid=string(36,format='uuid');revision={'type':'integer','minimum':0};sha=string(64,pattern='^[0-9a-f]{64}$');languages=string(35,pattern='^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$')
schemas={
 'Problem':obj({'code':string(80),'message':string(1000),'correlationId':string(80),'retryAfter':{'type':'integer','minimum':0,'maximum':86400}},['code','message','correlationId']),
 'EntityRef':obj({'id':uuid,'kind':{'enum':['author','work','series','expression','edition','artifact']},'label':string(250)},['id','kind']),
 'Profile':obj({'id':uuid,'login':string(60),'capabilities':{'type':'array','items':string(80),'maxItems':100}},['id','login','capabilities']),
 'SearchRequest':obj({'query':string(500,minLength=1),'intent':{'enum':['auto','book','series','author','url']},'language':languages,'includeCoauthored':{'type':'boolean'},'allowOriginal':{'type':'boolean'},'outputs':ref('OutputSelection')},['query','intent']),
 'SearchCandidate':obj({'entity':ref('EntityRef'),'explanation':string(1000),'sourceIds':{'type':'array','items':string(120),'maxItems':20},'needsClarification':{'type':'boolean'},'availability':{'enum':['already-local','already-server','fetchable','metadata-only','requires-access','needs-clarification','unsupported-source']}},['entity','needsClarification','availability']),
 'Plan':obj({'id':uuid,'revision':revision,'requestId':uuid,'requirementsRevision':revision,'outputs':ref('OutputSelection'),'requestedBy':uuid,'state':{'enum':['draft','needs-clarification','awaiting-approval','approved','running','partial','succeeded','failed','cancelled']},'candidates':{'type':'array','items':ref('SearchCandidate'),'maxItems':1000},'estimatedBytes':{'type':['integer','null'],'minimum':0},'requiresApproval':{'type':'boolean'}},['id','revision','requestId','requirementsRevision','outputs','requestedBy','state','candidates','requiresApproval']),
 'PlanDecision':obj({'revision':revision,'action':{'enum':['confirm','approve','reject','cancel']},'selectedEntities':{'type':'array','items':uuid,'maxItems':1000}},['revision','action']),
 'Locator':obj({'publicationId':uuid,'publicationRevision':revision,'chapterId':string(120),'blockId':string(120),'offset':{'type':'integer','minimum':0},'quote':obj({'exact':string(1000),'prefix':string(200),'suffix':string(200)},['exact']),'progression':{'type':'number','minimum':0,'maximum':1}},['publicationId','publicationRevision','chapterId']),
 'Annotation':obj({'id':uuid,'revision':revision,'locator':ref('Locator'),'note':string(10000),'kind':{'enum':['bookmark','highlight','note']},'deleted':{'type':'boolean'}},['id','revision','locator','kind']),
 'CatalogItem':obj({'entity':ref('EntityRef'),'title':string(250),'orderKey':string(80),'availability':{'enum':['metadata-only','local','server','partial','blocked']}},['entity','orderKey']),
 'Catalog':obj({'id':uuid,'revision':revision,'title':string(120,minLength=1),'parentId':{'type':['string','null'],'format':'uuid'},'items':{'type':'array','items':ref('CatalogItem'),'maxItems':500},'visibility':{'enum':['local-only','profile-private','library-shared','catalog-published']}},['id','revision','title','items','visibility']),
 'Theme':obj({'schemaVersion':{'const':1},'id':string(80,pattern='^[a-z0-9-]+$'),'name':string(120,minLength=1),'base':{'enum':['light','dark','oled','system']},'tokens':obj({'accent':string(7,pattern='^#[0-9A-Fa-f]{6}$'),'background':string(7,pattern='^#[0-9A-Fa-f]{6}$'),'text':string(7,pattern='^#[0-9A-Fa-f]{6}$'),'fontScale':{'type':'number','minimum':.8,'maximum':2},'radius':{'type':'integer','minimum':0,'maximum':24}}),'reader':obj({'fontFamily':{'enum':['serif','sans-serif','monospace']},'fontSize':{'type':'integer','minimum':12,'maximum':48},'lineHeight':{'type':'number','minimum':1.2,'maximum':2.8},'maxWidth':{'type':'integer','minimum':300,'maximum':1200}})},['schemaVersion','id','name','base','tokens']),
 'ModuleSetting':obj({'moduleId':string(80,pattern='^[a-z0-9.-]+$'),'apiVersion':{'type':'integer','minimum':1},'enabled':{'type':'boolean'},'order':{'type':'integer','minimum':0,'maximum':100}},['moduleId','apiVersion','enabled']),
 'ClientPreset':obj({'schemaVersion':{'const':1},'id':uuid,'revision':revision,'theme':ref('Theme'),'modules':{'type':'array','items':ref('ModuleSetting'),'maxItems':40}},['schemaVersion','id','revision','theme','modules']),
 'Artifact':obj({'id':uuid,'revision':revision,'sha256':sha,'bytes':{'type':'integer','minimum':0},'mediaType':string(100),'securityState':{'enum':['pending','blocked','passed','revoked']},'publicationRevision':revision,'schemaVersion':{'type':'integer','minimum':1}},['id','revision','sha256','bytes','mediaType','securityState']),
 'Job':obj({'id':uuid,'type':{'enum':['resolve','inventory','fetch','scan','parse','scan-derived','verify','publish','translate-segment','synthesize-segment','ocr-page','backup']},'state':{'enum':['queued','awaiting-approval','needs-clarification','awaiting-provider','awaiting-resources','running','paused','retry-at','blocked-security','failed','cancelled','succeeded']},'attempt':{'type':'integer','minimum':0},'progress':{'type':['number','null'],'minimum':0,'maximum':1},'reasonCode':string(80),'inputHashes':{'type':'array','items':sha,'maxItems':2000}},['id','type','state','attempt']),
 'Grant':obj({'id':uuid,'profileId':uuid,'capability':{'enum':['request.create','acquire.autoapprove','subscribe.updates','translate.request','tts.request','catalog.publish','sources.manage','jobs.manage','security.manage']},'scope':string(250),'expiresAt':string(50,format='date-time'),'maxBooksPerDay':{'type':'integer','minimum':0},'maxBytesPerDay':{'type':'integer','minimum':0}},['id','profileId','capability','scope']),
 'TranslateRequest':obj({'artifactId':uuid,'sourceRevision':revision,'targetLanguage':languages,'providerId':string(120),'glossaryRevision':revision,'sampleFirst':{'type':'boolean'}},['artifactId','sourceRevision','targetLanguage','sampleFirst']),
 'TtsRequest':obj({'sourceText':ref('PinnedTextRef'),'recipe':ref('VoiceRecipe'),'sampleFirst':{'type':'boolean','default':True}},['sourceText','recipe','sampleFirst']),
 'SyncMutation':obj({'mutationId':uuid,'deviceId':uuid,'counter':{'type':'integer','minimum':0},'baseRevision':revision,'entityType':{'enum':['annotation','catalog','client-preset']},'operation':{'enum':['upsert','delete']},'entityId':uuid,'payload':{'oneOf':[ref('Annotation'),ref('Catalog'),ref('ClientPreset')]}},['mutationId','deviceId','counter','baseRevision','entityType','operation','entityId','payload']),
 'SyncBatch':obj({'cursor':string(200),'mutations':{'type':'array','items':ref('SyncMutation'),'maxItems':100}},['mutations']),
 'SyncResult':obj({'cursor':string(200),'accepted':{'type':'array','items':uuid,'maxItems':100},'conflicts':{'type':'array','items':ref('Problem'),'maxItems':100}},['cursor','accepted','conflicts']),
 'Ok':obj({'ok':{'const':True}},['ok'])}
paths={}

schemas['OutputSelection']={'type':'array','items':{'enum':['book','audio']},'contains':{'const':'book'},'minItems':1,'maxItems':2,'uniqueItems':True,'default':['book','audio'],'description':'Omitted SearchRequest.outputs is normalized by the target server to book+audio. Explicit [book] requests text only; JSON Schema default is an annotation, not runtime mutation.'}
schemas['SessionContext']=obj({'profile':ref('Profile'),'csrfToken':string(128,minLength=32,pattern='^[A-Za-z0-9_-]+$'),'expiresAt':string(50,format='date-time')},['profile','csrfToken','expiresAt'])
schemas['PinnedTextRef']=obj({'publicationId':uuid,'publicationRevision':revision,'manifestSha256':sha},['publicationId','publicationRevision','manifestSha256'])
schemas['VoiceRecipe']=obj({'providerId':string(120,minLength=1),'engineId':string(120,minLength=1),'engineVersion':string(80,minLength=1),'modelId':string(120,minLength=1),'modelSha256':sha,'voiceId':string(120,minLength=1),'voiceSha256':sha,'configSha256':sha,'language':languages,'normalizationRevision':revision,'lexiconRevision':revision},['providerId','engineId','engineVersion','modelId','modelSha256','voiceId','voiceSha256','configSha256','language','normalizationRevision','lexiconRevision'])
schemas['StageResultRef']=obj({'kind':{'enum':['publication','narration','delivery']},'id':uuid,'revision':revision,'manifestSha256':sha},['kind','id','revision'])
schemas['StageResultRef']['allOf']=[{'if':{'properties':{'kind':{'enum':['publication','narration']}}},'then':{'required':['manifestSha256']}}]
schemas['DeliveryReport']=obj({'installationId':uuid,'clientEventId':uuid,'reportedByClient':{'const':True},'textLocalState':{'enum':['absent','staging','committed','corrupt']},'audioLocalState':{'enum':['absent','staging','committed','corrupt']}},['installationId','clientEventId','reportedByClient','textLocalState','audioLocalState'])
schemas['StageOutcome']=obj({'state':{'enum':['not-required','waiting','running','partial','ready','failed','blocked','cancelled']},'reasonCode':string(80,minLength=1),'result':ref('StageResultRef'),'deliveryReport':ref('DeliveryReport')},['state'])
schemas['StageOutcome']['allOf']=[{'if':{'properties':{'state':{'const':'ready'}}},'then':{'required':['result']}},{'if':{'properties':{'state':{'enum':['waiting','partial','failed','blocked','cancelled']}}},'then':{'required':['reasonCode']}}]
def outcome(kind):
 return {'allOf':[ref('StageOutcome'),{'properties':{'result':{'properties':{'kind':{'const':kind}}}}}]}
schemas['Bundle']=obj({'requestId':uuid,'requirementsRevision':revision,'targetLanguage':languages,'requiredOutputs':ref('OutputSelection'),'state':{'enum':['pending','partial','server-ready','device-ready','failed','blocked','cancelled']},'book':outcome('publication'),'translation':outcome('publication'),'audio':outcome('narration'),'delivery':outcome('delivery')},['requestId','requirementsRevision','targetLanguage','requiredOutputs','state','book','translation','audio','delivery'])
schemas['Bundle']['allOf']=[
 {'if':{'properties':{'state':{'enum':['server-ready','device-ready']}}},'then':{'properties':{'book':{'properties':{'state':{'const':'ready'}}}},'allOf':[{'if':{'properties':{'requiredOutputs':{'contains':{'const':'audio'}}}},'then':{'properties':{'audio':{'properties':{'state':{'const':'ready'}}}}}}]}},
 {'if':{'properties':{'state':{'const':'device-ready'}}},'then':{'properties':{'delivery':{'properties':{'state':{'const':'ready'}}}}}},
 {'if':{'properties':{'delivery':{'properties':{'state':{'const':'ready'}}}}},'then':{'properties':{'delivery':{'required':['deliveryReport'],'properties':{'deliveryReport':{'properties':{'textLocalState':{'const':'committed'}}}}}},'allOf':[{'if':{'properties':{'requiredOutputs':{'contains':{'const':'audio'}}}},'then':{'properties':{'delivery':{'properties':{'deliveryReport':{'properties':{'audioLocalState':{'const':'committed'}}}}}}}}]}}
]
def route(path,method,summary,response='Ok',body=None,public=False,array=False,capability=None):
 result={'summary':summary,'operationId':method+'_'+re.sub('[^a-zA-Z0-9]+','_',path).strip('_'),'x-design-status':'NOT_IMPLEMENTED','description':'Проектный контракт, не реализация. '+('Нужна capability: '+capability+'.' if capability else ''),'responses':{'200':{'description':'Результат','content':{'application/json':{'schema':{'type':'array','items':ref(response)} if array else ref(response)}}},**{str(code):{'description':label,'content':{'application/problem+json':{'schema':ref('Problem')}}} for code,label in [(400,'Неверный ввод'),(401,'Нужен серверный профиль'),(403,'Нет доступа'),(404,'Версия или объект не найдены'),(409,'Конфликт версии'),(413,'Превышен размер'),(429,'Превышена квота'),(503,'Недоступная зависимость')]}}}
 if public:result['security']=[]
 result['parameters']=[{'name':param,'in':'path','required':True,'schema':uuid} for param in re.findall(r'{([^}]+)}',path)]
 if method not in ('get','head') and not public:result['parameters'].append({'name':'X-CSRF-Token','in':'header','required':True,'schema':string(128)})
 if method not in ('get','head'):result['parameters'].append({'name':'Idempotency-Key','in':'header','required':True,'schema':uuid})
 if body:result['requestBody']={'required':True,'content':{'application/json':{'schema':ref(body)}}}
 paths.setdefault(path,{})[method]=result
import re
schemas['Login']=obj({'login':string(60,minLength=1),'password':string(256,minLength=1)},['login','password'])
route('/session','post','Войти в серверный профиль','SessionContext','Login',public=True)
route('/session','delete','Завершить текущий серверный сеанс')
route('/me','get','Получить профиль, CSRF и срок серверного сеанса','SessionContext')
paths['/session']['post']['responses']['200']['headers']={'Set-Cookie':{'description':'gargantua_session=<opaque>; Path=/; Secure; HttpOnly; SameSite=Strict. Cookie token is not returned in JSON; expiry matches SessionContext. No-store.','schema':string(1000)}}
paths['/session']['delete']['responses']['200']['headers']={'Set-Cookie':{'description':'Expire gargantua_session using the same Path/Secure/HttpOnly/SameSite attributes and Max-Age=0.','schema':string(1000)}}
for path,method in [('/session','post'),('/session','delete'),('/me','get')]:
 paths[path][method]['responses']['200'].setdefault('headers',{})['Cache-Control']={'schema':{'type':'string','const':'no-store'},'description':'Session context and CSRF must not enter shared caches or logs.'}
route('/requests','post','Создать запрос автора, серии или книги','Plan','SearchRequest',capability='request.create')
route('/requests/{id}/bundle','get','Получить раздельную готовность книги, перевода, аудио и доставки','Bundle')
paths['/requests/{id}/bundle']['get']['parameters'].append({'name':'requirementsRevision','in':'query','required':True,'schema':revision})
route('/plans/{id}','get','Прочитать версионный план','Plan')
route('/plans/{id}/decisions','post','Подтвердить уточнение, одобрить, отклонить или отменить','Plan','PlanDecision')
route('/catalogs','get','Получить каталоги доступного пространства','Catalog',array=True)
route('/catalogs/{id}','put','Сохранить каталог без неявной загрузки файлов','Catalog','Catalog')
route('/catalogs/{id}','delete','Удалить структуру отдельно от книг')
route('/catalogs/{id}/snapshots','post','Опубликовать разрешённый снимок каталога','Catalog',capability='catalog.publish')
route('/annotations/{id}','put','Сохранить аннотацию по версии','Annotation','Annotation')
route('/annotations/{id}','delete','Создать tombstone аннотации')
route('/sync','post','Принять идемпотентные операции и вернуть конфликты','SyncResult','SyncBatch')
route('/client-presets/{id}','put','Добровольно сохранить безопасный preset профиля','ClientPreset','ClientPreset')
route('/artifacts/{id}','get','Прочитать метаданные и состояние артефакта','Artifact')
route('/jobs/{id}','get','Прочитать понятное состояние задачи','Job')
route('/jobs/{id}','delete','Отменить допустимую задачу')
route('/translations','post','Запросить образец или перевод безопасного оригинала','Job','TranslateRequest',capability='translate.request')
route('/narrations','post','Запросить образец или синтез по версии текста','Job','TtsRequest',capability='tts.request')
route('/grants','post','Выдать ограниченное право','Grant','Grant',capability='security.manage')
route('/grants/{id}','delete','Отозвать право','Ok',capability='security.manage')
route('/security/lockdown','post','Остановить новую выдачу и обработку','Ok',capability='security.manage')
route('/security/artifacts/{id}/recipients','get','Получить журнал получателей','Profile',array=True,capability='security.manage')
route('/backups','post','Создать согласованный snapshot','Job',capability='security.manage')
route('/backups/{id}/verification','post','Проверить восстановление в отдельной среде','Job',capability='security.manage')
schemas['Resource']=obj({'path':string(300),'sha256':sha,'bytes':{'type':'integer','minimum':0},'mediaType':string(100)},['path','sha256','bytes','mediaType'])
schemas['ReadingOrderEntry']=obj({**schemas['Resource']['properties'],'chapterId':string(120,minLength=1)},['chapterId',*schemas['Resource']['required']])
schemas['Publication']=obj({'schemaVersion':{'const':2},'id':uuid,'revision':revision,'workId':uuid,'expressionId':uuid,'editionId':uuid,'title':string(250,minLength=1),'language':languages,'readingOrder':{'type':'array','items':ref('ReadingOrderEntry'),'minItems':1,'maxItems':20000},'resources':{'type':'array','items':ref('Resource'),'maxItems':30000}},['schemaVersion','id','revision','workId','title','language','readingOrder','resources'])
schemas['Chapter']=obj({'id':string(120),'revision':revision,'title':string(250),'blocks':{'type':'array','maxItems':30000,'items':obj({'id':string(120),'type':{'enum':['paragraph','heading','quote','verse','list','table','image','footnote','ruby']},'text':string(100000),'resource':string(300),'referenceId':string(120),'direction':{'enum':['ltr','rtl','auto']}},['id','type'])}},['id','revision','title','blocks'])
schemas['Narration']=obj({'id':uuid,'expressionId':uuid,'language':languages,'variantKey':uuid,'scope':{'enum':['profile-private','library-shared']}},['id','expressionId','language','variantKey','scope'])
schemas['AudioSegment']=obj({'id':uuid,'revision':revision,'sourceText':ref('PinnedTextRef'),'recipeSha256':sha,'locator':ref('Locator'),'spokenTextSha256':sha,'contentKind':{'enum':['tts','human-edited','synthetic-sample']},'resource':ref('Resource'),'durationMs':{'type':'integer','minimum':1}},['id','revision','sourceText','recipeSha256','locator','spokenTextSha256','contentKind','resource','durationMs'])
schemas['NarrationManifest']=obj({'schemaVersion':{'const':1},'narrationId':uuid,'revision':revision,'sourceText':ref('PinnedTextRef'),'recipe':ref('VoiceRecipe'),'segments':{'type':'array','items':ref('AudioSegment'),'minItems':1,'maxItems':20000},'totalDurationMs':{'type':'integer','minimum':1},'alignmentGranularity':{'enum':['none','segment','paragraph','word']}},['schemaVersion','narrationId','revision','sourceText','recipe','segments','totalDurationMs','alignmentGranularity'])
schemas['NarrationRevision']=obj({'narrationId':uuid,'revision':revision,'sourceText':ref('PinnedTextRef'),'recipe':ref('VoiceRecipe'),'state':{'enum':['waiting','sample','ready','blocked']},'complete':{'type':'boolean'},'quality':{'enum':['not-evaluated','rejected','accepted']},'segmentCount':{'type':'integer','minimum':0},'manifest':ref('Resource')},['narrationId','revision','sourceText','recipe','state','complete','quality','segmentCount'])
schemas['NarrationRevision']['allOf']=[{'if':{'properties':{'state':{'const':'ready'}}},'then':{'required':['manifest'],'properties':{'complete':{'const':True},'quality':{'const':'accepted'},'segmentCount':{'minimum':1}}}}]
schemas['Source']=obj({'id':string(120),'adapterVersion':string(80),'state':{'enum':['enabled','disabled','needs-review','broken']},'capabilities':{'type':'array','items':{'enum':['search','resolve','inventory','fetch','updates']},'maxItems':5},'languages':{'type':'array','items':languages,'maxItems':100}},['id','adapterVersion','state','capabilities'])
schemas['SourceReview']=obj({'url':string(2000,format='uri'),'comment':string(2000)},['url'])
schemas['WorkerClaim']=obj({'workerId':uuid,'capabilities':{'type':'array','items':string(80),'maxItems':30},'availableMemoryBytes':{'type':'integer','minimum':0}},['workerId','capabilities'])
schemas['WorkerLease']=obj({'task':ref('Job'),'leaseId':uuid,'fencingToken':{'type':'integer','minimum':1},'expiresAt':string(50,format='date-time'),'inputResources':{'type':'array','items':ref('Resource'),'maxItems':2000}},['task','leaseId','fencingToken','expiresAt','inputResources'])
schemas['WorkerResult']=obj({'leaseId':uuid,'fencingToken':{'type':'integer','minimum':1},'inputHashes':{'type':'array','items':sha,'maxItems':2000},'outputs':{'type':'array','items':ref('Resource'),'maxItems':2000},'error':ref('Problem')},['leaseId','fencingToken','inputHashes','outputs'])
route('/publications/{id}','get','Получить безопасный манифест выбранной версии','Publication')
route('/publications/{id}/chapters/{chapterId}','get','Получить безопасную главу','Chapter')
paths['/publications/{id}/chapters/{chapterId}']['get']['parameters'][1]['schema']=string(120)
route('/narrations/{id}','get','Получить конкретную ревизию аудио и ссылку на манифест','NarrationRevision')
route('/audio-segments/{id}','get','Получить конкретную ревизию аудиосегмента','AudioSegment')
route('/artifacts/{id}/package','get','Скачать полный подготовленный пакет')
paths['/artifacts/{id}/package']['get']['responses']['200']={'description':'Пакет с манифестом и хешами; активация после локальной проверки','content':{'application/zip':{'schema':{'type':'string','format':'binary'}}}}
for path in ['/publications/{id}','/publications/{id}/chapters/{chapterId}','/narrations/{id}','/audio-segments/{id}','/artifacts/{id}','/artifacts/{id}/package']:
 op=paths[path]['get'];op['parameters'].append({'name':'revision','in':'query','required':True,'schema':revision,'description':'Exact immutable revision, never implicit latest; missing/unknown revision is rejected.'});op['description']+=' Требуется точная revision; Range/resume не обещаны, базовая выдача полного ресурса. Состояние доступа/отзыва проверяется заново.'
route('/imports/uploads','post','Явно передать файл в обязательный карантин','Job')
paths['/imports/uploads']['post']['requestBody']={'required':True,'content':{'multipart/form-data':{'schema':obj({'file':{'type':'string','format':'binary'}},['file'])}}}
route('/sources','get','Список подключённых источников и возможностей','Source',array=True)
route('/sources/reviews','post','Предложить неизвестный сайт без автоматического crawling','Job','SourceReview',capability='request.create')
route('/workers/claims','post','Получить задачу по worker capability','WorkerLease','WorkerClaim')
route('/workers/tasks/{id}/results','post','Передать результат без права publish','Ok','WorkerResult')
for path in ['/workers/claims','/workers/tasks/{id}/results']:
 op=paths[path]['post'];op['security']=[{'workerMTLS':[]}];op['parameters']=[p for p in op['parameters'] if p['name']!='X-CSRF-Token'];op['description']='Проектный worker API: mTLS, отдельная идентичность и ограничение типов задач. Не предоставляет доступ к БД или publish.'
api={'openapi':'3.1.0','info':{'title':'Gargantua Personal Library — target contract','version':'2.0.0-design','description':'Целевой NOT_IMPLEMENTED контракт: default book+audio, раздельная готовность и точные immutable revisions. Данные/связи дополнительно проверяются по объектным правам, квотам, provenance и quality/security policy. JSON fixtures не доказывают качество TTS. Range не поддержан обещанием; проектируется полная выдача.'},'servers':[{'url':'/api/v2'}],'security':[{'serverSession':[]}],'paths':paths,'components':{'securitySchemes':{'serverSession':{'type':'apiKey','in':'cookie','name':'gargantua_session'},'workerMTLS':{'type':'mutualTLS'}},'schemas':schemas},'x-design-status':'NOT_IMPLEMENTED','x-known-gaps':['Plan schema does not yet cover every scope/budget/evidence/decision field from the domain specification.','Sync deltas/snapshots/conflict payloads, scoped invites/session administration, recipient audit and media transport need further design and implementation.','These schemas and fixture gates are documentation checks; no server, scanner, language quality or APK/EXE feature is implemented by them.']}
(P/'api.openapi.json').write_text(json.dumps(api,ensure_ascii=False,indent=2),encoding='utf-8')
# No external schema fetch: export a self-contained JSON Schema for theme import.
theme={'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'https://gargantua.invalid/schemas/theme-v1.json','title':'Gargantua declarative theme v1',**schemas['Theme']}
(P/'brand/theme.schema.json').write_text(json.dumps(theme,ensure_ascii=False,indent=2),encoding='utf-8')
print('OpenAPI',len(paths),'paths,',len(schemas),'schemas; design only.')
