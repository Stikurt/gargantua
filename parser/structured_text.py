"""Bounded inert structure. No HTML, executable attributes or external links out."""
import hashlib
import posixpath
import re
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit
from xml.etree.ElementTree import Element


def name(el):
    return str(el.tag).split('}')[-1].lower()


def stable(prefix, value):
    return prefix + hashlib.sha256(value.encode('utf-8')).hexdigest()[:28]


class StructuredDocument:
    def __init__(self):
        self.chapters = []
        self.anchors = {}
        self.pending = []
        self.warnings = set()
        self.block_count = 0

    def warn(self, code):
        self.warnings.add(code)

    def chapter(self, root, origin, title, resolve_image, *, notes=False, reference_origin=None):
        chapter_id = stable('c-', origin)
        document = reference_origin or origin
        blocks = []
        ids = set()
        for el in root.iter():
            ident = el.attrib.get('id')
            if ident is not None:
                if not ident or ident in ids or len(ident) > 300:
                    raise ValueError('Пустой или дублирующийся ID в главе')
                ids.add(ident)

        def reference(ref):
            if not isinstance(ref, str) or len(ref) > 2000 or any(ord(c) < 32 for c in ref) or '\\' in ref:
                self.warn('LINK_REMOVED'); return None
            parsed = urlsplit(ref)
            if parsed.scheme or parsed.netloc or parsed.query or not parsed.fragment:
                self.warn('EXTERNAL_OR_UNRESOLVED_LINK'); return None
            fragment = unquote(parsed.fragment, errors='strict')
            path = posixpath.normpath(posixpath.join(posixpath.dirname(document), unquote(parsed.path, errors='strict'))) if parsed.path else document
            if path.startswith('/') or '..' in path.split('/') or ':' in path:
                raise ValueError('Небезопасная внутренняя ссылка')
            return (path, fragment)

        def inline(el):
            characters = []
            ranges = []
            latest = {}
            units = 0
            trailing_space = False

            def append(value, styles):
                nonlocal units, trailing_space
                for char in value or '':
                    if char.isspace():
                        if not characters or trailing_space:
                            continue
                        char = ' '
                    start = units
                    characters.append(char); units += 2 if ord(char) > 0xffff else 1
                    trailing_space = char == ' '
                    for style in styles:
                        index = latest.get(style)
                        if index is not None and ranges[index][3] == start:
                            ranges[index][3] = units
                        else:
                            ranges.append([*style, start, units])
                            latest[style] = len(ranges)-1
                    if units > 100000 or len(ranges) > 2000:
                        raise ValueError('Превышен лимит inline-текста')

            def walk(node, styles=()):
                tag = name(node)
                if tag == 'br':
                    append(' ',styles);return
                mark = {'em':'emphasis','i':'emphasis','emphasis':'emphasis','strong':'strong','b':'strong','code':'code','sup':'superscript','sub':'subscript'}.get(tag)
                if mark:
                    styles = (*styles, (mark, None))
                if tag == 'a':
                    target = reference(node.attrib.get('href') or node.attrib.get('{http://www.w3.org/1999/xlink}href') or '')
                    if target:
                        styles = (*styles, ('link', target))
                if tag == 'ruby':
                    self.warn('RUBY_READING_FLATTENED')
                append(node.text, styles)
                for child in node:
                    walk(child, styles); append(child.tail, styles)
            walk(el)
            value = ''.join(characters).rstrip()
            length = len(value.encode('utf-16-le')) // 2
            spans = []
            for kind, target, start, end in ranges:
                end = min(end, length)
                if end > start:
                    span = {'kind':kind, 'start':start, 'end':end}
                    if target:
                        span['_target'] = target
                    spans.append(span)
            return value, spans

        def emit(el, kind, ancestors=(), **extra):
            value, spans = inline(el)
            if not value and kind != 'image':
                return
            self.block_count += 1
            if self.block_count > 30000:
                raise ValueError('Слишком много структурированных блоков')
            own = el.attrib.get('id')
            block_id = stable('b-', origin + '#' + (own if own else 'position:' + str(len(blocks))))
            block = {'id':block_id, 'type':kind, 'text':value, **extra}
            if spans:
                block['spans'] = spans
            direction = el.attrib.get('dir')
            if direction in ('ltr','rtl','auto'):
                block['direction'] = direction
            blocks.append(block)
            for ident in [*ancestors, *(node.attrib.get('id') for node in el.iter())]:
                if ident:
                    self.anchors.setdefault((document, ident), block_id)
            for span in spans:
                if '_target' in span:
                    self.pending.append((block, span))

        def walk(el, ancestors=()):
            tag = name(el)
            if tag in ('script','style','iframe','object','embed','form','svg','math') or any(key.split('}')[-1].lower().startswith('on') for key in el.attrib):
                raise ValueError('Активное или неподдерживаемое содержимое')
            ancestors = (*ancestors, el.attrib['id']) if el.attrib.get('id') else ancestors
            if tag in ('img','image'):
                ref = el.attrib.get('src') or el.attrib.get('{http://www.w3.org/1999/xlink}href') or el.attrib.get('href')
                if ref:
                    emit(el,'image',ancestors,resource=resolve_image(ref))
                    blocks[-1]['text'] = el.attrib.get('alt','')[:500]
                return
            if tag == 'table':
                rows = []
                for row in el.iter():
                    if name(row) != 'tr': continue
                    cells = []
                    for cell in row:
                        if name(cell) not in ('td','th'): continue
                        if cell.attrib.get('colspan','1') != '1' or cell.attrib.get('rowspan','1') != '1': self.warn('TABLE_SPAN_FLATTENED')
                        value, _ = inline(cell)
                        if len(value)>10000: raise ValueError('Слишком длинная ячейка')
                        cells.append(value)
                    if len(cells)>100 or len(rows)>=1000: raise ValueError('Таблица превышает лимит')
                    if cells: rows.append(cells)
                emit(el,'table',ancestors,rows=rows)
                if blocks and blocks[-1]['type']=='table':
                    table=blocks[-1];table['text']='\n'.join('\t'.join(row) for row in rows)
                    if table.pop('spans',None):self.warn('TABLE_INLINE_MARKS_FLATTENED')
                    self.pending=[pair for pair in self.pending if pair[0] is not table]
                return
            block_type = {'h1':'heading','h2':'heading','h3':'heading','h4':'heading','h5':'heading','h6':'heading','subtitle':'heading','p':'paragraph','v':'verse','li':'list','blockquote':'quote','pre':'paragraph','figcaption':'paragraph','text-author':'paragraph'}.get(tag)
            has_nested = any(name(child) in ('p','blockquote','table','li') for child in el.iter() if child is not el)
            has_images = any(name(child) in ('img','image') for child in el.iter())
            if block_type and not has_nested and not has_images:
                kind = 'footnote' if notes else block_type
                emit(el,kind,ancestors,**({'level':int(tag[1])} if block_type=='heading' and tag.startswith('h') else {}))
                return
            if el.text and el.text.strip():
                stub=Element('p'); stub.text=el.text;emit(stub,'footnote' if notes else 'paragraph',ancestors)
            for child in el:
                walk(child,ancestors)
                if child.tail and child.tail.strip():
                    stub=Element('p');stub.text=child.tail;emit(stub,'footnote' if notes else 'paragraph',ancestors)
        # Validate descendants even when a table/paragraph is emitted in one go.
        for el in root.iter():
            if name(el) in ('script','style','iframe','object','embed','form','svg','math') or any(key.split('}')[-1].lower().startswith('on') for key in el.attrib):
                raise ValueError('Активное содержимое в структуре')
        walk(root)
        if blocks:
            self.chapters.append({'id':chapter_id,'revision':1,'title':title[:300],'blocks':blocks})

    def plain_chapter(self, chapter, index):
        cid = f'c-txt-{index}'
        self.chapters.append({'id':cid,'revision':1,'title':chapter['title'],'blocks':[{'id':f'{cid}-b-{i}','type':'paragraph','text':block['text']} for i,block in enumerate(chapter['blocks'])]})

    def finish(self):
        for block, span in self.pending:
            target = self.anchors.get(span.pop('_target'))
            if target:
                span['target'] = target
            else:
                block['spans'].remove(span);self.warn('UNRESOLVED_INTERNAL_LINK')
        return {'schemaVersion':2,'chapters':self.chapters,'warnings':sorted(self.warnings)}


def inert_html(value):
    class TreeParser(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True);self.root=Element('div');self.stack=[self.root];self.nodes=0
        def handle_starttag(self, tag, attrs):
            if len(self.stack)>=64 or self.nodes>=100000:raise ValueError('HTML превышает лимит структуры')
            self.nodes+=1;node=Element(tag,dict(attrs));self.stack[-1].append(node)
            if tag not in ('br','img','hr','meta','link','input'):self.stack.append(node)
        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag,attrs)
            if self.stack[-1].tag==tag:self.stack.pop()
        def handle_endtag(self, tag):
            for i in range(len(self.stack)-1,0,-1):
                if self.stack[i].tag==tag:self.stack=self.stack[:i];break
        def handle_data(self, value):
            current=self.stack[-1]
            if len(current):current[-1].tail=(current[-1].tail or '')+value
            else:current.text=(current.text or '')+value
        def handle_decl(self, _):raise ValueError('HTML declaration не поддерживается')
    if len(value.encode('utf-8'))>6*1024*1024:raise ValueError('HTML превышает лимит')
    parser=TreeParser();parser.feed(value);parser.close();return parser.root
