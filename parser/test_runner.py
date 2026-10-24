"""Runner tests use only a fresh temporary quarantine/jobs tree."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import defusedxml
import PIL
import runner
import safe_parser

TOKEN = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'


class RunnerTests(unittest.TestCase):
    def setUp(self):
        test_parent = Path(os.environ.get('GARGANTUA_RUNNER_TEST_TMP', tempfile.gettempdir()))
        test_parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='gargantua-parser-runner-', dir=test_parent)
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.config = runner.RunnerConfig(root / 'quarantine', root / 'jobs')
        for directory in [self.config.pending, self.config.results,
                          self.config.quarantine_root / 'attempts', self.config.quarantine_root / 'incoming']:
            directory.mkdir(parents=True)
        self.data = 'Текст проверяемой книги.'.encode('utf-8')
        self.digest = hashlib.sha256(self.data).hexdigest()
        # These unit tests exercise trusted storage/fencing, not OS policy.
        # Real subprocess/negative access tests use the unpatched Linux child.
        parse = patch.object(runner, 'parse_isolated', side_effect=lambda *args: safe_parser.parse_book(*args))
        parse.start(); self.addCleanup(parse.stop)

    def prepare(self, *, token=TOKEN, legacy=False, data=None, changes=None):
        data = self.data if data is None else data
        spec = {'id': token, 'extension': 'txt', 'filename': 'Проверка.txt'}
        if not legacy:
            spec.update(inputId=token, inputScope='attempts', inputSha256=hashlib.sha256(data).hexdigest())
        spec.update(changes or {})
        (self.config.pending / (token + '.json')).write_text(json.dumps(spec, ensure_ascii=False), encoding='utf-8')
        (self.config.quarantine_root / ('incoming' if legacy else 'attempts') / token).write_bytes(data)
        return spec

    def result(self, token=TOKEN):
        return json.loads((self.config.results / (token + '.json')).read_text(encoding='utf-8'))

    def symlink(self, link, target, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError) as exc:
            self.skipTest('Symlinks unavailable in this test environment: ' + type(exc).__name__)

    def test_attempt_result_pins_token_hash_and_snapshot_scope(self):
        self.prepare()
        (self.config.quarantine_root / 'incoming' / TOKEN).write_bytes(b'Different mutable incoming file')
        value = runner.process(self.config.pending / (TOKEN + '.json'), self.config)
        self.assertEqual(value['attemptToken'], TOKEN)
        self.assertEqual(value['sha256'], self.digest)
        self.assertEqual(value['book']['chapters'][0]['blocks'][0]['text'], self.data.decode())

    def test_legacy_in_flight_uses_only_incoming(self):
        self.prepare(legacy=True)
        (self.config.quarantine_root / 'attempts' / TOKEN).write_bytes(b'Different attempt file')
        value = runner.process(TOKEN + '.json', self.config)
        self.assertEqual(value['sha256'], self.digest)
        self.assertEqual(value['attemptToken'], TOKEN)

    def test_canonical_uuid_required_before_opening_any_file(self):
        for value in ['-' * 36, TOKEN.upper(), TOKEN.replace('-', ''), '../' + TOKEN, TOKEN + '.json', OTHER + '/x']:
            # The fixture UUID above has no alphabetic digits; use a real
            # uppercase candidate as an additional syntax check below.
            if value == TOKEN:
                continue
            with self.subTest(value=value), patch.object(runner, 'read_regular') as read:
                with self.assertRaises(runner.JobError):runner.run_job(value, self.config)
                read.assert_not_called()
        self.assertFalse(runner.valid_token('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'))
        self.assertTrue(runner.valid_token('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
        self.assertEqual(list(self.config.results.iterdir()), [])

    def test_job_path_must_be_exactly_inside_pending(self):
        self.prepare()
        for path in [Path(self.temporary.name) / (TOKEN + '.json'), self.config.pending / '..' / 'pending' / (TOKEN + '.json'), Path('../') / (TOKEN + '.json')]:
            with self.subTest(path=path), patch.object(runner, 'read_regular') as read:
                with self.assertRaises(runner.JobError):runner.process(path, self.config)
                read.assert_not_called()

    def test_invalid_or_partial_new_specs_never_downgrade_to_legacy(self):
        variants = [{'id': OTHER}, {'inputId': OTHER}, {'inputId': '../' + TOKEN}, {'inputScope': 'incoming'},
                    {'inputScope': '../incoming'}, {'inputScope': '/etc'}, {'inputScope': None},
                    {'inputSha256': '0' * 63}, {'inputSha256': 'A' * 64}, {'quarantine_root': self.temporary.name},
                    {'extension': 'exe'}, {'filename': 'bad\nname.txt'}, {'filename': ''}]
        for changes in variants:
            with self.subTest(changes=changes):
                self.prepare(changes=changes)
                with patch.object(safe_parser, 'parse_book') as parse:
                    with self.assertRaises(runner.JobError) as caught:runner.process(TOKEN + '.json', self.config)
                    self.assertEqual(caught.exception.code, 'INVALID_SPEC')
                    parse.assert_not_called()
        for missing in ['inputId', 'inputScope', 'inputSha256']:
            spec = self.prepare();del spec[missing]
            (self.config.pending / (TOKEN + '.json')).write_text(json.dumps(spec), encoding='utf-8')
            with self.subTest(missing=missing), self.assertRaises(runner.JobError):runner.process(TOKEN + '.json', self.config)

    def test_job_json_is_bounded_and_rejects_duplicate_keys(self):
        self.prepare()
        path = self.config.pending / (TOKEN + '.json')
        for payload in [b'x' * (runner.MAX_JOB_BYTES + 1), b'{"id":"wrong","id":"' + TOKEN.encode() + b'"}', b'[]', b'\xff']:
            path.write_bytes(payload)
            with self.subTest(payload=payload[:30]), patch.object(safe_parser, 'parse_book') as parse:
                runner.run_job(TOKEN, self.config)
                value = self.result()
                self.assertFalse(value['ok'])
                self.assertEqual(value['attemptToken'], TOKEN)
                self.assertIn(value['errorCode'], ['INVALID_SPEC', 'FILE_TOO_LARGE'])
                parse.assert_not_called()
            (self.config.results / (TOKEN + '.json')).unlink()

    def test_input_limit_is_checked_before_read_or_parse(self):
        self.prepare()
        with (self.config.quarantine_root / 'attempts' / TOKEN).open('r+b') as stream:
            stream.truncate(runner.MAX_INPUT_BYTES + 1)
        with patch.object(safe_parser, 'parse_book') as parse:
            runner.run_job(TOKEN, self.config)
            self.assertEqual(self.result()['errorCode'], 'FILE_TOO_LARGE')
            parse.assert_not_called()

    def test_input_hash_mismatch_never_reaches_parser(self):
        self.prepare(changes={'inputSha256': '0' * 64})
        with patch.object(safe_parser, 'parse_book') as parse:
            runner.run_job(TOKEN, self.config)
            value = self.result()
            self.assertEqual(value['errorCode'], 'INPUT_HASH_MISMATCH')
            self.assertEqual(value['sha256'], self.digest)
            parse.assert_not_called()

    def test_nonregular_input_is_rejected(self):
        self.prepare()
        path = self.config.quarantine_root / 'attempts' / TOKEN
        path.unlink();path.mkdir()
        runner.run_job(TOKEN, self.config)
        self.assertEqual(self.result()['errorCode'], 'UNSAFE_FILE')

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'POSIX FIFO test')
    def test_fifo_input_is_rejected_without_blocking(self):
        self.prepare()
        path = self.config.quarantine_root / 'attempts' / TOKEN
        path.unlink();os.mkfifo(path)
        runner.run_job(TOKEN, self.config)
        self.assertEqual(self.result()['errorCode'], 'UNSAFE_FILE')

    def test_symlink_input_is_not_read(self):
        self.prepare()
        outside = Path(self.temporary.name) / 'outside.txt';outside.write_bytes(self.data)
        path = self.config.quarantine_root / 'attempts' / TOKEN;path.unlink()
        self.symlink(path, outside)
        runner.run_job(TOKEN, self.config)
        self.assertEqual(self.result()['errorCode'], 'UNSAFE_FILE')
        self.assertEqual(outside.read_bytes(), self.data)

    def test_symlink_job_is_not_parsed(self):
        self.prepare()
        path = self.config.pending / (TOKEN + '.json')
        outside = Path(self.temporary.name) / 'outside.json';path.replace(outside)
        self.symlink(path, outside)
        with patch.object(safe_parser, 'parse_book') as parse:
            runner.run_job(TOKEN, self.config)
            self.assertEqual(self.result()['errorCode'], 'UNSAFE_FILE')
            parse.assert_not_called()

    def test_symlink_scope_cannot_escape_quarantine(self):
        self.prepare()
        scope = self.config.quarantine_root / 'attempts'
        outside = Path(self.temporary.name) / 'outside-scope';scope.replace(outside)
        self.symlink(scope, outside, directory=True)
        runner.run_job(TOKEN, self.config)
        self.assertEqual(self.result()['errorCode'], 'UNSAFE_DIRECTORY')

    def test_symlink_results_directory_is_refused(self):
        outside = Path(self.temporary.name) / 'outside-results';outside.mkdir()
        self.config.results.rmdir();self.symlink(self.config.results, outside, directory=True)
        with self.assertRaises(runner.JobError):runner.write_result(TOKEN, runner.error_result(TOKEN, 'TEST', 'Test'), self.config)
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlink_result_is_replaced_without_touching_target(self):
        self.prepare()
        outside = Path(self.temporary.name) / 'outside.txt';outside.write_text('Do not change', encoding='utf-8')
        self.symlink(self.config.results / (TOKEN + '.json'), outside)
        runner.run_job(TOKEN, self.config)
        self.assertTrue(self.result()['ok'])
        self.assertEqual(outside.read_text(encoding='utf-8'), 'Do not change')

    def test_parser_failure_has_safe_message_token_and_observed_hash(self):
        self.prepare()
        secret = 'Sensitive decoder bytes and path: ' + self.temporary.name
        with patch.object(safe_parser, 'parse_book', side_effect=ValueError(secret)):
            runner.run_job(TOKEN, self.config)
        value = self.result()
        self.assertEqual(value['attemptToken'], TOKEN)
        self.assertEqual(value['sha256'], self.digest)
        self.assertEqual(value['errorCode'], 'PARSER_REJECTED')
        self.assertNotIn(secret, json.dumps(value))

    def test_missing_os_sandbox_fails_closed_without_parse(self):
        self.prepare()
        with patch.object(runner, 'parse_isolated', side_effect=runner.SandboxError('SANDBOX_UNAVAILABLE')), patch.object(safe_parser, 'parse_book') as parse:
            runner.run_job(TOKEN, self.config)
        value = self.result()
        self.assertEqual(value['errorCode'], 'SANDBOX_UNAVAILABLE')
        self.assertEqual(value['sha256'], self.digest)
        parse.assert_not_called()

    def test_result_is_atomic_and_idempotent(self):
        self.prepare();runner.run_job(TOKEN, self.config)
        before = (self.config.results / (TOKEN + '.json')).read_bytes()
        (self.config.quarantine_root / 'attempts' / TOKEN).write_bytes(b'Later corruption')
        with patch.object(runner, 'process') as process:
            runner.run_job(TOKEN, self.config)
            process.assert_not_called()
        self.assertEqual((self.config.results / (TOKEN + '.json')).read_bytes(), before)
        self.assertEqual([p.name for p in self.config.results.iterdir()], [TOKEN + '.json'])

    def test_fsync_failure_preserves_old_result_and_cleans_staging(self):
        old = runner.error_result(TOKEN, 'OLD', 'Earlier committed result')
        runner.write_result(TOKEN, old, self.config)
        with patch.object(runner.os, 'fsync', side_effect=OSError('injected disk failure')):
            with self.assertRaises(runner.JobError):runner.write_result(TOKEN, runner.error_result(TOKEN, 'NEW', 'New'), self.config)
        self.assertEqual(self.result(), old)
        self.assertEqual([p.name for p in self.config.results.iterdir()], [TOKEN + '.json'])

    def test_replace_failure_preserves_old_result_and_cleans_staging(self):
        old = runner.error_result(TOKEN, 'OLD', 'Earlier committed result')
        runner.write_result(TOKEN, old, self.config)
        with patch.object(runner.os, 'replace', side_effect=OSError('injected rename failure')):
            with self.assertRaises(runner.JobError):runner.write_result(TOKEN, runner.error_result(TOKEN, 'NEW', 'New'), self.config)
        self.assertEqual(self.result(), old)
        self.assertEqual(len(list(self.config.results.iterdir())), 1)

    def test_parent_timeout_records_token_and_never_opens_job_json(self):
        self.prepare()
        child = Mock(side_effect=subprocess.TimeoutExpired('parser', 40))
        with patch.object(runner, 'read_spec', side_effect=AssertionError('parent opened spec')):
            self.assertEqual(runner.run_pending_once(self.config, child), 1)
        value = self.result()
        self.assertEqual((value['attemptToken'], value['errorCode']), (TOKEN, 'PARSER_TIMEOUT'))
        self.assertEqual(child.call_args.kwargs['timeout'], 40)
        self.assertIs(child.call_args.kwargs['check'], True)
        runner.run_pending_once(self.config, child)
        self.assertEqual(child.call_count, 1)

    def test_parent_handles_child_exit_without_result(self):
        self.prepare()
        runner.run_pending_once(self.config, Mock())
        self.assertEqual(self.result()['errorCode'], 'CHILD_NO_RESULT')

    def test_child_failure_after_atomic_commit_does_not_overwrite_success(self):
        self.prepare()
        def child(*args, **kwargs):
            runner.run_job(TOKEN, self.config)
            raise subprocess.CalledProcessError(1, 'parser')
        runner.run_pending_once(self.config, child)
        self.assertTrue(self.result()['ok'])
        self.assertEqual(self.result()['sha256'], self.digest)

    def test_cleanup_during_parse_prevents_late_result(self):
        self.prepare()
        original = safe_parser.parse_book
        def parse(*args):
            (self.config.pending / (TOKEN + '.json')).unlink()
            return original(*args)
        with patch.object(safe_parser, 'parse_book', side_effect=parse):runner.run_job(TOKEN, self.config)
        self.assertEqual(list(self.config.results.iterdir()), [])

    def test_spec_replacement_during_parse_prevents_result(self):
        self.prepare()
        original = safe_parser.parse_book
        def parse(*args):
            self.prepare(changes={'filename': 'A different request.txt'})
            return original(*args)
        with patch.object(safe_parser, 'parse_book', side_effect=parse):runner.run_job(TOKEN, self.config)
        self.assertEqual(list(self.config.results.iterdir()), [])

    def test_cleanup_during_child_timeout_prevents_late_error_result(self):
        self.prepare()
        def child(*args, **kwargs):
            (self.config.pending / (TOKEN + '.json')).unlink()
            raise subprocess.TimeoutExpired('parser', 40)
        runner.run_pending_once(self.config, child)
        self.assertEqual(list(self.config.results.iterdir()), [])

    def test_parent_ignores_arbitrary_names_and_limits_batch(self):
        for name in ['untrusted.json', '-' * 36 + '.json', TOKEN + '.tmp']:
            (self.config.pending / name).write_text('not a job', encoding='utf-8')
        self.prepare();self.prepare(token=OTHER)
        child = Mock(side_effect=subprocess.TimeoutExpired('parser', 40))
        with patch.object(runner, 'MAX_PENDING_BATCH', 1):
            self.assertEqual(runner.run_pending_once(self.config, child), 1)
        self.assertEqual(child.call_count, 1)
        self.assertEqual(len(list(self.config.results.iterdir())), 1)

    @unittest.skipUnless(sys.platform == 'linux', 'Production sandbox requires Linux; no unrestricted fallback')
    def test_real_subprocess_round_trip_with_owner_test_roots(self):
        self.prepare()
        dependency_paths = {str(Path(PIL.__file__).resolve().parent.parent), str(Path(defusedxml.__file__).resolve().parent.parent)}
        with patch.dict(os.environ, {'PYTHONPATH': os.pathsep.join(sorted(dependency_paths)), 'PYTHONDONTWRITEBYTECODE': '1'}):
            self.assertEqual(runner.run_pending_once(self.config), 1)
        value = self.result()
        self.assertTrue(value['ok'], value)
        self.assertEqual(value['attemptToken'], TOKEN)
        self.assertEqual(value['sha256'], self.digest)
        self.assertEqual(value['book']['title'], 'Проверка')


if __name__ == '__main__':
    unittest.main()
