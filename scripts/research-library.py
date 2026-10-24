"""Collect public project documentation and issue titles; never execute remote code."""
import concurrent.futures as futures
import datetime, hashlib, html, json, pathlib, re, time, urllib.request, urllib.error

ROOT=pathlib.Path(__file__).resolve().parents[1]
CACHE=ROOT/'.local'/'research-gargantua'
OUT=ROOT/'docs'/'gargantua'/'research'
CACHE.mkdir(parents=True,exist_ok=True);OUT.mkdir(parents=True,exist_ok=True)
STAMP=datetime.datetime.now(datetime.timezone.utc).isoformat()
def fetch(url,kind='source'):
    key=hashlib.sha256(url.encode()).hexdigest();file=CACHE/(key+'.txt');meta=CACHE/(key+'.json')
    if file.exists() and meta.exists():
        return file.read_text(encoding='utf-8'),json.loads(meta.read_text(encoding='utf-8'))
    try:
        req=urllib.request.Request(url,headers={'User-Agent':'GargantuaDocumentationResearch/1.0 (public documentation; no login)','Accept':'text/html,text/plain,application/json'})
        with urllib.request.urlopen(req,timeout=22) as response:
            data=response.read(1200000);text=data.decode('utf-8',errors='replace');info={'url':url,'resolved_url':response.url,'status':response.status,'retrieved_at':STAMP,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'kind':kind}
        file.write_text(text,encoding='utf-8');meta.write_text(json.dumps(info,ensure_ascii=False),encoding='utf-8');return text,info
    except Exception as e:
        return '',{'url':url,'status':getattr(e,'code',0),'error':str(e)[:180],'retrieved_at':STAMP,'kind':kind}
def clean(text):
    return re.sub(r'\s+',' ',html.unescape(re.sub('<[^>]+>',' ',text))).strip()

