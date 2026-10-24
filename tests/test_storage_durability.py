"""Real child-process storage probe tests; no production app or network access."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("storage_durability_probe", ROOT / "scripts/probe-storage-durability.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class StorageDurabilityTests(unittest.TestCase):
    def setUp(self):
        self.run = probe.new_run()

    def tearDown(self):
        probe.cleanup_run(self.run)

    def test_all_real_process_crashpoints_and_idempotent_retry(self):
        for point in probe.CRASHPOINTS:
            with self.subTest(crashpoint=point):
                result = probe.crash_case(self.run / point, point)
                self.assertEqual(result["child_returncode"], 80 + probe.CRASHPOINTS.index(point))
                self.assertGreaterEqual(len(result["asserted_observations"]), 9)

    def test_normal_completion(self):
        self.assertEqual(probe.crash_case(self.run / "normal", None)["child_returncode"], 0)

    def test_corruption_input_hash_shared_references_and_offline_cursor(self):
        results = probe.extra_cases(self.run)
        self.assertEqual({x["case"] for x in results}, {"corrupt-committed", "wrong-expected-hash", "shared-blob", "offline-cursor"})
        self.assertTrue(all(x["asserted_observations"] for x in results))

    def test_boundary_rejects_nonprobe_paths_and_nested_cleanup(self):
        for path in [ROOT, probe.TEMP, probe.TEMP / "unrelated", ROOT.parent / "outside"]:
            with self.subTest(path=str(path)), self.assertRaises(ValueError):
                probe.bounded(path)
        with self.assertRaises(ValueError):
            probe.cleanup_run(self.run / "nested")

    def test_idempotency_key_cannot_change_publication_or_content(self):
        case = self.run / "changed-command"
        probe.initialize(case)
        probe.prepare(case)
        with self.assertRaises(ValueError):
            probe.prepare(case, publication="another-book")
        with self.assertRaises(ValueError):
            probe.prepare(case, expected_sha="a" * 64)


if __name__ == "__main__":
    unittest.main()
