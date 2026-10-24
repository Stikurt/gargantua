import io
import unittest
import zipfile
import json
import base64
from unittest.mock import patch
from xml.etree.ElementTree import ParseError
from defusedxml.common import DTDForbidden
from PIL import Image, UnidentifiedImageError
import safe_parser
from safe_parser import parse_book, safe_path, xml, MAX_XML_DEPTH, MAX_XML_NODES

def epub(body='<p>Текст книги</p>', extra=None, *, manifest=None, spine=None, package=None, container=None, compression=zipfile.ZIP_DEFLATED, document=None):
    target=io.BytesIO()
    with zipfile.ZipFile(target,'w',compression) as z:
        z.writestr('mimetype','application/epub+zip')
        z.writestr('META-INF/container.xml',container if container is not None else '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
        manifest='<item id="c1" href="chapter.xhtml"/>' if manifest is None else manifest
        spine='<itemref idref="c1"/>' if spine is None else spine
        z.writestr('book.opf',package if package is not None else f'<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Проверка</dc:title><dc:creator>Автор</dc:creator><dc:language>ru</dc:language></metadata><manifest>{manifest}</manifest><spine>{spine}</spine></package>')
        z.writestr('chapter.xhtml',document if document is not None else f'<html><body><h1>Глава</h1>{body}</body></html>')
        for name,data in (extra or {}).items():z.writestr(name,data)
    return target.getvalue()

class ParserTests(unittest.TestCase):
    def test_txt(self):
        book=parse_book('Привет.\n\nВторая строка.'.encode(),'txt','Книга.txt')
        self.assertEqual(book['title'],'Книга')
        self.assertEqual(len(book['chapters'][0]['blocks']),2)
    def test_epub(self):
        book=parse_book(epub(),'epub')
        self.assertEqual(book['title'],'Проверка')
        self.assertEqual(book['author'],'Автор')
        self.assertEqual(book['chapters'],[{'title':'Глава','blocks':[{'type':'heading','text':'Глава'},{'type':'text','text':'Текст книги'}]}])

    def test_epub_spine_exact_html5_doctype_is_inert_and_scoped(self):
        body='<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Title</h1><p><strong>Safe</strong> text.</p></body></html>'
        for prefix in ['<!DOCTYPE html>', '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>', '\ufeff<?xml version="1.0"?>\n<!-- before -->\n<!DOCTYPE html><!-- after -->']:
            with self.subTest(prefix=prefix):
                book=parse_book(epub(document=prefix+body),'epub')
                self.assertEqual(book['title'],'Проверка')
                self.assertEqual(book['chapters'][0]['blocks'][-1]['text'],'Safe text.')
                self.assertEqual(book['structure']['chapters'][0]['blocks'][-1]['spans'][0]['kind'],'strong')
        for payload in [b'<!DOCTYPE html><html/>',b'<!DOCTYPE html><FictionBook><body><p>x</p></body></FictionBook>']:
            with self.subTest(payload=payload):
                with self.assertRaises(DTDForbidden):xml(payload)
        with self.assertRaises(DTDForbidden):
            parse_book(b'<!DOCTYPE html><FictionBook><body><p>x</p></body></FictionBook>','fb2')
        with self.assertRaises(DTDForbidden):
            parse_book(epub(container='<!DOCTYPE html><container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),'epub')
        with self.assertRaises(DTDForbidden):
            parse_book(epub(package='<!DOCTYPE html><package/>'),'epub')

    def test_epub_spine_doctype_does_not_allow_entities_external_ids_subsets_or_ambiguous_position(self):
        body='<html><body><p>Safe text.</p></body></html>'
        declarations=['<!DOCTYPE html SYSTEM "https://external.invalid/a.dtd">', '<!DOCTYPE html PUBLIC "id" "https://external.invalid/a.dtd">', '<!DOCTYPE html []>', '<!DOCTYPE html [<!ENTITY x SYSTEM "file:///etc/passwd">]>', '<!DOCTYPE html [<!ENTITY x "expanded">]>', '<!DOCTYPE  html>', '<!DOCTYPE\thtml>', '<!DOCTYPE HTML>', '<!DOCTYPE html><!DOCTYPE html>']
        for declaration in declarations:
            with self.subTest(declaration=declaration):
                with self.assertRaises(DTDForbidden):parse_book(epub(document=declaration+body),'epub')
        for document in ['<!DOCTYPE html><FictionBook><body><p>x</p></body></FictionBook>', '<!DOCTYPE html><HTML><body><p>x</p></body></HTML>', '<!DOCTYPE html><html xmlns="urn:not-xhtml"><body><p>x</p></body></html>']:
            with self.subTest(document=document):
                with self.assertRaisesRegex(ValueError,'doctype'):parse_book(epub(document=document),'epub')
        with self.assertRaises(ParseError):parse_book(epub(document='<html><body><!DOCTYPE html><p>x</p></body></html>'),'epub')
        # Declarations appearing only as text or inside a comment are never
        # rewritten into structural markup by the prolog exception.
        book=parse_book(epub(document='<html><body><p><![CDATA[<!DOCTYPE html>]]></p></body></html>'),'epub')
        self.assertEqual(book['chapters'][0]['blocks'][0]['text'],'<!DOCTYPE html>')

    def test_epub_observed_svg_raster_wrapper_becomes_only_reencoded_png(self):
        png=io.BytesIO();Image.new('RGB',(10,10),(255,0,0)).save(png,format='PNG')
        wrapper='<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" height="100%" width="100%" version="1.1" viewBox="0 0 10 10" preserveAspectRatio="xMidYMid meet"><image width="10" height="10" xlink:href="cover.png"/></svg>'
        book=parse_book(epub(wrapper,extra={'cover.png':png.getvalue()}),'epub')
        self.assertEqual(len(book['assets']),1)
        self.assertEqual(book['chapters'][0]['blocks'][-1]['type'],'image')
        self.assertEqual(book['structure']['chapters'][0]['blocks'][-1]['type'],'image')
        self.assertIn('EPUB_SVG_RASTER_WRAPPER_FLATTENED',book['structure']['warnings'])
        self.assertTrue(base64.b64decode(next(iter(book['assets'].values()))).startswith(b'\x89PNG\r\n\x1a\n'))

    def test_epub_svg_wrapper_cannot_introduce_svg_engine_scripts_styles_remote_resources_or_extra_shapes(self):
        png=io.BytesIO();Image.new('RGB',(10,10)).save(png,format='PNG')
        wrapper='<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" height="100%" width="100%" version="1.1" viewBox="0 0 10 10" preserveAspectRatio="xMidYMid meet"><image width="10" height="10" xlink:href="cover.png"/></svg>'
        variants=[wrapper.replace('version="1.1"','version="1.1" onload="bad"'),wrapper.replace('version="1.1"','version="1.1" style="bad"'),wrapper.replace('version="1.1"','version="1.0"'),wrapper.replace('100%','99%',1),wrapper.replace('0 0 10 10','0 0 10.0 10'),wrapper.replace('0 0 10 10','0 0 20000 20000'),wrapper.replace('0 0 10 10','0 0 0 10'),wrapper.replace('xMidYMid meet','none'),wrapper.replace('www.w3.org/2000/svg','invalid.invalid/svg'),wrapper.replace('xlink:href="cover.png"','href="cover.png"'),wrapper.replace('xlink:href="cover.png"','xlink:href="cover.png" href="other.png"'),wrapper.replace('<image ','<image onerror="bad" '),wrapper.replace('<image ','<image style="bad" '),wrapper.replace('<image width="10"','<image width="11"'),wrapper.replace('</svg>','<script>bad</script></svg>'),wrapper.replace('/></svg>','><animate/></image></svg>'),wrapper.replace('</svg>','<image/></svg>'),wrapper.replace('<image ','text<image '),wrapper.replace('/></svg>','/>tail</svg>')]
        for value in variants:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):parse_book(epub(value,extra={'cover.png':png.getvalue()}),'epub')
        for reference in ['https://external.invalid/cover.png','file:///etc/passwd','//external.invalid/cover.png','data:image/png;base64,AA==','../cover.png','cover.png?query=1','cover.png#fragment']:
            with self.subTest(reference=reference):
                with self.assertRaises(ValueError):parse_book(epub(wrapper.replace('cover.png',reference),extra={'cover.png':png.getvalue()}),'epub')
        with self.assertRaises(ValueError):parse_book(epub('<script>'+wrapper+'</script>',extra={'cover.png':png.getvalue()}),'epub')
        # Extracted bytes must still pass Pillow; an SVG disguised as a PNG is
        # not interpreted or handed to a browser.
        with self.assertRaises(UnidentifiedImageError):parse_book(epub(wrapper,extra={'cover.png':b'<svg xmlns="http://www.w3.org/2000/svg"/>'}),'epub')

    def test_source_metadata_uses_only_actual_direct_opf_dublin_core_fields(self):
        package='''<package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:evil="urn:evil"><metadata>
        <dc:title>Actual source title</dc:title><dc:creator>Actual Writer</dc:creator><dc:language>en</dc:language>
        <dc:identifier>http://www.gutenberg.org/ebooks/11</dc:identifier><evil:identifier>http://www.gutenberg.org/ebooks/12</evil:identifier>
        <nested><dc:identifier>http://www.gutenberg.org/ebooks/13</dc:identifier></nested></metadata>
        <manifest><item id="c1" href="chapter.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>'''
        book=parse_book(epub('<p>http://www.gutenberg.org/ebooks/99</p>',package=package),'epub','Expected API title.epub')
        self.assertEqual(book['sourceMetadata'],{'schemaVersion':1,'format':'epub','provenance':'opf','title':'Actual source title','authors':['Actual Writer'],'languages':['en'],'identifiers':['http://www.gutenberg.org/ebooks/11']})
        self.assertEqual(book['title'],'Actual source title')

    def test_missing_source_metadata_is_not_filled_from_filename_or_nested_body(self):
        package='<package><metadata><title>Legacy unqualified title</title><identifier>http://www.gutenberg.org/ebooks/11</identifier></metadata><manifest><item id="c1" href="chapter.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>'
        book=parse_book(epub(package=package),'epub','Expected title.epub')
        self.assertEqual(book['sourceMetadata']['title'],'')
        self.assertEqual(book['sourceMetadata']['identifiers'],[])
        self.assertEqual(book['sourceMetadata']['authors'],[])
        self.assertNotIn('sourceMetadata',parse_book(b'Ordinary TXT without a source wrapper.','txt','Expected title.txt'))

    def test_source_metadata_ambiguity_and_size_are_bounded(self):
        base='<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata>{}</metadata><manifest><item id="c1" href="chapter.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>'
        for fields in ['<dc:creator>Writer</dc:creator>'*17,'<dc:identifier>x</dc:identifier>'*33,'<dc:title>'+'x'*301+'</dc:title>']:
            with self.subTest(fields=fields[:40]),self.assertRaisesRegex(ValueError,'Метаданные источника'):
                parse_book(epub(package=base.format(fields)),'epub')
        with self.assertRaisesRegex(ValueError,'Неоднозначные метаданные'):
            parse_book(epub(package=base.format('').replace('</metadata>','</metadata><metadata/>')),'epub')
        # Multiple actual titles are preserved as unknown for automatic identity
        # verification; a filename or the first title cannot decide silently.
        book=parse_book(epub(package=base.format('<dc:title>One</dc:title><dc:title>Two</dc:title>')),'epub')
        self.assertEqual(book['sourceMetadata']['title'],'')

    def test_gutenberg_txt_source_metadata_is_actual_header_only(self):
        header="The Project Gutenberg eBook of Source title\n\nTitle: Source title\nAuthor: Source Writer\nLanguage: English\nRelease date: today [eBook #11]\n\n*** START OF THE PROJECT GUTENBERG EBOOK SOURCE TITLE ***\n\nText mentions [eBook #99] in the body.\n\n*** END OF THE PROJECT GUTENBERG EBOOK SOURCE TITLE ***"
        book=parse_book(header.encode(),'txt','Not source metadata.txt')
        self.assertEqual(book['sourceMetadata'],{'schemaVersion':1,'format':'txt','provenance':'gutenberg-txt-header','title':'Source title','authors':['Source Writer'],'languages':['English'],'identifiers':['https://www.gutenberg.org/ebooks/11']})
        # The generic reader's filename behavior remains; the separate discovery
        # gate derives its publication metadata from the verified raw header.
        self.assertEqual(book['title'],'Not source metadata')
    def test_fb2(self):
        book=parse_book('<FictionBook><description><title-info><book-title>Книга</book-title></title-info></description><body><section><p>Текст</p></section></body></FictionBook>'.encode(),'fb2')
        self.assertEqual(book['title'],'Книга')
    def test_path_traversal(self):
        for name in ['../x','/etc/passwd','x/../../x','C:/x','x\\y','','.','x\ny','x\x00y']:
            with self.assertRaises(ValueError):safe_path(name)
        with self.assertRaises(ValueError):parse_book(epub(extra={'../x':'bad'}),'epub')
    def test_executable(self):
        with self.assertRaises(ValueError):parse_book(epub(extra={'hidden.exe':b'MZ'}),'epub')
    def test_scripts(self):
        for body in ['<p onclick="x()">Текст</p>','<script>bad()</script>','<p><script>bad()</script></p>']:
            with self.assertRaises(ValueError):parse_book(epub(body),'epub')
    def test_external_images(self):
        with self.assertRaises(ValueError):parse_book(epub('<img src="http://127.0.0.1/secret"/>'),'epub')
    def test_xml_entities(self):
        with self.assertRaises(DTDForbidden):parse_book(b'<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><FictionBook><body><p>&a;</p></body></FictionBook>','fb2')
    def test_fake_text(self):
        for data in [b'MZbinary',b'<html><body>Error</body></html>',b'\0binary']:
            with self.assertRaises(ValueError):parse_book(data,'txt')
    def test_zip_bomb(self):
        with self.assertRaises(ValueError):parse_book(epub(extra={'large.txt':b'x'*1_000_000}),'epub')
    def test_illustration(self):
        buf=io.BytesIO();Image.new('RGB',(32,32),(100,140,80)).save(buf,format='PNG')
        book=parse_book(epub('<p>Текст</p><img src="map.png" alt="Карта"/>',{'map.png':buf.getvalue()}),'epub')
        self.assertEqual(len(book['assets']),1)
        self.assertTrue(base64.b64decode(book['assets']['image-0.png']).startswith(b'\x89PNG'))
    def test_ranobe(self):
        payload={'title':'Новелла','chapters':[{'title':'Глава 1','html':'<p>Текст <strong>главы</strong>.</p>'}],'images':{}}
        book=parse_book(json.dumps(payload).encode(),'ranobe')
        self.assertEqual(book['chapters'][0]['blocks'][0]['text'],'Текст главы.')
    def test_ranobe_active(self):
        payload={'title':'Новелла','chapters':[{'title':'Глава 1','html':'<p onclick="x()">Текст</p>'}],'images':{}}
        with self.assertRaises(ValueError):parse_book(json.dumps(payload).encode(),'ranobe')

    def test_xml_depth_boundary_and_early_rejection(self):
        # The configured limit counts the root. An incomplete malicious suffix
        # must not be reached: the depth gate fires while parsing start tags.
        xml(b'<r>'*MAX_XML_DEPTH+b'</r>'*MAX_XML_DEPTH)
        with self.assertRaisesRegex(ValueError,'лимит глубины'):
            xml(b'<r>'*(MAX_XML_DEPTH+1)+b'<')

    def test_xml_node_boundary_and_early_rejection(self):
        # Width and depth have independent budgets; a shallow XML can still be
        # expensive. Checking the real production bound avoids a mock-only test.
        xml(b'<r>'+b'<n/>'*(MAX_XML_NODES-1)+b'</r>')
        with self.assertRaisesRegex(ValueError,'числа узлов'):
            xml(b'<r>'+b'<n/>'*MAX_XML_NODES+b'<')

    def test_xml_limits_apply_to_each_format_and_epub_document(self):
        deep='<x>'*(MAX_XML_DEPTH+1)+'</x>'*(MAX_XML_DEPTH+1)
        for payload,extension in [
            (('<FictionBook>'+deep+'</FictionBook>').encode(),'fb2'),
            (epub(deep,compression=zipfile.ZIP_STORED),'epub'),
            (epub(package=deep,compression=zipfile.ZIP_STORED),'epub'),
            (epub(container=deep,compression=zipfile.ZIP_STORED),'epub')]:
            with self.subTest(extension=extension,payload=payload[:20]):
                with self.assertRaisesRegex(ValueError,'лимит глубины'):parse_book(payload,extension)
        with patch.object(safe_parser,'MAX_XML_NODES',8):
            with self.assertRaisesRegex(ValueError,'числа узлов'):
                parse_book(b'<FictionBook><body>'+b'<p>x</p>'*7+b'</body></FictionBook>','fb2')

    def test_epub_duplicate_manifest_ids_cannot_shadow_chapter(self):
        payload=epub(manifest='<item id="c1" href="chapter.xhtml"/><item id="c1" href="other.xhtml"/>',extra={'other.xhtml':'<html><body><p>Другой текст</p></body></html>'})
        with self.assertRaisesRegex(ValueError,'дублирующийся ID'):parse_book(payload,'epub')

    def test_epub_duplicate_manifest_paths_are_ambiguous(self):
        for alias in ['chapter.xhtml','./chapter.xhtml','%63hapter.xhtml']:
            with self.subTest(alias=alias):
                payload=epub(manifest=f'<item id="c1" href="chapter.xhtml"/><item id="c2" href="{alias}"/>')
                with self.assertRaisesRegex(ValueError,'Неоднозначный путь'):parse_book(payload,'epub')

    def test_epub_manifest_fields_and_all_declared_paths_are_checked(self):
        for manifest in ['<item href="chapter.xhtml"/>','<item id="" href="chapter.xhtml"/>','<item id="two words" href="chapter.xhtml"/>','<item id="c1"/>','<item id="c1" href="chapter.xhtml"/><item id="unused" href="missing.png"/>']:
            with self.subTest(manifest=manifest):
                with self.assertRaises(ValueError):parse_book(epub(manifest=manifest),'epub')

    def test_epub_duplicate_package_ids_are_rejected(self):
        package='<package><metadata><title id="c1">Книга</title></metadata><manifest><item id="c1" href="chapter.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>'
        with self.assertRaisesRegex(ValueError,'дублирующийся ID'):parse_book(epub(package=package),'epub')

    def test_epub_spine_references_must_exist_and_be_unique(self):
        for spine in ['<itemref idref="missing"/>','<itemref/>','<itemref idref="c1"/><itemref idref="c1"/>']:
            with self.subTest(spine=spine):
                with self.assertRaisesRegex(ValueError,'ссылка в spine'):parse_book(epub(spine=spine),'epub')

    def test_epub_spine_obeys_order_instead_of_archive_or_manifest_order(self):
        payload=epub(manifest='<item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="second.xhtml" media-type="application/xhtml+xml"/>',spine='<itemref idref="c2"/><itemref idref="c1"/>',extra={'second.xhtml':'<html><body><h1>Вторая</h1><p>Второй текст</p></body></html>'})
        book=parse_book(payload,'epub')
        self.assertEqual([chapter['title'] for chapter in book['chapters']],['Вторая','Глава'])
        self.assertEqual(book['chapters'][0]['blocks'][-1]['text'],'Второй текст')

    def test_epub_spine_media_type_cannot_contradict_xhtml(self):
        with self.assertRaisesRegex(ValueError,'тип главы'):
            parse_book(epub(manifest='<item id="c1" href="chapter.xhtml" media-type="image/png"/>'),'epub')

    def test_epub_only_direct_manifest_and_spine_items_are_used(self):
        valid_manifest='<manifest><item id="c1" href="chapter.xhtml"/></manifest>'
        valid_spine='<spine><itemref idref="c1"/></spine>'
        for sections in [valid_manifest+valid_manifest+valid_spine,valid_manifest+valid_spine+valid_spine,
                         '<metadata><item id="rogue" href="chapter.xhtml"/></metadata>'+valid_manifest+valid_spine,
                         valid_manifest+'<metadata><itemref idref="c1"/></metadata>'+valid_spine,
                         '<manifest><wrapper><item id="c1" href="chapter.xhtml"/></wrapper></manifest>'+valid_spine]:
            with self.subTest(sections=sections):
                with self.assertRaises(ValueError):parse_book(epub(package='<package>'+sections+'</package>'),'epub')

    def test_epub_rootfile_must_be_unambiguous(self):
        for rootfiles in ['','<rootfile/>','<rootfile full-path="book.opf"/><rootfile full-path="book.opf"/>','<rootfile full-path="book.opf" media-type="text/plain"/>']:
            with self.subTest(rootfiles=rootfiles):
                with self.assertRaises(ValueError):parse_book(epub(container='<container><rootfiles>'+rootfiles+'</rootfiles></container>'),'epub')

    def test_epub_resource_uri_cannot_silently_drop_components(self):
        for href in ['chapter.xhtml?version=2','chapter.xhtml#different','chapter.xhtml?','chapter.xhtml#',' chapter.xhtml','chapter.xhtml&#10;','%2e%2e/chapter.xhtml','%2Fchapter.xhtml','%5cchapter.xhtml','%00chapter.xhtml','%FFchapter.xhtml']:
            with self.subTest(href=href):
                with self.assertRaises(ValueError):parse_book(epub(manifest=f'<item id="c1" href="{href}"/>'),'epub')

    def test_epub_manifest_cannot_repurpose_control_files(self):
        for href in ['book.opf','mimetype','META-INF/container.xml']:
            with self.subTest(href=href):
                with self.assertRaisesRegex(ValueError,'Неоднозначный путь'):parse_book(epub(manifest=f'<item id="c1" href="{href}"/>'),'epub')

    def test_epub_archive_file_directory_conflict(self):
        for extra in [{'chapter.xhtml/':'','chapter.xhtml/hidden.txt':'x'},{'folder':'x','folder/hidden.txt':'y'}]:
            with self.subTest(extra=extra):
                with self.assertRaises(ValueError):parse_book(epub(extra=extra),'epub')

    def test_epub_directory_entries_count_towards_archive_limit(self):
        with patch.object(safe_parser,'MAX_FILES',5):
            with self.assertRaisesRegex(ValueError,'числа записей'):
                parse_book(epub(extra={'one/':'','two/':''}),'epub')

    def test_epub_nested_paths_and_percent_encoded_filenames(self):
        buf=io.BytesIO();Image.new('RGB',(8,8),(100,140,80)).save(buf,format='PNG')
        target=io.BytesIO()
        with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
            z.writestr('mimetype','application/epub+zip')
            z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>')
            z.writestr('OPS/book.opf','<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest><item id="c1" href="Text/first%20chapter.xhtml" media-type="application/xhtml+xml"/><item id="map" href="Images/map.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>')
            z.writestr('OPS/Text/first chapter.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Текст</p><img src="../Images/map.png"/></body></html>')
            z.writestr('OPS/Images/map.png',buf.getvalue())
        book=parse_book(target.getvalue(),'epub')
        self.assertEqual(book['chapters'][0]['blocks'],[{'type':'text','text':'Текст'},{'type':'image','asset':'image-0.png','text':''}])
        self.assertEqual(len(book['assets']),1)

if __name__=='__main__':unittest.main()
