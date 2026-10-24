"""Build inspectable research appendices from fetched evidence, without inventing support claims."""
import collections,csv,html,json,pathlib,re,hashlib,math
from PIL import Image,ImageDraw
ROOT=pathlib.Path(__file__).resolve().parents[1];DOC=ROOT/'docs/gargantua';R=DOC/'research'
records=json.loads((R/'projects-reviewed.json').read_text(encoding='utf-8'))
records=[x for x in records if x['selected_feedback']['body_retrieved'] and x['repo'].lower()!='readium/mobile']
assert len(records)>=200
groups={
 'reader':('Читалка/клиент','локальный или сетевой доступ к публикации → навигация → позиция и заметки','Пользовательское чтение и настройки можно отделить от получения книги','Наличие удобного чтения не подтверждает безопасный серверный импорт.'),
 'server':('Сервер библиотеки','хранилище коллекции → каталог/API → клиент чтения','Централизованный каталог и выдача снижают повторение метаданных','Серверная доступность не заменяет автономное хранилище клиента.'),
 'sdk':('Движок/SDK/валидатор','входная публикация → модель/проверка → API встраивания','Узкий контракт обработки позволяет отделить формат от UI','Библиотека не предоставляет весь продукт: профили, резервирование и gate нужны отдельно.'),
 'source':('Получение/конвертация','источник/каталог → адаптер → подготовленный документ','Специализированный адаптер проще тестировать и отключать по одному','Чужой downloader не является подтверждением разрешённого доступа или безопасности файла.'),
 'audio':('Аудио/TTS','текст или аудиофайл → сегменты/главы → сохранение позиции','Сегментация и независимая аудиопозиция полезны для связки чтения и слушания','Модель, голос, качество и фоновые возможности проверяются отдельно.'),
 'translate':('Перевод/OCR','исходные сегменты → модель/провайдер → производная версия','Отдельная производная версия сохраняет исходник и позволяет повторную обработку','Факт наличия перевода не доказывает качество и полноту, особенно для художественного текста.'),
 'adjacent':('Смежный менеджер чтения','сохранение/индекс → организация → чтение или просмотр','Полезны организация, минимальный интерфейс и переносимость записей','Это смежный инструмент; его нельзя считать полноценной EPUB/манга-читалкой без проверки.')
}
def category(p):
 n=p['repo'].lower();text=p.get('description_excerpt','').lower()
 if any(s in n for s in ['translat','pdf-craft']):return 'translate'
 if any(s in n for s in ['audio','tts','voice','abogen','bookplayer','m4b-tool','pandrat','audnexus','odmpy','campfire','libratory','deepstory','audible','booklibconnect']):return 'audio'
 if any(s in n for s in ['fanficfare','webtoepub','kindle-send','kindlefy','pyebooktools','work_crawler','downloader','mangadesk','kaizoku','manga-py','/fmd','mloader','readmangagrabber','mangodl','mikack','percollate','/kcc','standardebooks/tools']):return 'source'
 if any(s in n for s in ['toolkit','epub.js','foliate-js','epubcheck','/sigil','react-reader','react-native-readium','epubjs-react-native','dart-epub','epub_viewer','pymupdf','ebooklib']):return 'sdk'
 if any(s in n for s in ['calibre-web','kavita','komga','stump','sync-server','/mango','suwayomi','bookorbit','colibri','cops','nowen','bicbucstriim','gopds','/server','lanraragi','grimmory','dir2opds','/sake','/issued','/tome','bookoasis','teemii','gazee','omnibus','biblioteca','bookboss','/citadel','chaptarr','lazylibrarian','/readarr','legado-server','bookserver']):return 'server'
 if any(s in n for s in ['bookstack','shiori','linkwarden','omnivore','linkding','freshrss','miniflux','bookwyrm','obsidian','audnexus']):return 'adjacent'
 return 'reader'
