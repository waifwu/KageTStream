"""Run with: python -B -m unittest discover -s tools -p test_chinese_import.py"""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from extract import add_chinese


class ChineseImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name, 'source')
        self.out = Path(self.tmp.name, 'data')
        self.source.mkdir()
        self.out.mkdir()
        self.script = '*define\r\n; 中文注释\r\n\r\ngame\r\n*start\r\n中文正文。\\\r\nend\r\n'
        self.write(self.source / 'nscript.txt', self.script.encode('gbk'))
        self.write(self.out / 'manifest.json', json.dumps({'files': ['script.txt', 'es/arc/keep.jpg']}))

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data.encode('utf-8') if isinstance(data, str) else data)

    def run_import(self, source=None):
        with contextlib.redirect_stdout(io.StringIO()):
            add_chinese(str(source or self.source), str(self.out))

    def test_gbk_lines_resource_precedence_shared_files_and_repeat_import(self):
        self.write(self.out / 'arc/image/same.jpg', b'shared')
        self.write(self.out / 'arc/image/override.jpg', b'base')
        self.write(self.source / 'arc0/image/same.jpg', b'shared')
        self.write(self.source / 'arc0/image/override.jpg', b'old')
        self.write(self.source / 'arc1/IMAGE/Override.JPG', b'Chinese')
        self.write(self.source / 'arc1/image/New_ch.JPG', b'new')
        self.write(self.source / 'arc1/Thumbs.db', b'ignore')
        self.run_import()
        self.assertEqual((self.out / 'script-chs.txt').read_bytes(), self.script.replace('\r\n', '\n').encode('utf-8'))
        self.assertFalse((self.out / 'chs/arc/image/same.jpg').exists())
        self.assertEqual((self.out / 'chs/arc/image/override.jpg').read_bytes(), b'Chinese')
        self.assertEqual((self.out / 'arc/image/override.jpg').read_bytes(), b'base')
        expected = ['chs/arc/image/new_ch.jpg', 'chs/arc/image/override.jpg', 'es/arc/keep.jpg', 'script-chs.txt', 'script.txt']
        self.assertEqual(json.loads((self.out / 'manifest.json').read_text())['files'], expected)
        before = (self.out / 'manifest.json').read_bytes()
        self.run_import()
        self.assertEqual((self.out / 'manifest.json').read_bytes(), before)

    def test_utf8_and_obfuscated_gbk(self):
        self.write(self.source / 'nscript.txt', '\ufeff中文 UTF-8\n')
        self.run_import()
        self.assertEqual((self.out / 'script-chs.txt').read_text(encoding='utf-8'), '中文 UTF-8\n')
        dat = self.source / 'nscript.dat'
        self.write(dat, bytes(b ^ 0x84 for b in self.script.encode('gbk')))
        self.run_import(dat)
        self.assertEqual((self.out / 'script-chs.txt').read_text(encoding='utf-8'), self.script.replace('\r\n', '\n'))

    def test_numbered_music_reuses_cd_and_checks_missing_tracks(self):
        self.write(self.source / 'nscript.txt', 'mp3loop "bgm\\02.mp3"\n')
        self.write(self.source / 'bgm/02.mp3', b'source music')
        with self.assertRaisesRegex(ValueError, 'shared CD track'):
            self.run_import()
        self.assertFalse((self.out / 'script-chs.txt').exists())
        self.write(self.out / 'cd/track02.ogg', b'shared music')
        self.run_import()
        self.assertFalse((self.out / 'chs/arc/bgm/02.mp3').exists())
        self.assertEqual((self.out / 'script-chs.txt').read_text(), 'mp3loop "bgm\\02.mp3"\n')

    def test_daily_message_reroll_preserves_line_numbers(self):
        source = ('rnd %msgno,208\n;inc %msgno\n'
                  'if %msgno==%lastmsgno0 skip -1\n'
                  'if %msgno==%lastmsgno1 skip -2\n'
                  'if %msgno==%lastmsgno2 skip -3\n')
        self.write(self.source / 'nscript.txt', source)
        self.run_import()
        text = (self.out / 'script-chs.txt').read_text()
        self.assertEqual(text.count('\n'), source.count('\n'))
        for index in range(3):
            self.assertIn(f'if %msgno==%lastmsgno{index} skip -{index + 2}', text)

    def test_birthday_command_spacing_preserves_dialogue_spaces(self):
        self.write(self.source / 'nscript.txt', 'if %month==1 && %day==1　 mov $0,"　新年快乐"\n　正文\n')
        self.run_import()
        self.assertEqual((self.out / 'script-chs.txt').read_text(encoding='utf-8'),
                         'if %month==1 && %day==1 mov $0,"　新年快乐"\n　正文\n')

    def test_commands_on_lines_of_prose_are_put_away_in_place(self):
        source = ('ld c,":a;image\\tachi\\ari_t03.jpg",%type_crossfade_fst\n\n'
                  '「ld c,":a;image\\tachi\\ari_t03.jpg",%type_crossfade_fst\n\n'
                  '「……啊、是你啊。」\n'
                  '「知道吗？」br\n「………………」\\\n')
        self.write(self.source / 'nscript.txt', source)
        self.run_import()
        text = (self.out / 'script-chs.txt').read_text(encoding='utf-8')
        self.assertEqual(len(text), len(source))
        self.assertEqual(text.count('\n'), source.count('\n'))
        self.assertIn('\n;ld c,":a;image\\tachi\\ari_t03.jpg",%type_crossfade_fst\n', text)
        self.assertTrue(text.startswith('ld c,'))
        self.assertIn('「知道吗？」  \n「………………」', text)
        self.assertIn('「……啊、是你啊。」', text)

    def test_archives_and_loose_files_and_unsafe_paths(self):
        self.write(self.source / 'arc.nsa', b'archive')
        self.write(self.source / 'arc1.nsa', b'patch')
        def archive(name):
            return [('image/a.jpg', b'patch' if name.endswith('arc1.nsa') else b'base')]
        with patch('extract.read_nsa', side_effect=archive):
            self.run_import()
            self.assertEqual((self.out / 'chs/arc/image/a.jpg').read_bytes(), b'patch')
            self.write(self.source / 'image/a.jpg', b'loose')
            self.run_import()
            self.assertEqual((self.out / 'chs/arc/image/a.jpg').read_bytes(), b'loose')
        with patch('extract.read_nsa', return_value=[('../escape.jpg', b'bad')]):
            with self.assertRaisesRegex(ValueError, 'unsafe'):
                self.run_import()


if __name__ == '__main__':
    unittest.main()
