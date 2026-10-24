"""Strictly bounded conversion to inert text blocks and re-encoded raster assets.
Never extracts archives onto disk or returns source HTML to the browser.
"""
import base64
import io
import json
import posixpath
import re
import stat
import warnings
import zipfile
from html.parser import HTMLParser
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit
from xml.etree.ElementTree import TreeBuilder, Element
from defusedxml import ElementTree as ET
from PIL import Image
from structured_text import StructuredDocument, inert_html

MAX_INPUT = 20 * 1024 * 1024
MAX_EXPANDED = 40 * 1024 * 1024
MAX_TEXT = 6 * 1024 * 1024
MAX_FILES = 1000
MAX_IMAGES = 100
MAX_XML_DEPTH = 64
MAX_XML_NODES = 100_000
DC = '{http://purl.org/dc/elements/1.1/}'
Image.MAX_IMAGE_PIXELS = 12_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

def tag(el):
    return str(el.tag).split('}')[-1].lower()

def text(el):
    return re.sub(r'\s+', ' ', ''.join(el.itertext())).strip()

def source_metadata(format, provenance, title, authors, languages, identifiers):
    # These values come only from the input, never filename/API expectations.
    fields = [(title, 300), *[(x, 200) for x in authors],
              *[(x, 30) for x in languages], *[(x, 500) for x in identifiers]]
    if len(authors)>16 or len(languages)>16 or len(identifiers)>32 or any(
            not isinstance(value,str) or len(value)>limit or any(ord(c)<32 or ord(c)==127 for c in value)
            for value,limit in fields):
        raise ValueError('Метаданные источника превышают лимиты')
    return {'schemaVersion':1,'format':format,'provenance':provenance,'title':title,
            'authors':authors,'languages':languages,'identifiers':identifiers}

def txt_source_metadata(decoded):
    header = decoded[:65536].replace('\r\n','\n').replace('\r','\n')
    marker = re.search(r'^\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK .+?\s*\*{3}\s*$',header,re.I|re.M)
    if not marker or not re.search(r'(?:The Project Gutenberg eBook|Project Gutenberg[\'’]s eBook)',header[:2048],re.I):
        return None
    header=header[:marker.start()]
    def values(label):
        return [re.sub(r'\s+',' ',x).strip() for x in re.findall(r'^'+label+r':\s*([^\n]+)',header,re.I|re.M)]
    titles=values('Title')
    identifiers=['https://www.gutenberg.org/ebooks/'+x for x in dict.fromkeys(re.findall(r'\[eBook\s*#\s*([1-9][0-9]{0,9})\]',header,re.I))]
    return source_metadata('txt','gutenberg-txt-header',titles[0] if len(titles)==1 else '',values('Authors?'),values('Language'),identifiers)

def xml(data):
    if len(data) > MAX_TEXT:
        raise ValueError('XML превышает лимит')
    class BoundedTree:
        def __init__(self):
            self.builder = TreeBuilder()
            self.depth = 0
            self.nodes = 0

        def start(self, name, attrs):
            self.depth += 1
            self.nodes += 1
            # Reject while parsing, before constructing an unbounded tree or
            # handing it to the recursive inert-block converter.
            if self.depth > MAX_XML_DEPTH:
                raise ValueError('XML превышает лимит глубины')
            if self.nodes > MAX_XML_NODES:
                raise ValueError('XML превышает лимит числа узлов')
            return self.builder.start(name, attrs)

        def end(self, name):
            result = self.builder.end(name)
            self.depth -= 1
            return result

        def data(self, value):
            self.builder.data(value)

        def close(self):
            return self.builder.close()

    parser = ET.XMLParser(target=BoundedTree(), forbid_dtd=True, forbid_entities=True, forbid_external=True)
    parser.feed(data)
    return parser.close()