solutions={
 'Синхронизация':'Хранить локальные commits, версионные изменения и явный конфликт вместо молчаливой перезаписи.',
 'Офлайн и скачивание':'Подтверждать локальный пакет, hash и индекс; проверять холодный запуск без сети.',
 'Импорт и форматы':'Отделять получение, проверку структуры и безопасную модель публикации; иметь негативные fixtures.',
 'Навигация и позиция':'Использовать устойчивый локатор с версией текста и сохранять историю переходов.',
 'Интерфейс и доступность':'Проверять тему, размеры окна, фокус и доступность на всех экранах.',
 'Метаданные и поиск':'Разделять автора, произведение, издание и артефакт; хранить источник каждого сопоставления.',
 'Безопасность и доступ':'Проверять вход и объектные права на сервере; не доверять путям и данным клиента.',
 'Производительность':'Измерять расход ресурсов, ограничивать исполнителя и не блокировать UI тяжёлой работой.',
 'Перевод и аудио':'Хранить версии провайдера/модели и сегменты; принимать качество после образца.'}
public=[]
for i,p in enumerate(records,1):
 kind=category(p);g=groups[kind];feedback=p['selected_feedback'];topics=feedback['themes'];build=p['build_evidence']
 declarations=list(dict.fromkeys(d['name'] for d in build['confirmed_declarations'] if not d['name'].endswith('--platform=$BUILDPLATFORM')))
 rec={'id':f'PRJ-{i:03}','name':p['repo'].split('/')[-1],'repository':p['repo'],'url':'https://github.com/'+p['repo'],'category':g[0],
 'architecture_analysis':g[1],'advantage_analysis':g[2],'limitation_analysis':g[3],
 'readme':p['readme'],'readme_topics':[x['name'] for x in p['feature_mentions']],
 'readme_technology_mentions':[x['name'] for x in p['stack_mentions']],
 'build_sources':build['sources'],'build_declarations':declarations,
 'feedback_url':feedback['url'],'feedback_source':feedback['source'],'feedback_body_characters':feedback['body_characters'],
 'feedback_themes':topics,'feedback_scope':'Тело одного обращения получено; темы размечены правилами. Не независимый тест и не статистика всех отзывов.',
 'lesson_analysis':solutions.get(topics[0] if topics else '', 'Держать диагностику, совместимость версий и проверяемое воспроизведение проблемы отдельно от UI.'),
 'archived_banner_observed':p['feedback']['archived_banner'],
 'evidence_level':'README + текст обращения + файл сборки' if build['sources'] else 'README + текст обращения; файл сборки не подтверждён'}
 public.append(rec)
(R/'registry.json').write_text(json.dumps(public,ensure_ascii=False,indent=2),encoding='utf-8')
with (R/'registry.csv').open('w',encoding='utf-8-sig',newline='') as file:
 fields=['id','name','repository','category','url','evidence_level','build_declarations','feedback_url','feedback_themes','advantage_analysis','limitation_analysis','lesson_analysis']
 writer=csv.DictWriter(file,fieldnames=fields);writer.writeheader()
 for p in public:writer.writerow({k:'; '.join(p[k]) if isinstance(p[k],list) else p[k] for k in fields})
