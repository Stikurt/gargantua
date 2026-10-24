"""Produce a specification of 2,000 cases per stage; this does not execute product tests."""
import collections,csv,gzip,hashlib,importlib.util,io,itertools,json,pathlib,zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1];DOC=ROOT/'docs/gargantua';OUT=DOC/'scenarios';OUT.mkdir(exist_ok=True)
spec=importlib.util.spec_from_file_location('scenario_model',ROOT/'scripts/scenario-model.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
stages=m.STAGES;conditions=m.CONDITIONS
def make_case(stage,fi,pi,ci):
 flow=stage['flows'][fi];profile,expect=stage['profiles'][pi].split('|',1);condition=conditions[ci]
 index=fi*100+pi*10+ci+1
 status={'normal':'verdict-by-fixture','idempotent':'same-result-no-duplicate','cancelled':'cancelled','recoverable':'resume-or-safe-retry','awaiting-resources':'awaiting-resources','revision-conflict':'revision-conflict','invalid':'reject-uncommitted-data','timeout':'timeout-or-bounded-retry','permission':'local-continues' if stage['local'] else 'no-new-unauthorized-action','connectivity':'local-continues' if stage['local'] else 'follow-dependency-availability'}[condition['rule']]
 limited=condition['id'] in ('cancelled','resource','revision','corrupt','timeout') or condition['id']=='revoked' and not stage['local']
 profile_expectation=('Если проверка допустима и этап достигнут после более ранних gate: ' if limited else '')+expect
 return {'id':f'{stage["id"]}-{index:04}', 'stage':stage['id'],'operationId':f'{stage["id"]}-F{fi+1:02}','fixtureId':f'{stage["id"]}-D{pi+1:02}','conditionId':condition['id'],
 'operation':flow,'input':profile,'condition':condition['name'],'preconditions':'Изолированные синтетические данные; версия и права зафиксированы; доступные зависимости перечислены в fixture. Реальные книги и секреты пользователя не используются.',
 'steps':[f'Подготовить fixture {stage["id"]}-D{pi+1:02}: {profile}.',f'Вызвать «{flow}» с фиксированным operationId и версией входа.',f'Ввести условие «{condition["name"]}» на границе, описанной в fixture; дождаться ограниченного результата.', 'Сравнить состояние, файлы, индекс, журнал и отсутствие запрещённых побочных действий; повторить проверку после перезапуска, если условие требует.'],
 'expected':[profile_expectation,condition['expect'],stage['invariant']],'expectedStateRule':status,'shortCircuit':'Отмена/право до побочного действия имеют приоритет; затем недействительный вход; затем доступность зависимостей/ресурсов; потом результат операции. Реальное взаимодействие двух одновременных отказов требует отдельного fixture.',
 'classification':'параметризованный сценарий спецификации','executionStatus':'NOT_EXECUTED','automationReadiness':'требует реализации fixture и тестового адаптера; не готовый автоматический тест'}

definition={'schemaVersion':1,'date':'2026-10-22','stages':stages,'conditions':conditions,'meaning':'20 операций × 10 наборов данных × 10 условий = 2000 сценариев каждого этапа. Это параметризованное покрытие, не 32000 вручную придуманных независимых историй и не выполненные тесты.'}
(OUT/'model.json').write_text(json.dumps(definition,ensure_ascii=False,indent=2),encoding='utf-8')
manifest={'schemaVersion':1,'date':'2026-10-22','stageCount':len(stages),'perStage':2000,'total':len(stages)*2000,'executionStatus':'NOT_EXECUTED','coverageClaim':'полное покрытие объявленной конечной матрицы; не исчерпывающее покрытие всех возможных входов, состояний и их взаимодействий','stages':[]}
seen=set();archive=OUT/'gargantua-32000-scenarios.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for stage in stages:
  cases=[make_case(stage,fi,pi,ci) for fi,pi,ci in itertools.product(range(20),range(10),range(10))]
  assert len(cases)==2000
  for case in cases:assert case['id'] not in seen;seen.add(case['id'])
  payload=''.join(json.dumps(x,ensure_ascii=False,separators=(',',':'))+'\n' for x in cases).encode('utf-8')
  buffer=io.StringIO();writer=csv.writer(buffer);writer.writerow(['ID','Этап','Операция','Входные данные','Условие','Ожидаемый результат','Инвариант','Статус исполнения'])
  for c in cases:writer.writerow([c['id'],stage['name'],c['operation'],c['input'],c['condition'],' | '.join(c['expected'][:2]),stage['invariant'],c['executionStatus']])
  csv_bytes=b'\xef\xbb\xbf'+buffer.getvalue().encode('utf-8')
  zipped=gzip.compress(payload,compresslevel=9,mtime=0);(OUT/(stage['id']+'.jsonl.gz')).write_bytes(zipped)
  z.writestr(stage['id']+'.jsonl',payload);z.writestr(stage['id']+'.csv',csv_bytes)
  record={'id':stage['id'],'name':stage['name'],'cases':len(cases),'first':cases[0]['id'],'last':cases[-1]['id'],'jsonlFile':stage['id']+'.jsonl.gz','jsonlUncompressedSha256':hashlib.sha256(payload).hexdigest(),'compressedSha256':hashlib.sha256(zipped).hexdigest(),'operationCoverage':dict(collections.Counter(c['operationId'] for c in cases)),'fixtureCoverage':dict(collections.Counter(c['fixtureId'] for c in cases)),'conditionCoverage':dict(collections.Counter(c['conditionId'] for c in cases))}
  assert set(record['operationCoverage'].values())=={100};assert set(record['fixtureCoverage'].values())=={200};assert set(record['conditionCoverage'].values())=={200}
  manifest['stages'].append(record)
 z.writestr('model.json',json.dumps(definition,ensure_ascii=False,indent=2));z.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
 z.writestr('README.txt','Гаргантюа: 16 этапов по 2000 параметризованных сценариев. Все NOT_EXECUTED. CSV — для таблиц, JSONL — для обработки. Модель в model.json, контрольные суммы и покрытие в manifest.json. Сценарии требуют реализации fixtures и не являются доказательством готовности продукта.')
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
lines=['# 32 000 сценариев: минимум 2 000 для каждого этапа','',definition['meaning'],'','Отдельно остаются [200 авторских историй](SCENARIOS.md). Их нельзя суммировать и называть 32 200 уникальными ручными пользовательскими историями: матрица расширяет классы условий, а не заменяет смысловую приёмку.','',
'[Открыть интерактивный каталог](scenario-explorer.html) · [Полный ZIP: JSONL и CSV](scenarios/gargantua-32000-scenarios.zip) · [Модель](scenarios/model.json) · [Манифест и покрытие](scenarios/manifest.json)','',
'## Реестр этапов','','| Этап | Содержание | Количество | ID | Данные |','|---|---|---:|---|---|']
for s,record in zip(stages,manifest['stages']):lines.append(f'| {s["id"]} | {s["name"]} | 2 000 | {record["first"]} … {record["last"]} | [{s["id"]}.jsonl.gz](scenarios/{s["id"]}.jsonl.gz) |')
lines+=['','## Как читать один сценарий','',
'ID определяет этап, операцию, fixture и условие. Каждая строка содержит подготовку, действие, введение условия, ожидаемые результаты и обязательный инвариант. В ZIP лежат развёрнутые сценарии, а не только число комбинаций. Один и тот же operationId используется для проверок идемпотентности в изолированном тесте; это не реальный ID пользователя.','',
'## Применимость и приоритеты','',
'Конкретный test fixture задаёт формат, права, версии, доступные модели и зависимости. Для формата без определённой возможности проверяется корректное отсутствие/отказ этой возможности, а не выдуманная поддержка. Внешняя сеть и доступ к домашнему серверу различаются: установленная локальная модель может переводить на сервере без интернета; системный офлайн-голос работает без сервера; получение нового внешнего файла требует источника. Правило follow-dependency-availability разворачивается в явную проверку нужной зависимости в fixture.','',
'Отмена и запрет до побочного действия имеют приоритет. Непроверенный вход не достигает публикации. При нехватке ресурсов сохраняется checkpoint; при конфликте версии результат не приклеивается к новой версии. Сценарии одной оси отказа не заменяют проверку гонок и двух одновременных отказов: их нужно добавлять отдельно, а не считать покрытыми декартовым произведением.','',
'## Что проверено в самом каталоге','',
'Автоматически проверены 16 этапов, ровно 2000 строк на каждом, 32 000 уникальных ID, наличие обязательных полей, 20 разных операций и 10 разных fixtures каждого этапа, все 10 условий, равномерное покрытие каждой оси и контрольные суммы экспортов. Это проверка целостности спецификации. Реальные продуктовые тесты, смысловая независимость всех комбинаций и полное покрытие пространства состояний не заявляются.','',
'## Практический порядок автоматизации','',
'Сначала общие инварианты безопасности и сохранения данных; затем 200 ручных историй; затем приоритетные строки матрицы с реальными fixtures. Каждому выполненному тесту назначать fixtureVersion, app/build version, входные hash, платформу, результат и ссылку на отчёт. Пока тест не выполнен — только NOT_EXECUTED. Не маркировать готовность этапа по числу сгенерированных сценариев.']
(DOC/'SCENARIO_CATALOG.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
summary=json.loads((DOC/'research/summary.json').read_text(encoding='utf-8'));summary.update({'authoredStories':200,'parameterizedScenarios':32000,'scenarioStages':16,'casesPerStage':2000});(DOC/'research/summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
print('Created',manifest['total'],'cases in',len(stages),'stages. ZIP',archive.stat().st_size,'bytes. Product tests NOT_EXECUTED.')