def spine_xhtml(data):
    """Accept only the inert HTML5 declaration in an EPUB reading document.

    EPUB 3.3 permits an identifier-free doctype. DefusedXML still forbids every
    DTD after removal of this one literal declaration in the XML prolog. The
    generic XML helper, OPF/container documents and FB2 remain unchanged.
    """
    if len(data) > MAX_TEXT:
        raise ValueError('XML превышает лимит')
    offset = 3 if data.startswith(b'\xef\xbb\xbf') else 0
    if data.startswith(b'<?xml', offset) and offset + 5 < len(data) and data[offset + 5] in b' \t\r\n':
        end = data.find(b'?>', offset + 5)
        if end < 0:
            return xml(data)
        offset = end + 2
    whitespace = re.compile(rb'[ \t\r\n]*')
    while True:
        offset = whitespace.match(data, offset).end()
        if not data.startswith(b'<!--', offset):
            break
        end = data.find(b'-->', offset + 4)
        if end < 0:
            return xml(data)
        offset = end + 3
    literal = b'<!DOCTYPE html>'
    if not data.startswith(literal, offset):
        return xml(data)
    root = xml(data[:offset] + data[offset + len(literal):])
    if root.tag not in ('html', '{http://www.w3.org/1999/xhtml}html'):
        raise ValueError('HTML5 doctype не соответствует корню XHTML')
    return root

def flatten_epub_raster_covers(body, builder):
    """Map one observed SVG raster wrapper to an ordinary local image.

    No SVG renderer or SVG resource is accepted. The ordinary EPUB resolver and
    Pillow still open, bound and re-encode the referenced raster later.
    """
    svg = '{http://www.w3.org/2000/svg}'
    href = '{http://www.w3.org/1999/xlink}href'
    for parent in body.iter():
        for index, node in enumerate(list(parent)):
            if tag(node) != 'svg':
                continue
            if node.tag != svg+'svg' or set(node.attrib) != {'height','width','version','viewBox','preserveAspectRatio'}:
                raise ValueError('Неподдерживаемая SVG-обёртка обложки EPUB')
            if node.attrib['height'] != '100%' or node.attrib['width'] != '100%' or node.attrib['version'] != '1.1' or node.attrib['preserveAspectRatio'] != 'xMidYMid meet':
                raise ValueError('Неподдерживаемая геометрия обложки EPUB')
            dimensions = re.fullmatch(r'0 0 ([1-9][0-9]{0,4}) ([1-9][0-9]{0,4})', node.attrib['viewBox'])
            if not dimensions or (node.text or '').strip() or len(node) != 1:
                raise ValueError('Неоднозначная SVG-обёртка обложки EPUB')
            width, height = map(int, dimensions.groups())
            if width > 20000 or height > 20000 or width*height > 12_000_000:
                raise ValueError('Геометрия обложки EPUB превышает лимит')
            image_node = node[0]
            if image_node.tag != svg+'image' or set(image_node.attrib) != {'width','height',href} or len(image_node) or (image_node.text or '').strip() or (image_node.tail or '').strip():
                raise ValueError('Неподдерживаемое содержимое SVG-обёртки EPUB')
            if image_node.attrib['width'] != str(width) or image_node.attrib['height'] != str(height):
                raise ValueError('Размеры растровой обложки EPUB не совпадают')
            replacement = Element('img', {'src':image_node.attrib[href], 'alt':''})
            replacement.tail = node.tail
            parent.remove(node)
            parent.insert(index, replacement)
            builder.structured.warn('EPUB_SVG_RASTER_WRAPPER_FLATTENED')

def safe_path(name):
    if not name or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name) or name.startswith('/'):
        raise ValueError('Небезопасный путь в архиве')
    path = PurePosixPath(name)
    if str(path) == '.' or '..' in path.parts or any(':' in p for p in path.parts):
        raise ValueError('Выход за пределы архива')
    return str(path)

def image(data):
    if len(data) > 8 * 1024 * 1024:
        raise ValueError('Изображение превышает лимит')
    with Image.open(io.BytesIO(data)) as im:
        if im.format not in ('PNG','JPEG','WEBP','GIF'):
            raise ValueError('Формат изображения не поддерживается')
        if im.width * im.height > 12_000_000:
            raise ValueError('Изображение слишком большое')
        im.load()
        im = im.convert('RGB')
        im.thumbnail((1800, 2400))
        out = io.BytesIO()
        im.save(out, format='PNG', optimize=False)
        return base64.b64encode(out.getvalue()).decode('ascii')

