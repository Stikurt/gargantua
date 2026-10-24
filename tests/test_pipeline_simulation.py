"""Checks the finite protocol model, not the deployed library implementation."""
import importlib.util, pathlib, sys, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gargantua_protocol_model', ROOT / 'scripts/simulate-library-pipeline.py')
model = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = model
spec.loader.exec_module(model)


def publication():
    state = model.LibraryModel()
    rid = state.submit('B', 'request', {'title': 'Тест', 'audio': True})
    token = state.claim()
    state.prepare()
    pid = state.publish(token)
    return state, rid, pid


class ProtocolSimulationTests(unittest.TestCase):
    def test_all_declared_pairs_and_mutations(self):
        report = model.run_suite(seeds=2)
        self.assertEqual(report['traces'], 382)
        self.assertEqual(report['mutantsDetected'], len(model.MUTANTS))
        self.assertTrue(all(x['invariant'] == x['expectedInvariant'] for x in report['mutations']))
        self.assertEqual(set(report['faultCoverage']), set(model.FAULTS))

    def test_book_and_translation_without_audio_do_not_complete_request(self):
        state, rid, pid = publication()
        translation = state.translate(pid)
        self.assertFalse(state.fulfill(rid, translation))
        state.providers['tts'] = False
        self.assertIsNone(state.narrate(translation))
        self.assertNotEqual(state.requests[rid]['status'], 'satisfied')

    def test_unaccepted_audio_is_distinct_from_complete_audio(self):
        state, rid, pid = publication()
        translation = state.translate(pid)
        audio = state.narrate(translation, accepted=False)
        self.assertFalse(state.fulfill(rid, translation, audio))

    def test_acquisition_does_not_grant_translation_or_tts(self):
        state, rid, pid = publication()
        state.capabilities['B'].clear()
        self.assertIsNone(state.translate(pid))
        state.capabilities['B'].add('translate')
        translation = state.translate(pid)
        self.assertIsNone(state.narrate(translation))

    def test_nonmatching_bytes_do_not_publish_even_with_valid_extension(self):
        state = model.LibraryModel()
        state.submit('B', 'request', {'title': 'book.epub'})
        token = state.claim()
        state.prepare()
        state.input_bytes = b'changed-after-scanning'
        self.assertIsNone(state.publish(token))
        self.assertFalse(state.publications)

    def test_stale_result_cannot_publish_after_new_lease(self):
        state = model.LibraryModel()
        state.submit('B', 'request', {'title': 'Тест'})
        old = state.claim()
        state.prepare()
        state.expire()
        self.assertIsNone(state.publish(old))
        new = state.claim()
        state.prepare()
        self.assertIsNotNone(state.publish(new))

    def test_files_before_database_commit_are_not_readable(self):
        state = model.LibraryModel()
        state.submit('B', 'request', {'title': 'Тест'})
        token = state.claim()
        state.prepare()
        self.assertIsNone(state.publish(token, crash='before-commit'))
        self.assertTrue(state.files)
        self.assertFalse(state.publications)

    def test_partial_download_is_not_local_availability(self):
        state, rid, pid = publication()
        state.download(pid, crash='staging')
        state.recover_local()
        self.assertNotIn(pid, state.local_index)
        self.assertFalse(state.read_local(pid))
        state.download(pid, crash='after-file')
        state.recover_local()
        state.server = False
        self.assertTrue(state.read_local(pid, auth=False))

    def test_later_request_reuses_publication_and_accepted_outputs(self):
        state, first, pid = publication()
        text = state.translate(pid)
        audio = state.narrate(text)
        self.assertTrue(state.fulfill(first, text, audio))
        second = state.submit('A', 'later-request', {'title': 'Тест', 'audio': True})
        self.assertEqual(state.requests[second]['book'], pid)
        self.assertIsNone(state.claim(), 'a published operation does not restart acquisition')
        self.assertEqual(state.jobs[pid]['status'], 'succeeded')
        self.assertEqual(state.translate(pid), text)
        self.assertEqual(state.narrate(text), audio)
        self.assertTrue(state.fulfill(second, text, audio))
        self.assertEqual((len(state.publications), len(state.translation_cache), len(state.audio_cache)), (1, 1, 1))
        self.assertEqual(state.requests[first]['actor'], 'B')
        self.assertEqual(state.requests[second]['actor'], 'A')

    def test_cancelling_all_consumers_preserves_existing_publication(self):
        state, rid, pid = publication()
        text = state.translate(pid)
        audio = state.narrate(text)
        state.cancel(rid)
        self.assertEqual(state.jobs[pid]['status'], 'succeeded')
        self.assertIn(pid, state.publications)
        self.assertFalse(state.fulfill(rid, text, audio), 'completion cannot revive a cancelled request')
        self.assertEqual(state.requests[rid]['status'], 'cancelled')
        later = state.submit('A', 'later-request', {'title': 'Тест', 'audio': True})
        self.assertTrue(state.fulfill(later, text, audio))

    def test_partial_results_do_not_poison_operation_cache(self):
        state, rid, pid = publication()
        partial_text = state.translate(pid, complete=False)
        full_text = state.translate(pid)
        self.assertNotEqual(partial_text, full_text)
        self.assertFalse(state.translation_cache[partial_text]['complete'], 'old sample remains a distinct result')
        self.assertTrue(state.translation_cache[full_text]['complete'])
        self.assertEqual(state.translate(pid), full_text)
        partial_audio = state.narrate(full_text, complete=False)
        full_audio = state.narrate(full_text)
        self.assertNotEqual(partial_audio, full_audio)
        self.assertFalse(state.audio_cache[partial_audio]['complete'])
        self.assertTrue(state.fulfill(rid, full_text, full_audio))
        self.assertEqual(state.narrate(full_text), full_audio)

    def test_rejected_results_can_retry_without_rewriting_old_results(self):
        state, rid, pid = publication()
        rejected_text = state.translate(pid, accepted=False)
        text = state.translate(pid)
        self.assertNotEqual(rejected_text, text)
        self.assertFalse(state.translation_cache[rejected_text]['accepted'])
        rejected_audio = state.narrate(text, accepted=False)
        audio = state.narrate(text)
        self.assertNotEqual(rejected_audio, audio)
        self.assertFalse(state.audio_cache[rejected_audio]['accepted'])
        self.assertTrue(state.fulfill(rid, text, audio))

    def test_accepted_result_mutation_violates_immutability(self):
        state, _, pid = publication()
        text = state.translate(pid)
        state.translation_cache[text]['complete'] = False
        with self.assertRaises(model.Violation) as failure:
            state.check()
        self.assertEqual(failure.exception.code, 'ACCEPTED_TRANSLATION_IMMUTABLE')


if __name__ == '__main__':
    unittest.main()
