import concurrent.futures as futures,csv,importlib.util,json,pathlib,re
root=pathlib.Path(__file__).resolve().parents[1];folder=root/'docs/gargantua/research'
spec=importlib.util.spec_from_file_location('collector',root/'scripts/research-library.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
entries=list(csv.DictReader((folder/'websites.tsv').open(encoding='utf-8'),delimiter='\t'))
def one(entry):
 text,meta=m.fetch(entry['url'],'platform-home-or-help');title=re.search(r'<title[^>]*>(.*?)</title>',text,re.S|re.I)
 entry['retrieval']=meta;entry['observed_title']=m.clean(title.group(1))[:120] if title else '';entry['scope']='обзор доступной страницы; focus — исследовательский вопрос, не подтверждение реализации'
 return entry
with futures.ThreadPoolExecutor(max_workers=4) as pool:output=list(pool.map(one,entries))
(folder/'websites-evidence.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
print('platforms',len(output),'HTTP200',sum(x['retrieval'].get('status')==200 for x in output));print('\n'.join(x['name']+': '+str(x['retrieval'].get('status')) for x in output))
