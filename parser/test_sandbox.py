"""Real disposable-process OS policy tests; never use production inputs/mounts."""
import io
from contextlib import nullcontext
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

import sandbox


class BoundaryTests(unittest.TestCase):
    def test_unsupported_platform_never_runs_decoder(self):
        with patch.object(sandbox.sys, 'platform', 'win32'), patch.object(sandbox, 'bounded_exchange') as exchange:
            with self.assertRaises(sandbox.SandboxError) as caught:
                sandbox.parse_isolated(b'Text', 'txt', 'Book.txt')
            self.assertEqual(caught.exception.code, 'SANDBOX_UNAVAILABLE')
            exchange.assert_not_called()

    def test_input_bound_before_launch(self):
        with patch.object(sandbox, 'architecture'), patch.object(sandbox, 'bounded_exchange') as exchange:
            with self.assertRaises(sandbox.SandboxError) as caught:
                sandbox.parse_isolated(b'x' * (sandbox.MAX_INPUT_BYTES + 1), 'txt', 'Book.txt')
            self.assertEqual(caught.exception.code, 'FILE_TOO_LARGE')
            exchange.assert_not_called()

    def test_policy_setup_failure_never_consumes_book(self):
        stream = Mock()
        with patch.object(sandbox, '_prepare_child', side_effect=PermissionError('Policy setup denied')), patch.object(sandbox.sys, 'stdin', stream):
            with self.assertRaises(sandbox.SandboxError) as caught:
                sandbox.child_main('/unused-owner-scratch', 1)
        self.assertEqual(caught.exception.code, 'SANDBOX_UNAVAILABLE')
        stream.buffer.readline.assert_not_called()
        stream.buffer.read.assert_not_called()

    def test_only_book_crosses_return_boundary(self):
        replies = [b'{"ok":true,"book":{},"sha256":"forged"}', b'{"ok":true,"book":null}',
                   b'{"ok":true,"ok":false,"book":{}}', b'{"ok":true,"book":{"x":NaN}}',
                   b'{"ok":false,"errorCode":"arbitrary child message /secrets"}', b'not-json']
        for reply in replies:
            with self.subTest(reply=reply), patch.object(sandbox, 'architecture'), patch.object(sandbox, 'bounded_exchange', return_value=reply), patch.object(sandbox.tempfile, 'TemporaryDirectory', return_value=nullcontext('/unused-owner-scratch')):
                with self.assertRaises(sandbox.SandboxError) as caught:
                    sandbox.parse_isolated(b'Text', 'txt', 'Book.txt')
                self.assertEqual(caught.exception.code, 'SANDBOX_FAILED')

    def test_stdout_flood_stops_at_bound(self):
        command = [sys.executable, '-I', '-B', '-c', 'import os\nwhile True: os.write(1,b"x"*65536)']
        started = time.monotonic()
        with self.assertRaises(sandbox.SandboxError) as caught:
            sandbox.bounded_exchange(command, b'', b'', timeout=5, limit=64 * 1024)
        self.assertEqual(caught.exception.code, 'RESULT_TOO_LARGE')
        self.assertLess(time.monotonic() - started, 5)

    def test_blocked_stdin_and_silent_child_have_deadline(self):
        command = [sys.executable, '-I', '-B', '-c', 'import time; time.sleep(10)']
        started = time.monotonic()
        with self.assertRaises(sandbox.SandboxError) as caught:
            sandbox.bounded_exchange(command, b'header\n', b'x' * (2 * 1024 * 1024), timeout=0.15)
        self.assertEqual(caught.exception.code, 'PARSER_TIMEOUT')
        self.assertLess(time.monotonic() - started, 4)

    def test_large_input_and_output_pipes_do_not_deadlock(self):
        command = [sys.executable, '-I', '-B', '-c', 'import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data)']
        data = b'x' * (2 * 1024 * 1024)
        self.assertEqual(sandbox.bounded_exchange(command, b'h\n', data, timeout=5, limit=len(data) + 2), b'h\n' + data)