class Builder:
    def __init__(self):
        self.structured = StructuredDocument()
        self.assets = {}
        self.seen = {}
        self.budget = 0
        self.blocks = 0

    def asset(self, key, data):
        if key in self.seen:
            return self.seen[key]
        if len(self.assets) >= MAX_IMAGES:
            raise ValueError('Слишком много иллюстраций')
        result = image(data)
        self.budget += len(result)
        if self.budget > 20 * 1024 * 1024:
            raise ValueError('Иллюстрации превышают общий лимит')
        name = f'image-{len(self.assets)}.png'
        self.assets[name] = result
        self.seen[key] = name
        return name

    def blocks_from(self, root, resolve_image):
        blocks=[]
        def add(t, value, **extra):
            if value:
                if len(value)>100000:raise ValueError('Слишком длинный текстовый блок')
                self.blocks += 1
                if self.blocks > 30000:
                    raise ValueError('Слишком много блоков')
                blocks.append({'type':t, 'text':value[:100000], **extra})
        def walk(el):
            name=tag(el)
            if name in ('script','style','iframe','object','embed','form','svg','math'):
                raise ValueError('Активное или неподдерживаемое содержимое в книге')
            for key in el.attrib:
                if key.lower().startswith('on'):
                    raise ValueError('Обработчик событий в книге')
            if name in ('img','image'):
                ref=el.attrib.get('src') or el.attrib.get('{http://www.w3.org/1999/xlink}href') or el.attrib.get('href')
                if ref:
                    asset=resolve_image(ref)
                    blocks.append({'type':'image','asset':asset,'text':el.attrib.get('alt','')[:500]})
                return
            children=list(el)
            contains_images=any(tag(x) in ('img','image') for x in el.iter())
            if name in ('p','v','subtitle','h1','h2','h3','h4','li','figcaption','text-author') and not contains_images:
                # Validate all descendants before flattening inline markup.
                for child in el.iter():
                    if tag(child) in ('script','style','iframe','object','embed','form','svg','math') or any(k.lower().startswith('on') for k in child.attrib):
                        raise ValueError('Активное содержимое в книге')
                add('heading' if name in ('h1','h2','h3','h4','subtitle') else 'text',text(el))
                return
            if el.text and el.text.strip():
                add('text',el.text.strip())
            for child in children:
                walk(child)
                if child.tail and child.tail.strip():
                    add('text',child.tail.strip())
        walk(root)
        return blocks

