import unittest
from safe_parser import parse_book
from test_parser import epub


class StructureTests(unittest.TestCase):
    def test_inline_utf16_and_stable_ids(self):
        raw=epub('<p id="p1">😀 <strong>важно <em>читать</em></strong> дальше.</p>')
        first=parse_book(raw,'epub','one.epub');second=parse_book(raw,'epub','renamed.epub')
        a=first['structure']['chapters'][0];b=second['structure']['chapters'][0]
        self.assertEqual(a,b)
        block=a['blocks'][1]
        self.assertEqual(block['text'],'😀 важно читать дальше.')
        strong=next(s for s in block['spans'] if s['kind']=='strong')
        self.assertEqual(strong,{'kind':'strong','start':3,'end':15})
        self.assertEqual(next(s for s in block['spans'] if s['kind']=='emphasis'),{'kind':'emphasis','start':9,'end':15})

    def test_long_nested_emphasis_has_bounded_ranges(self):
        book=parse_book(epub('<p><strong><em>'+('x'*3000)+'</em></strong></p>'),'epub')
        self.assertEqual(len(book['structure']['chapters'][0]['blocks'][1]['spans']),2)

    def test_epub_internal_link_targets_real_block_external_link_inert(self):
        book=parse_book(epub('<p>Текст <a href="#note">1</a> <a href="https://example.org/">источник</a></p><aside id="note"><p>Примечание.</p></aside>'),'epub')
        blocks=book['structure']['chapters'][0]['blocks'];link=next(s for s in blocks[1]['spans'] if s['kind']=='link')
        self.assertEqual(link['target'],blocks[2]['id']);self.assertNotIn('href',str(book['structure']))
        self.assertIn('EXTERNAL_OR_UNRESOLVED_LINK',book['structure']['warnings'])

    def test_fb2_notes_across_bodies_and_author_spacing(self):
        raw='''<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Книга</book-title><author><first-name>Артур</first-name><last-name>Кларк</last-name></author></title-info></description><body><section><p>Текст<a l:href="#n1">1</a>.</p></section></body><body name="notes"><section id="n1"><p>Первая сноска.</p></section></body></FictionBook>'''.encode()
        book=parse_book(raw,'fb2');self.assertEqual(book['author'],'Артур Кларк')
        main,note=book['structure']['chapters'];self.assertEqual(note['blocks'][0]['type'],'footnote')
        self.assertEqual(main['blocks'][0]['spans'][0]['target'],note['blocks'][0]['id'])

    def test_table_rows_and_verse_survive(self):
        book=parse_book(epub('<table><tr><th>Имя</th><th>Число</th></tr><tr><td>Кот</td><td>2</td></tr></table><v>Строка стихов</v>'),'epub')
        blocks=book['structure']['chapters'][0]['blocks'];table=next(b for b in blocks if b['type']=='table')
        self.assertEqual(table['rows'],[['Имя','Число'],['Кот','2']]);self.assertEqual(table['text'],'Имя\tЧисло\nКот\t2')
        self.assertEqual(blocks[-1]['type'],'verse')

    def test_unresolved_link_has_visible_text_and_explicit_warning(self):
        book=parse_book(epub('<p><a href="#missing">Ссылка</a></p>'),'epub')
        block=book['structure']['chapters'][0]['blocks'][1]
        self.assertEqual(block['text'],'Ссылка');self.assertEqual(block.get('spans'),[])
        self.assertIn('UNRESOLVED_INTERNAL_LINK',book['structure']['warnings'])

    def test_duplicate_fb2_ids_rejected(self):
        with self.assertRaises(ValueError):parse_book(b'<FictionBook><body><section><p id="same">1</p><p id="same">2</p></section></body></FictionBook>','fb2')

    def test_ranobe_inline_structure_and_plain_compatibility(self):
        import json
        raw=json.dumps({'title':'Novel','chapters':[{'title':'One','html':'<p>One <em>two</em><br/>three</p>'}],'images':{}}).encode()
        book=parse_book(raw,'ranobe');block=book['structure']['chapters'][0]['blocks'][0]
        self.assertEqual(block['text'],'One two three');self.assertEqual(block['spans'],[{'kind':'emphasis','start':4,'end':7}])
        self.assertEqual(book['chapters'][0]['blocks'][0]['type'],'text')


if __name__=='__main__':unittest.main()