@unittest.skipUnless(sys.platform == 'linux', 'Real Landlock/seccomp policy requires Linux')
class LinuxSandboxTests(unittest.TestCase):
    def test_unavailable_landlock_does_not_enable_partial_policy(self):
        if os.geteuid() == 0:
            self.skipTest('Other tests verify root is rejected; exercise ABI failure as non-root')
        with tempfile.TemporaryDirectory() as scratch, patch.object(sandbox, 'landlock_abi', side_effect=sandbox.SandboxError('SANDBOX_UNAVAILABLE')), patch.object(sandbox, '_seccomp') as seccomp:
            with self.assertRaises(sandbox.SandboxError):
                sandbox.restrict_process(scratch)
            seccomp.assert_not_called()

    def test_normal_txt_fb2_epub_and_raster_decode(self):
        if os.geteuid() == 0:
            with self.assertRaises(sandbox.SandboxError):
                sandbox.parse_isolated(b'Text', 'txt', 'Book.txt')
            return
        from PIL import Image
        image = io.BytesIO(); Image.new('RGB', (8, 8), 'red').save(image, format='PNG')
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('mimetype', 'application/epub+zip')
            z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>')
            z.writestr('OPS/package.opf', '<package><metadata><title>Sandbox EPUB</title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="img" href="image.png" media-type="image/png"/></manifest><spine><itemref idref="chapter"/></spine></package>')
            z.writestr('OPS/chapter.xhtml', '<html><body><p>Chapter text.</p><img src="image.png"/></body></html>')
            z.writestr('OPS/image.png', image.getvalue())
        samples = [
            ('txt', 'Текст в UTF-8.'.encode(), 'UTF-8'),
            ('txt', 'Текст в CP1251.'.encode('cp1251'), 'CP1251'),
            ('fb2', '<FictionBook><description><title-info><book-title>FB2 test</book-title></title-info></description><body><section><p>Text.</p></section></body></FictionBook>'.encode(), 'FB2'),
            ('epub', archive.getvalue(), 'EPUB'),
            ('ranobe', json.dumps({'title': 'Novel', 'chapters': [{'title': 'One', 'html': '<p>Novel text.</p>'}], 'images': {}}).encode(), 'Novel'),
        ]
        for extension, data, title in samples:
            with self.subTest(extension=extension, title=title):
                book = sandbox.parse_isolated(data, extension, title + '.' + extension)
                self.assertTrue(book['chapters'])
                if extension == 'epub':
                    self.assertEqual(len(book['assets']), 1)

    def test_all_allowed_raster_decoders_work_after_policy(self):
        if os.geteuid() == 0:
            self.skipTest('Production policy requires non-root')
        import base64
        from PIL import Image
        for kind in ('PNG', 'JPEG', 'WEBP', 'GIF'):
            with self.subTest(kind=kind):
                image = io.BytesIO(); Image.new('RGB', (8, 8), 'red').save(image, format=kind)
                payload = {'title': 'Raster test', 'chapters': [{'title': 'One', 'html': '<p>Text.</p><img src="test-image"/>'}],
                           'images': {'test-image': base64.b64encode(image.getvalue()).decode()}}
                book = sandbox.parse_isolated(json.dumps(payload).encode(), 'ranobe', 'Raster.ranobe')
                self.assertEqual(len(book['assets']), 1)
                self.assertTrue(next(iter(book['assets'].values())).startswith('iVBOR'))

    def test_kernel_denies_sibling_jobs_library_database_network_and_process_escape(self):
        if os.geteuid() == 0:
            self.skipTest('Real production policy intentionally requires non-root')
        with tempfile.TemporaryDirectory(prefix='gargantua-sandbox-access-') as temporary:
            root = Path(temporary)
            scratch = root / 'scratch'; scratch.mkdir(mode=0o700)
            for directory in ('quarantine/attempts', 'jobs/pending', 'jobs/results', 'library', 'database'):
                (root / directory).mkdir(parents=True)
            allowed = root / 'quarantine/attempts/own'; allowed.write_text('own bytes')
            forbidden = [root / 'quarantine/attempts/sibling', root / 'jobs/pending/other.json',
                         root / 'jobs/results/other.json', root / 'library/book.json', root / 'database/db']
            for path in forbidden:
                path.write_text('private other-job data')
            # Preload every testing dependency before policy, exactly as the
            # real child preloads decoder code before reading book bytes.
            program = r'''
import errno,json,os,resource,socket,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import sandbox
root=Path(sys.argv[2]); scratch=root/'scratch'
oldfd=os.open(root/'quarantine/attempts/sibling',os.O_RDONLY)
control=socket.socket(socket.AF_INET,socket.SOCK_STREAM); control.close()
abi=sandbox.restrict_process(scratch,read_paths=[*sandbox.runtime_read_paths(),root/'quarantine/attempts/own'])
denied=[]
def must_deny(name,action):
    try: action()
    except OSError as exc:
        if exc.errno not in (errno.EPERM,errno.EACCES,errno.EBADF): raise
        denied.append(name)
    else: raise AssertionError('Unexpected access: '+name)
must_deny('inherited-fd',lambda:os.read(oldfd,1))
assert (root/'quarantine/attempts/own').read_text()=='own bytes'
for name in ('quarantine/attempts/sibling','jobs/pending/other.json','jobs/results/other.json','library/book.json','database/db'):
    path=root/name
    must_deny('read:'+name,lambda:path.read_bytes())
    must_deny('write:'+name,lambda:path.write_text('overwritten'))
must_deny('write-own-input',lambda:(root/'quarantine/attempts/own').write_text('changed'))
must_deny('create-other-job',lambda:(root/'jobs/results/new.json').write_text('forged'))
must_deny('truncate-other-job',lambda:os.truncate(root/'jobs/results/other.json',0))
must_deny('chmod-other-job',lambda:os.chmod(root/'jobs/results/other.json',0o777))
must_deny('read-proc-environment',lambda:Path('/proc/self/environ').read_bytes())
must_deny('read-proc-parent-memory',lambda:Path('/proc/'+str(os.getppid())+'/mem').read_bytes())
for kind in (socket.SOCK_STREAM,socket.SOCK_DGRAM):
    must_deny('inet-socket:'+str(kind),lambda:socket.socket(socket.AF_INET,kind))
must_deny('unix-socket',lambda:socket.socket(socket.AF_UNIX,socket.SOCK_STREAM))
must_deny('fork',lambda:os.fork())
must_deny('exec',lambda:os.execve('/bin/true',['true'],{}))
must_deny('signal-parent',lambda:os.kill(os.getppid(),0))
must_deny('change-parent-resource-limits',lambda:resource.prlimit(os.getppid(),resource.RLIMIT_NOFILE,(0,0)))
(scratch/'own.tmp').write_text('private temporary data')
assert (scratch/'own.tmp').read_text()=='private temporary data'
(scratch/'own.tmp').unlink()
print(json.dumps({'abi':abi,'denied':denied,'scratchReadWrite':True}))
'''
            completed = subprocess.run([sys.executable, '-I', '-B', '-c', program,
                                        str(Path(sandbox.__file__).resolve().parent), str(root)],
                                       capture_output=True, text=True, timeout=10, check=True)
            report = json.loads(completed.stdout)
            self.assertGreaterEqual(report['abi'], 3)
            self.assertGreaterEqual(len(report['denied']), 22)
            self.assertTrue(report['scratchReadWrite'])
            for path in forbidden:
                self.assertEqual(path.read_text(), 'private other-job data')
                self.assertNotEqual(path.stat().st_mode & 0o777, 0o777)
            self.assertEqual(allowed.read_text(), 'own bytes')
            self.assertFalse((root / 'jobs/results/new.json').exists())


if __name__ == '__main__':
    unittest.main()
