import json,pathlib,re
root=pathlib.Path(__file__).resolve().parents[1]/'docs/gargantua/research'
records=json.loads((root/'projects-evidence.json').read_text(encoding='utf-8'))
all_usable=[x for x in records if x.get('usable')]
selected=[];hashes=set();names=set()
exclude=r'ebooks$|/books$|book-source-creator-skill|sumatrapdf-plus|miuread-koreader|qiaomu-book-reader-legacy|/okreader|/wxReader|/jidoujisho|/dillo-plus|/zipsell|homebranch-api|mikespub-org/seblucas-cops|b43r/calibre-web|GBochicchio/calibre-web|TanagerTrough/koodo-reader|hkoivuneva/calibre-web|/IslamicLibraryAndroid|comprehensive-bangla-tts|/informatician|/Quill$|/pi-tree|/Vera$|/Rose$|Course|CMPE273|/Book_Reader|/book-reader$|/booksy|/exhentai|/copymanga|/kobi$|/jm-|/JMComic|/EMHentai|/venera-jm|/venera-miuix|/ScollZoomListView|/manga-api|/manga-vision-ui|/tachiyomi$|/novel_reader|/fqapp|/MenuTube|/libgen-opds|/flibusta|/go-audio|/podgenai|/joytan|/audiobook-downloader|/ting-reader'
for i,entry in enumerate(all_usable):
    if not (i<315 or 345<=i<392):continue
    if re.search(exclude,entry['repo'],re.I):continue
    if entry['repo'].lower() in names or entry['readme']['sha256'] in hashes:continue
    names.add(entry['repo'].lower());hashes.add(entry['readme']['sha256'])
    # Public appendix is limited to 20 words of exact README quotation per source.
    entry['description_excerpt']=' '.join(entry.get('description_excerpt','').split()[:20])
    for group in ('stack_mentions','feature_mentions'):
        for mention in entry[group]:mention.pop('context',None)
    selected.append(entry)
(root/'shortlist.json').write_text(json.dumps(selected,ensure_ascii=False,indent=2),encoding='utf-8')
print('shortlist',len(selected));print('\n'.join(x['repo'] for x in selected))