SEEDS='''kovidgoyal/calibre janeczku/calibre-web crocodilestick/Calibre-Web-Automated Kareadita/Kavita gotson/komga advplyr/audiobookshelf booklore-app/booklore GrimmoryTools/grimmory bookpuff/bookpuff stomp/stump stumpapp/stump koreader/koreader koreader/koreader-sync-server readest/readest johnfactotum/foliate koodo-reader/koodo-reader troyeguo/koodo-reader foobnix/LibreraReader geometer/FBReaderJ documentfoundation/LibreOffice Readium/thorium-reader edrlab/thorium-reader readium/readium-desktop readium/kotlin-toolkit readium/swift-toolkit readium/ts-toolkit futurepress/epub.js johnfactotum/foliate-js IDPF/epubcheck w3c/epubcheck mozilla/pdf.js mementum/bibi Sigil-Ebook/Sigil pgaskin/LiteraTure sumatrapdfreader/sumatrapdf buxtronix/BookReader Librum-Reader/Librum OpenAudible/openaudible oppiliappan/libreddit getmango/Mango ollm/OpenComic hawk86104/airflow Calibre-Web-Automated/Calibre-Web-Automated Suwayomi/Suwayomi-Server Suwayomi/Tachidesk-Server mihonapp/mihon tachiyomiorg/tachiyomi jobobby04/TachiyomiSY Jays2Kings/tachiyomiJ2K yokaiapp/yokai LNReader/lnreader LNReader/lnreader-plugins shosetsuorg/shosetsu shosetsuorg/extensions Imsdcat/Legado gedoor/legado J-Novel-Club/jnovel-chrome nanook/Novel-Grabber FlareSolverr/FlareSolverr FanFicDev/hermes FanFicDev/ficdl JimmXinu/FanFicFare dteviot/WebToEpub lightnovel-crawler/lightnovel-crawler daijro/lightnovel-crawler dino-/epub-tools LazyLibrarian/LazyLibrarian Readarr/Readarr CervantesApp/CervantesBookClub buku/buku BookStackApp/BookStack go-shiori/shiori wallabag/wallabag linkwarden/linkwarden omnivore-app/omnivore readeck/readeck sissbruecker/linkding FreshRSS/FreshRSS miniflux/v2 sismics/docs paperless-ngx/paperless-ngx zlibrary/calibre-web bookwyrm-social/bookwyrm Mathesar/Mathesar archive-org/bookreader internetarchive/bookreader standardebooks/tools ProjectGutenberg/gutenberg-site seblucas/cops paulhodel/jspreadsheet'''.split()
# Seeds are candidates, not evidence of existence or inclusion.
TOPICS=['ebook-reader','epub-reader','ebook-manager','book-reader','manga-reader','comic-reader','novel-reader','audiobook','opds','book-management','manga-downloader','epub','reading-list','read-it-later','book-library','novel-downloader']
def discover():
    candidates={repo:{'repo':repo,'discovered':['seed']} for repo in SEEDS}
    urls=[f'https://github.com/topics/{topic}?page={page}' for topic in TOPICS for page in (1,2)]
    def one(url):
        text,meta=fetch(url,'discovery');found=[]
        for heading in re.findall(r'<h3\b.*?</h3>',text,re.S):
            for owner,repo in re.findall(r'href="/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)"',heading):
                found.append(owner+'/'+repo)
        return url,meta,list(dict.fromkeys(found))
    records=[]
    with futures.ThreadPoolExecutor(max_workers=2) as pool:
        for url,meta,repos in pool.map(one,urls):
            records.append({**meta,'repositories':repos})
            for repo in repos:
                entry=candidates.setdefault(repo,{'repo':repo,'discovered':[]});entry['discovered'].append(url)
            print('discovery',url,len(repos),flush=True)
    (OUT/'discovery.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    (OUT/'candidates.json').write_text(json.dumps(list(candidates.values()),ensure_ascii=False,indent=2),encoding='utf-8')
    return list(candidates.values())

def project(entry):
    repo=entry['repo'];readme='';meta={}
    for filename in ('README.md','readme.md','README.rst','README.adoc','README'):
        readme,meta=fetch(f'https://raw.githubusercontent.com/{repo}/HEAD/{filename}','readme')
        if readme:break
    if not readme:return {**entry,'readme':meta,'usable':False}
    normalized=clean(readme)
    # Preserve only short evidence extracts in the deliverable. Full fetched files remain in private research cache.
    stack=[]
    for label,pattern in [('Tauri',r'\btauri\b'),('Electron',r'\belectron\b'),('React',r'\breact\b'),('Vue',r'\bvue(?:\.js)?\b'),('Flutter',r'\bflutter\b'),('Kotlin',r'\bkotlin\b'),('Swift',r'\bswift\b'),('Java',r'\bjava\b'),('Python',r'\bpython\b'),('.NET',r'\.net|asp\.net'),('Rust',r'\brust\b'),('Go',r'\bgolang\b'),('Docker',r'\bdocker\b'),('SQLite',r'\bsqlite\b'),('PostgreSQL',r'\bpostgres(?:ql)?\b'),('OPDS',r'\bopds\b')]:
        match=re.search(pattern,readme,re.I)
        if match:stack.append({'name':label,'character_offset':match.start()})
    features=[]
    for label,pattern in [('offline',r'\boffline\b'),('sync',r'synchroni[sz]|\bsync\b'),('collections',r'collection|bookshel|categor|series'),('annotations',r'annotat|bookmark|highlight'),('tts',r'text.to.speech|\btts\b|read.aloud'),('translation',r'translat'),('search',r'\bsearch\b'),('EPUB',r'\bepub\b'),('PDF',r'\bpdf\b'),('manga',r'manga|comic'),('self-host',r'self.host'),('metadata',r'metadata'),('plugins',r'plugin|extension')]:
        m=re.search(pattern,readme,re.I)
        if m:features.append({'name':label,'character_offset':m.start()})
    exclude=any(x in repo.lower() for x in ['awesome-','/awesome','libreddit','mathesar','jspreadsheet','/libreoffice','/airflow','flaresolverr'])
    relevant=bool(re.search(r'book|manga|comic|epub|novel|read.it.later|read.?list|reading',normalized,re.I)) and not exclude
    paragraphs=[clean(p) for p in re.split(r'\n\s*\n',readme) if len(clean(p))>50 and not clean(p).startswith(('[!','![','<','|'))]
    description=next((p for p in paragraphs if re.search(r'book|reader|manga|comic|novel|reading|epub',p,re.I)),paragraphs[0] if paragraphs else normalized)
    return {**entry,'usable':relevant,'readme':meta,'description_excerpt':' '.join(description.split()[:20]),'stack_mentions':stack,'feature_mentions':features,'readme_characters':len(readme)}

def feedback(entry):
    repo=entry['repo'];text,meta=fetch(f'https://github.com/{repo}/issues','feedback')
    observations=[]
    # GitHub's accessible issue-title links remain a stable fallback to embedded application JSON.
    patterns=[r'<a\b[^>]*href="/'+re.escape(repo)+r'/issues/(\d+)"[^>]*>(.*?)</a>']
    for pattern in patterns:
        for number,title in re.findall(pattern,text,re.S):
            title=clean(title)
            if len(title)>8 and title not in [x['title'] for x in observations]:observations.append({'title':title[:220],'url':f'https://github.com/{repo}/issues/{number}','kind':'issue-title; not independently reproduced'})
    if not observations:
        for m in re.finditer(r'"title":"((?:\\.|[^"\\]){8,400})"',text):
            try:title=json.loads('"'+m.group(1)+'"')
            except Exception:continue
            section=text[max(0,m.start()-350):m.end()+350];n=re.search(r'"number":(\d+)',section)
            if n and title not in [x['title'] for x in observations]:observations.append({'title':title[:220],'url':f'https://github.com/{repo}/issues/{n.group(1)}','kind':'issue-title; not independently reproduced'})
    entry['feedback']={'source':meta,'observations':observations[:5],'availability':'issue titles observed' if observations else 'no usable feedback retrieved','archived_banner':bool(re.search(r'This repository has been archived by the owner',text))}
    time.sleep(.25)
    return entry

if __name__=='__main__':
    import sys
    phase=sys.argv[1] if len(sys.argv)>1 else 'all'
    candidates=discover() if phase in ('discover','all') else json.loads((OUT/'candidates.json').read_text(encoding='utf-8'))
    if phase=='discover':raise SystemExit()
    records=[]
    if phase in ('readmes','all'):
        with futures.ThreadPoolExecutor(max_workers=5) as pool:
            for entry in pool.map(project,candidates):
                records.append(entry)
                if len(records)%20==0:print('readmes',len(records),'usable',sum(bool(x.get('usable')) for x in records),flush=True)
        (OUT/'projects-evidence.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
    else:records=json.loads((OUT/'projects-evidence.json').read_text(encoding='utf-8'))
    if phase in ('feedback','all'):
        usable=json.loads((OUT/'shortlist.json').read_text(encoding='utf-8')) if (OUT/'shortlist.json').exists() else [x for x in records if x.get('usable')]
        output=[]
        with futures.ThreadPoolExecutor(max_workers=2) as pool:
            for entry in pool.map(feedback,usable):
                output.append(entry)
                if len(output)%10==0:
                    (OUT/'projects-feedback.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
                    print('feedback',len(output),'available',sum(bool(x['feedback']['observations']) for x in output),flush=True)
        (OUT/'projects-feedback.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
        print('DONE',len(output),'feedback',sum(bool(x['feedback']['observations']) for x in output),flush=True)