def parse_epub(data, builder):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        files={}
        directories=set()
        total=0
        for info in z.infolist():
            if len(files)+len(directories)>=MAX_FILES:
                raise ValueError('Архив превышает ограничение числа записей')
            name=safe_path(info.filename)
            if name in files or name in directories: raise ValueError('Дублирующийся путь в EPUB')
            if info.flag_bits & 1 or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError('Зашифрованный файл или ссылка в архиве')
            if info.is_dir():
                directories.add(name)
                continue
            total+=info.file_size
            if len(files)>=MAX_FILES or total>MAX_EXPANDED or info.file_size>MAX_INPUT or info.file_size/max(1,info.compress_size)>200:
                raise ValueError('Архив превышает ограничения распаковки')
            if PurePosixPath(name).suffix.lower() in ('.exe','.dll','.com','.bat','.cmd','.ps1','.sh','.js','.mjs','.jar','.scr','.vbs','.msi','.html.exe'):
                raise ValueError('Исполняемое вложение в EPUB')
            files[name]=info
        for name in files:
            if any(str(parent) in files for parent in PurePosixPath(name).parents):
                raise ValueError('Файл EPUB одновременно используется как каталог')
        def read(name):
            if name not in files: raise ValueError('Файл из оглавления отсутствует')
            return z.read(files[name])
        if read('mimetype').strip()!=b'application/epub+zip': raise ValueError('Это не EPUB')
        if 'META-INF/encryption.xml' in files: raise ValueError('Зашифрованный EPUB не поддерживается')
        container=xml(read('META-INF/container.xml'))
        rootgroups=[group for group in container if tag(group)=='rootfiles']
        rootfiles=[e for group in rootgroups for e in group if tag(e)=='rootfile']
        if tag(container)!='container' or len(rootgroups)!=1 or len(rootfiles)!=1:
            raise ValueError('EPUB должен содержать один однозначный пакет')
        rootfile=safe_path(rootfiles[0].attrib.get('full-path',''))
        if rootfiles[0].attrib.get('media-type','application/oebps-package+xml')!='application/oebps-package+xml':
            raise ValueError('Неподдерживаемый тип пакета EPUB')
        package=xml(read(rootfile))
        if tag(package)!='package': raise ValueError('Некорректный пакет EPUB')
        metadata=[e for e in package if tag(e)=='metadata']
        if len(metadata)>1:raise ValueError('Неоднозначные метаданные EPUB')
        def dc_values(name):
            # Only actual direct Dublin Core fields inside the OPF metadata
            # element count. Body/manifest/nested lookalikes are not evidence.
            return [text(e) for e in metadata[0] if e.tag==DC+name] if metadata else []
        titles=dc_values('title')
        builder.source_metadata=source_metadata('epub','opf',titles[0] if len(titles)==1 else '',dc_values('creator'),dc_values('language'),dc_values('identifier'))
        base=posixpath.dirname(rootfile)
        manifest={}
        def relative(ref, parent):
            # urlsplit removes leading ASCII spaces/control characters. Reject
            # them rather than silently choosing a different archive resource.
            if not ref or ref.startswith(' ') or any(ord(c)<32 or ord(c)==127 for c in ref):
                raise ValueError('Пустая или небезопасная ссылка EPUB')
            u=urlsplit(ref)
            if u.scheme or u.netloc or ref.startswith('/') or '\\' in ref:
                raise ValueError('Внешнее изображение или ресурс: офлайн-импорт требует встроенные файлы')
            if u.query or u.fragment or '?' in ref or '#' in ref:
                raise ValueError('Неоднозначная ссылка EPUB с query или fragment')
            if not u.path: raise ValueError('Пустой путь ресурса EPUB')
            resolved=posixpath.normpath(posixpath.join(parent,unquote(u.path,errors='strict')))
            return safe_path(resolved)
        manifests=[e for e in package if tag(e)=='manifest']
        spines=[e for e in package if tag(e)=='spine']
        if len(manifests)!=1 or len(spines)!=1:
            raise ValueError('EPUB должен содержать один manifest и spine')
        manifest_items=list(manifests[0])
        spine_items=list(spines[0])
        # Do not let an item/itemref hidden in metadata or a nested section
        # silently change the reading order or shadow a real manifest entry.
        expected_items={id(e) for e in manifest_items if tag(e)=='item'}
        expected_refs={id(e) for e in spine_items if tag(e)=='itemref'}
        if any((tag(e)=='item' and id(e) not in expected_items) or
               (tag(e)=='itemref' and id(e) not in expected_refs) or
               (tag(e)=='manifest' and e is not manifests[0]) or
               (tag(e)=='spine' and e is not spines[0]) for e in package.iter()):
            raise ValueError('Неоднозначная структура manifest или spine EPUB')
        ids=set()
        for e in package.iter():
            value=e.attrib.get('id')
            if value is not None:
                if not value or any(c.isspace() for c in value) or value in ids:
                    raise ValueError('Пустой или дублирующийся ID в EPUB')
                ids.add(value)
        manifest_paths=set()
        for e in manifest_items:
            if tag(e)!='item': raise ValueError('Неподдерживаемый элемент manifest EPUB')
            key=e.attrib.get('id')
            if not key: raise ValueError('В manifest EPUB отсутствует ID')
            if 'remote-resources' in e.attrib.get('properties','').split() or 'scripted' in e.attrib.get('properties','').split():
                raise ValueError('Скриптовый или сетевой EPUB не поддерживается')
            name=relative(e.attrib.get('href',''),base)
            if name not in files: raise ValueError('Файл из manifest EPUB отсутствует')
            if name in manifest_paths or name in ('mimetype','META-INF/container.xml',rootfile):
                raise ValueError('Неоднозначный путь в manifest EPUB')
            manifest_paths.add(name)
            manifest[key]=(name,e.attrib.get('media-type'))
        chapters=[]
        seen_refs=set()
        for e in spine_items:
            if tag(e)!='itemref': raise ValueError('Неподдерживаемый элемент spine EPUB')
            key=e.attrib.get('idref')
            if key not in manifest or key in seen_refs: raise ValueError('Отсутствующая или повторная ссылка в spine EPUB')
            seen_refs.add(key)
            name,media_type=manifest[key]
            if media_type not in (None,'application/xhtml+xml'):
                raise ValueError('Неподдерживаемый тип главы в spine EPUB')
            root=spine_xhtml(read(name))
            body=next((x for x in root.iter() if tag(x)=='body'),root)
            flatten_epub_raster_covers(body,builder)
            blocks=builder.blocks_from(body,lambda ref: builder.asset(relative(ref,posixpath.dirname(name)),read(relative(ref,posixpath.dirname(name)))))
            title=next((text(x) for x in body.iter() if tag(x) in ('h1','h2','h3') and text(x)),f'Глава {len(chapters)+1}')
            if blocks:
                chapters.append({'title':title[:300],'blocks':blocks})
                builder.structured.chapter(body,name,title,lambda ref: builder.asset(relative(ref,posixpath.dirname(name)),read(relative(ref,posixpath.dirname(name)))))
        meta=lambda n: next((text(x) for x in metadata[0] if tag(x)==n),'') if metadata else ''
        return meta('title'),meta('creator'),meta('language'),chapters

