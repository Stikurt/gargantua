import concurrent.futures as futures,importlib.util,pathlib,json,re,time
base=pathlib.Path(__file__).resolve().parents[1];folder=base/'docs/gargantua/research'
spec=importlib.util.spec_from_file_location('collector',base/'scripts/research-library.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
records=json.loads((folder/'projects-feedback.json').read_text(encoding='utf-8'))
extra_exclude=re.compile(r'ethereum-development|paper-reading|gopher-reading-list|/bookdown$|/Anime-Apex|/safaribooks|/fqapp',re.I)
records=[x for x in records if x['feedback']['observations'] and not extra_exclude.search(x['repo'])]
def detail(entry):
    observations=entry['feedback']['observations']
    def relevance(x):return len(re.findall(r'offline|sync|download|bookmark|chapter|catalog|search|epub|progress|read|memory|crash|storage|import|voice|translat|image',x['title'],re.I))
    chosen=max(observations,key=relevance)
    text,meta=m.fetch(chosen['url'],'issue-detail');body='';headline=''
    for block in re.findall(r'<script\b[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',text,re.S):
        try:
            data=json.loads(block)
            if isinstance(data,dict) and data.get('articleBody'):
                body=data['articleBody'];headline=data.get('headline','');break
        except Exception:pass
    kinds=[]
    for name,pattern in [('Синхронизация',r'\bsync|kobo|conflict'),('Офлайн и скачивание',r'offline|download|cache|storage'),('Импорт и форматы',r'epub|pdf|fb2|parse|import|archive|cbz'),('Навигация и позиция',r'progress|position|bookmark|chapter|navigation'),('Интерфейс и доступность',r'theme|font|dark|screen|interface|accessib|display|layout'),('Метаданные и поиск',r'metadata|author|search|series|catalog|cover|isbn'),('Безопасность и доступ',r'auth|login|password|permission|security|vulnerab|token'),('Производительность',r'memory|cpu|slow|crash|performance|freeze'),('Перевод и аудио',r'translat|voice|speech|tts|audio')]:
        if re.search(pattern,headline+' '+body,re.I):kinds.append(name)
    entry['selected_feedback']={'title':' '.join(chosen['title'].split()[:20]),'url':chosen['url'],'source':meta,'body_retrieved':bool(body),'body_characters':len(body),'themes':kinds,'verification':'сообщение автора обращения; поведение независимо не воспроизводилось'}
    # Remove extra exact quotations from the listing page in the published evidence.
    entry['feedback']['observations']=[{'title':' '.join(chosen['title'].split()[:20]),'url':chosen['url'],'kind':'выбранное обращение; заголовок не является доказательством дефекта'}]
    entry['description_excerpt']=' '.join(entry.get('description_excerpt','').split()[:20])
    for group in ('stack_mentions','feature_mentions'):
        for mention in entry[group]:mention.pop('context',None)
    time.sleep(.2)
    return entry

def manifest(entry):
    repo=entry['repo'];names={x['name'] for x in entry['stack_mentions']}
    options=['package.json','Dockerfile']
    if 'Flutter' in names:options=['pubspec.yaml','package.json','Dockerfile']
    elif 'Kotlin' in names:options=['app/build.gradle.kts','app/build.gradle','build.gradle.kts','build.gradle']
    elif 'Swift' in names:options=['Package.swift','Podfile','project.yml']
    elif 'Python' in names:options=['pyproject.toml','requirements.txt','setup.py','Dockerfile']
    elif 'Rust' in names or 'Tauri' in names:options=['Cargo.toml','src-tauri/Cargo.toml','package.json','Dockerfile']
    elif 'Java' in names:options=['pom.xml','build.gradle','build.gradle.kts','Dockerfile']
    verified=[];sources=[]
    for file in options:
        source,meta=m.fetch(f'https://raw.githubusercontent.com/{repo}/HEAD/{file}','build-manifest')
        if not source:continue
        sources.append(meta)
        if file.endswith('package.json'):
            try:
                data=json.loads(source);deps={**data.get('dependencies',{}),**data.get('devDependencies',{})}
                for name in ('react','vue','svelte','electron','next','@tauri-apps/api','@angular/core','express','vite','pg','better-sqlite3','sqlite3'):
                    if name in deps:verified.append({'name':name,'declared_version':str(deps[name]),'source':meta['url']})
            except Exception:pass
        else:
            language={'Cargo.toml':'Rust','src-tauri/Cargo.toml':'Rust','pubspec.yaml':'Dart/Flutter','Package.swift':'Swift','Podfile':'CocoaPods','pyproject.toml':'Python','requirements.txt':'Python','setup.py':'Python','pom.xml':'Maven/JVM','app/build.gradle.kts':'Gradle/Android','app/build.gradle':'Gradle/Android','build.gradle.kts':'Gradle/JVM','build.gradle':'Gradle/JVM'}.get(file)
            if language:verified.append({'name':language,'source':meta['url']})
            if file=='Dockerfile':
                for image in re.findall(r'^FROM\s+([^\s]+)',source,re.M|re.I):verified.append({'name':'Docker base '+image,'source':meta['url']})
        if len(sources)>=2:break
    entry['build_evidence']={'sources':sources,'confirmed_declarations':verified,'scope':'объявления сборки; полный граф зависимостей и работа установкой не проверялись'}
    return entry

output=[]
with futures.ThreadPoolExecutor(max_workers=2) as pool:
    for entry in pool.map(detail,records):
        output.append(entry)
        if len(output)%20==0:
            (folder/'projects-detailed.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8');print('issue bodies',len(output),'retrieved',sum(x['selected_feedback']['body_retrieved'] for x in output),flush=True)
(folder/'projects-detailed.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
with futures.ThreadPoolExecutor(max_workers=5) as pool:
    built=[]
    for entry in pool.map(manifest,output):
        built.append(entry)
        if len(built)%20==0:print('manifests',len(built),flush=True)
(folder/'projects-reviewed.json').write_text(json.dumps(built,ensure_ascii=False,indent=2),encoding='utf-8')
print('DONE',len(built),flush=True)