counts=collections.Counter(x['category'] for x in public)
stats={'date':'2026-10-22','discovery_candidates':612,'shortlisted':304,'feedback_detail_attempts':236,'registry_projects':len(public),'projects_with_feedback_body':len(public),'projects_with_build_file':sum(bool(x['build_sources']) for x in public),'categories':dict(counts),'platforms':40,'scenarios':200,'scope':'Документарный обзор; автоматизированный сбор и предварительная тематическая разметка; не установка и полный исходный аудит каждого проекта.'}
(R/'summary.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding='utf-8')
lines=['# Реестр проектов и обращений пользователей','',f'Проверка 22 октября 2026 года. **{len(public)} уникальные записи** после устранения одинаковых README/алиасов. Для каждой получены README и тело одного обращения; для {stats["projects_with_build_file"]} также найден файл сборки. Наличие файла сборки не означает подтверждения всего стека.','',
'Это широкий документарный обзор. Категория, функциональная схема, преимущества и ограничения — наш анализ применимости, а не подтверждённый benchmark. Технологии из build-файла и упоминания README разделены. Keyword-темы README не считаются доказательством поддержки функции. Обращения не воспроизводились и могут быть исправлены; выборка не является рейтингом качества. В реестр входят самостоятельные продукты, существенно развившиеся производные проекты и явно помеченные смежные инструменты/SDK; это не 222 одинаково зрелые читалки.','',
'Форматы: [CSV](research/registry.csv), [JSON с URL и хешами источников](research/registry.json), [методика](RESEARCH_METHOD.md).','', '| Категория | Записей |','|---|---|']
lines += [f'| {k} | {v} |' for k,v in counts.items()]
lines+=['','## Быстрый указатель','','| ID | Проект | Категория | Обращение |','|---|---|---|---|']
lines += [f'| [{p["id"]}](#{p["id"].lower()}) | [{p["repository"]}]({p["url"]}) | {p["category"]} | [Открыть]({p["feedback_url"]}) |' for p in public]
for p in public:
 lines+=['',f'<a id="{p["id"].lower()}"></a>',f'## {p["id"]}. {p["repository"]}','',f'**Роль:** {p["category"]}. [Проект]({p["url"]}) · [прочитанный README]({p["readme"]["url"]}) · [обращение пользователя]({p["feedback_url"]}).','',
 f'**Как разложить для сравнения:** {p["architecture_analysis"]}. Это функциональная аналитическая схема; точное внутреннее взаимодействие требует отдельного чтения реализации.', '',
 '**Устройство по источникам:** '+('объявления сборки: '+', '.join(p['build_declarations'])+'.' if p['build_declarations'] else 'подтверждённый полный стек не установлен.')+(' Файлы: '+', '.join(f'[источник {j+1}]({s["url"]})' for j,s in enumerate(p['build_sources']))+'.' if p['build_sources'] else ' Файл сборки в проверенных путях не получен.'),
 'Упомянутые README технологии: '+(', '.join(p['readme_technology_mentions']) or 'явных совпадений в выбранном словаре нет')+'. Их присутствие не доказывает архитектуру или поддержку.', '',
 f'**Преимущество подхода для нас:** {p["advantage_analysis"]}', '',f'**Ограничение переноса:** {p["limitation_analysis"]}', '',
 '**Обратная связь:** получено тело обращения; тематическая разметка: '+(', '.join(p['feedback_themes']) or 'специфическая тема, требующая ручной классификации')+'. Формальная классификация может ошибаться; для деталей открыт исходный URL. Это не утверждение наличия дефекта в актуальном релизе.', '',
 f'**Решение для Гаргантюа:** {p["lesson_analysis"]}', '', f'**Качество доказательства:** {p["evidence_level"]}; дата/размер/хеш сохранены в JSON. '+('На странице наблюдался баннер архивации; это отдельный риск дальнейшего использования.' if p['archived_banner_observed'] else 'Отсутствие наблюдённого баннера не доказывает активную поддержку.')]
(DOC/'PROJECTS.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')

platforms=json.loads((R/'websites-evidence.json').read_text(encoding='utf-8'))
lines=['# Сайты новелл, манги и комиксов','', '40 отдельных точек исследования, дополнительно к реестру проектов. HTTP 200 подтверждает получение страницы, а не доступ к полному каталогу или разрешение автоматического скачивания. JavaScript-оболочка не доказывает проверку функций. Колонка «Что изучать» — вопрос для UX/адаптера, не приписывание сайту неподтверждённых возможностей.','',
'| Платформа | Тип | Что изучать / применимость | Получение страницы | Режим подключения |','|---|---|---|---|---|']
for p in platforms:
 status=p['retrieval'].get('status',0);state='HTTP '+str(status) if status else 'не получена; ошибка/таймаут'
 lines.append(f'| [{p["name"]}]({p["url"]}) | {p["kind"]} | {p["focus"]} | {state} | {p["integration"]} |')
lines+=['','## Подтверждённые UX-примеры и обратная связь','',
'[Royal Road: Advanced Search](https://www.royalroad.com/support/knowledgebase/79) разделяет поиск названия и автора и предоставляет фильтры статуса. В [пользовательских предложениях](https://www.royalroad.com/ideas?category=General&page=5&sorting=Newest) встречаются запросы к адаптации размеров окна и доступности настроек уведомлений. Вывод: одинаковые основные фильтры на телефоне и ПК; подписка и её настройки доступны на карточке книги.', '',
'[Royal Road: персональные списки](https://www.royalroad.com/support/knowledgebase/81) показывает ценность отдельного списка обновлений; для нас нужен компактный список новых глав с реальной позицией продолжения.', '',
'[Novel Updates Series Finder](https://www.novelupdates.com/series-finder/) демонстрирует совместные фильтры тега, языка, группы и завершённости. Для Гаргантюа это metadata-поиск и уточнение, а не основание утверждать, что Novel Updates хранит нужные полные тексты.', '',
'Для остальных платформ полный корпус UX-отзывов отдельно не заявляется: доступная главная страница, справка и ограничения получения отмечены в [журнале](research/websites-evidence.json). Обзоры конкретной новеллы/манги нельзя выдавать за оценку интерфейса сайта.', '',
'## Приоритет адаптеров','',
'P0: существующий RanobeLib, прямой файл, ручной импорт. P1: библиографические Open Library/другие подтверждённые metadata-провайдеры, предусмотренный экспорт свободных библиотек. P2: отдельный MangaDex-адаптер после проверки актуальных правил. Остальные сайты — заявка владельцу и отдельное исследование; наличие в таблице не включает скачивание.']
(DOC/'PLATFORMS.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')

scenarios=list(csv.DictReader((DOC/'SCENARIOS.tsv').open(encoding='utf-8'),delimiter='\t'));assert len(scenarios)==200
scenario_public=[{'id':f'SCN-{i:03}',**s,'origin':'спроектированный сценарий; не заявление о найденном отдельном интернет-отзыве'} for i,s in enumerate(scenarios,1)]
(R/'scenarios.json').write_text(json.dumps(scenario_public,ensure_ascii=False,indent=2),encoding='utf-8')
lines=['# 200 сценариев и критерии приёмки','', 'Это авторские продуктовые, аварийные и негативные сценарии по требованиям пользователя и выводам исследования. Они не выдаются за 200 найденных и независимо подтверждённых интернет-инцидентов. Каждый содержит ситуацию, решение и проверяемый результат. Реальное выполнение тестов — отдельный отчёт.','', '[TSV](SCENARIOS.tsv) · [JSON с устойчивыми ID](research/scenarios.json) · [безопасность](SECURITY_AND_OPERATIONS.md)','']
last=None
for s in scenario_public:
 if s['category']!=last:
  last=s['category'];lines+=['',f'## {last}','','| ID | Ситуация | Решение | Приёмка |','|---|---|---|---|']
 lines.append(f'| {s["id"]} | {s["situation"]} | {s["solution"]} | {s["acceptance"]} |')
(DOC/'SCENARIOS.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')

# Original two-colour icon, rendered with local vector geometry; no downloaded artwork.
scale=4;im=Image.new('RGB',(256*scale,256*scale),(8,8,10));d=ImageDraw.Draw(im)
S=lambda box:tuple(round(v*scale) for v in box)
red=(204,36,56);black=(8,8,10)
d.ellipse(S((59,57,197,195)),outline=red,width=7*scale)
orbit=Image.new('RGBA',im.size,(0,0,0,0));od=ImageDraw.Draw(orbit);od.ellipse(S((20,98,236,160)),outline=red+(255,),width=8*scale);orbit=orbit.rotate(18,resample=Image.Resampling.BICUBIC);im.paste(orbit,(0,0),orbit);d=ImageDraw.Draw(im);d.ellipse(S((76,74,180,178)),fill=black)
pts=[(91,106),(108,106),(128,115),(148,106),(165,106),(165,150),(148,150),(128,159),(108,150),(91,150),(91,106)]
d.line([(x*scale,y*scale) for x,y in pts],fill=red,width=7*scale,joint='curve');d.line(S((128,116,128,158)),fill=red,width=7*scale)
im=im.resize((512,512),Image.Resampling.LANCZOS);im.save(DOC/'brand/gargantua-icon.png')

# Strip long verbatim source extracts from intermediary public JSON files. Private cache retains fetched originals.
for name in ['projects-evidence.json','shortlist.json','projects-feedback.json','projects-detailed.json','projects-reviewed.json']:
 path=R/name
 if not path.exists():continue
 data=json.loads(path.read_text(encoding='utf-8'))
 private=ROOT/'.local/research-gargantua'/('full-'+name)
 if not private.exists():private.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
 for p in data:
  p.pop('description_excerpt',None)
  for group in ('stack_mentions','feature_mentions'):
   for item in p.get(group,[]):item.pop('context',None)
  if p.get('feedback'):
   for item in p['feedback'].get('observations',[]):item.pop('title',None)
  if p.get('selected_feedback'):p['selected_feedback'].pop('title',None)
 path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(stats,ensure_ascii=False,indent=2))