def parse_fb2(data,builder):
    root=xml(data)
    if tag(root)!='fictionbook': raise ValueError('Это не FB2')
    identifiers=[el.attrib['id'] for el in root.iter() if 'id' in el.attrib]
    if any(not value for value in identifiers) or len(identifiers)!=len(set(identifiers)):raise ValueError('Дублирующийся ID FB2')
    binaries={x.attrib.get('id'):x.text or '' for x in root.iter() if tag(x)=='binary'}
    def resolve(ref):
        if not ref.startswith('#') or ref[1:] not in binaries: raise ValueError('Изображение FB2 отсутствует или является внешним')
        return builder.asset(ref,base64.b64decode(re.sub(r'\s+','',binaries[ref[1:]]),validate=True))
    chapters=[]
    for body_index,body in enumerate(root):
        if tag(body)!='body': continue
        sections=[e for e in body if tag(e)=='section'] or [body]
        for section_index,section in enumerate(sections):
            title=next((text(x) for x in section if tag(x)=='title'),f'Глава {len(chapters)+1}')
            blocks=builder.blocks_from(section,resolve)
            if blocks and blocks[0].get('text')==title:blocks.pop(0)
            if blocks:
                chapters.append({'title':title[:300],'blocks':blocks})
                origin='fb2/'+str(body_index)+'/'+section.attrib.get('id',str(section_index))
                builder.structured.chapter(section,origin,title,resolve,notes=body.attrib.get('name','').lower() in ('notes','comments','footnotes'),reference_origin='fb2/document')
    title=next((text(x) for x in root.iter() if tag(x)=='book-title'),'')
    author=next((' '.join(text(part) for part in x if tag(part) in ('first-name','middle-name','last-name','nickname')) or text(x) for x in root.iter() if tag(x)=='author'),'')
    lang=next((text(x) for x in root.iter() if tag(x)=='lang'),'')
    return title,author,lang,chapters

