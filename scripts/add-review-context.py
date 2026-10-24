import json,pathlib,re
root=pathlib.Path(__file__).resolve().parents[1];doc=root/'docs/gargantua'
full=json.loads((root/'.local/research-gargantua/full-projects-reviewed.json').read_text(encoding='utf-8'));source={x['repo'].lower():x for x in full}
registry=json.loads((doc/'research/registry.json').read_text(encoding='utf-8'));text=(doc/'PROJECTS.md').read_text(encoding='utf-8')
for item in registry:
 title=source[item['repository'].lower()]['selected_feedback']['title']
 excerpt=' '.join(title.split()[:8]);excerpt=excerpt[:32] if re.search(r'[\u3400-\u9fff]',excerpt) else excerpt[:96]
 item['feedback_excerpt']=excerpt;item['feedback_excerpt_scope']='Короткий фрагмент заголовка для идентификации темы; не подтверждённый дефект.'
 anchor='<a id="'+item['id'].lower()+'"></a>';start=text.index(anchor);end=text.find('<a id="',start+len(anchor));end=len(text) if end<0 else end
 block=text[start:end];safe=re.sub(r'[\[\]<>`*]','',excerpt)
 if '**Контекст обращения:**' not in block:block=block.replace('**Обратная связь:**','**Контекст обращения:** «'+safe+'…» (фрагмент заголовка; подробности по ссылке выше).\n\n**Обратная связь:**',1)
 text=text[:start]+block+text[end:]
(doc/'research/registry.json').write_text(json.dumps(registry,ensure_ascii=False,indent=2),encoding='utf-8');(doc/'PROJECTS.md').write_text(text,encoding='utf-8')
print('Added bounded review context:',len(registry))