def parse_ranobe(data,builder):
    source=json.loads(data)
    class ChapterParser(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.blocks=[]
            self.pending=[]
            self.heading=False
        def flush(self):
            value=re.sub(r'\s+',' ',''.join(self.pending)).strip()
            if value:
                if len(value)>100000 or len(self.blocks)>30000:raise ValueError('Превышены лимиты главы')
                self.blocks.append({'type':'heading' if self.heading else 'text','text':value})
            self.pending=[]
        def handle_starttag(self,name,attrs):
            a=dict(attrs)
            if name in ('script','style','iframe','object','embed','form','svg','math') or any(k.lower().startswith('on') for k in a):
                raise ValueError('Активное содержимое в главе')
            if name in ('p','div','br','h1','h2','h3','li','blockquote'):self.flush()
            if name in ('h1','h2','h3'):self.heading=True
            if name=='img':
                self.flush()
                ref=a.get('src','')
                if ref not in source.get('images',{}):raise ValueError('Иллюстрация отсутствует в проверенном пакете')
                asset=builder.asset(ref,base64.b64decode(source['images'][ref],validate=True))
                self.blocks.append({'type':'image','asset':asset,'text':a.get('alt','')[:500]})
        def handle_endtag(self,name):
            if name in ('p','div','h1','h2','h3','li','blockquote'):self.flush()
            if name in ('h1','h2','h3'):self.heading=False
        def handle_data(self,value):self.pending.append(value)
    chapters=[]
    for item in source['chapters']:
        parser=ChapterParser();parser.feed(item['html']);parser.close();parser.flush()
        if not parser.blocks:raise ValueError('Нет текста главы')
        chapters.append({'title':str(item['title'])[:300],'blocks':parser.blocks})
        builder.structured.chapter(inert_html(item['html']),f'ranobe/{len(chapters)-1}',str(item['title']),lambda ref:builder.asset(ref,base64.b64decode(source['images'][ref],validate=True)))
    return str(source['title']),str(source.get('author','')),str(source.get('language','ru')),chapters

def parse_book(data,extension,filename='Книга'):
    if not data or len(data)>MAX_INPUT: raise ValueError('Пустой файл или превышен лимит 20 МБ')
    if data[:2] in (b'MZ',b'\x7fE') or data[:4]==b'%PDF': raise ValueError('Содержимое не соответствует формату')
    builder=Builder()
    if extension=='ranobe':values=parse_ranobe(data,builder)
    elif extension=='epub': values=parse_epub(data,builder)
    elif extension=='fb2': values=parse_fb2(data,builder)
    elif extension=='txt':
        if len(data)>MAX_TEXT: raise ValueError('TXT превышает лимит 6 МБ')
        try: decoded=data.decode('utf-8-sig')
        except UnicodeDecodeError: decoded=data.decode('cp1251')
        if any(ord(c)<32 and c not in '\n\r\t' for c in decoded): raise ValueError('Двоичные данные вместо текста')
        if re.search(r'<\s*(!doctype|html|script|iframe|svg|\?xml)',decoded,re.I): raise ValueError('Разметка вместо обычного TXT')
        builder.source_metadata=txt_source_metadata(decoded)
        parts=re.split(r'\n\s*\n',decoded.replace('\r\n','\n'))
        blocks=[{'type':'text','text':p.strip()} for p in parts if p.strip()]
        if any(len(x['text'])>100000 for x in blocks) or len(blocks)>30000: raise ValueError('Текст превышает ограничения блоков')
        chapters=[{'title':'Текст книги','blocks':blocks[i:i+250]} for i in range(0,len(blocks),250)]
        for index,chapter in enumerate(chapters):builder.structured.plain_chapter(chapter,index)
        values=(filename.rsplit('.',1)[0],'','',chapters)
    else: raise ValueError('Формат не поддерживается')
    title,author,language,chapters=values
    if not chapters or len(chapters)>1000: raise ValueError('Нет читаемого текста или слишком много глав')
    structure=builder.structured.finish()
    if len(structure['chapters'])!=len(chapters):raise ValueError('Неполная структурированная книга')
    result={'title':(title or filename)[:300],'author':author[:300],'language':language[:30],'chapters':chapters,'assets':builder.assets,'structure':structure}
    if getattr(builder,'source_metadata',None) is not None:result['sourceMetadata']=builder.source_metadata
    if len(json.dumps(result,ensure_ascii=False).encode())>24*1024*1024: raise ValueError('Результат слишком большой')
    return result
