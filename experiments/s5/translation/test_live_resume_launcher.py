import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("live_resume_launcher", Path(__file__).with_name("test-resume-live.py"))
live = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(live)


def row(identifier, text):
    return {"id": identifier, "repeatIndex": 1, "status": "generated", "text": text,
        "outputSha256": hashlib.sha256(text.encode()).hexdigest(), "wallSeconds": 1.0}


class ProofTests(unittest.TestCase):
    def setUp(self):
        self.ids = ["one", "two", "three"]
        self.before = {"status": "running", "identity": {"model": "pinned", "settings": {"repeat": 1}},
            "segments": [row("one", "Один."), row("two", "Два.")]}
        self.after = {**copy.deepcopy(self.before), "status": "completed", "resumeCount": 1,
            "segments": [*copy.deepcopy(self.before["segments"]), row("three", "Три.")],
            "invocations": [{"resumedAtCompletedInvocations": 0}, {"resumedAtCompletedInvocations": 2}]}

    def test_exact_prefix_and_only_remaining_rows_verified(self):
        proof = live.verify_resumed(self.before, self.after, self.ids)
        self.assertEqual(proof["remainingRowsGenerated"], 1)
        self.assertEqual(proof["prefixRows"], 2)
        self.assertTrue(proof["prefixUnchanged"])

    def test_completed_or_too_short_interrupted_prefix_rejected(self):
        for before in (dict(self.before, status="completed"), dict(self.before, segments=self.before["segments"][:1]),
            dict(self.before, segments=self.after["segments"])):
            with self.subTest(before=before), self.assertRaises(ValueError):
                live.prefix_snapshot(before, self.ids)

    def test_regenerated_or_mutated_committed_row_rejected(self):
        changed = copy.deepcopy(self.after)
        changed["segments"][0]["wallSeconds"] = 99.0
        with self.assertRaisesRegex(ValueError, "committed"):
            live.verify_resumed(self.before, changed, self.ids)

    def test_changed_model_or_settings_identity_rejected(self):
        changed = copy.deepcopy(self.after)
        changed["identity"]["settings"]["repeat"] = 2
        with self.assertRaisesRegex(ValueError, "identity"):
            live.verify_resumed(self.before, changed, self.ids)

    def test_missing_duplicate_or_reordered_outputs_rejected(self):
        for rows in (self.after["segments"][:2], self.after["segments"][::-1],
            [*self.after["segments"][:2], self.after["segments"][1]]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                live.verify_resumed(self.before, dict(self.after, segments=rows), self.ids)

    def test_wrong_resume_start_rejected(self):
        after = copy.deepcopy(self.after)
        after["invocations"][-1]["resumedAtCompletedInvocations"] = 0
        with self.assertRaisesRegex(ValueError, "committed prefix"):
            live.verify_resumed(self.before, after, self.ids)

    def test_wrong_output_text_hash_rejected(self):
        changed = copy.deepcopy(self.after)
        changed["segments"][-1]["text"] = "Изменённый текст."
        with self.assertRaisesRegex(ValueError, "text hash"):
            live.verify_resumed(self.before, changed, self.ids)

    def test_checkpoint_checksum_and_size_guard(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "checkpoint.json"
            live.bench.save_report(path, copy.deepcopy(self.before))
            self.assertEqual(live.read_checkpoint(path)["segments"], self.before["segments"])
            raw = json.loads(path.read_text(encoding="utf-8")); raw["status"] = "changed"
            path.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "checksum"):
                live.read_checkpoint(path)


class IsolationTests(unittest.TestCase):
    def test_only_exact_owned_container_namespace_accepted(self):
        for name in ("production", "gargantua-s5-production", "gargantua-s5-opus-resume-../../app", "gargantua-s5-opus-resume-0011"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                live.owned(name)

    def test_arguments_pin_image_no_network_and_narrow_mounts(self):
        argv = live.docker_args("gargantua-s5-opus-resume-001122334455", Path("C:/pilot/results"))
        self.assertEqual(argv[argv.index("--network") + 1], "none")
        self.assertIn(live.CPU_IMAGE, argv)
        self.assertNotIn("--gpus", argv)
        self.assertNotIn("--privileged", argv)
        self.assertNotIn("--publish", argv)
        mounts = [argv[n + 1] for n, value in enumerate(argv) if value == "--mount"]
        self.assertEqual(len(mounts), 4)
        self.assertEqual(sum(x.endswith(",readonly") for x in mounts), 3)
        self.assertTrue(any("target=/out" in x and not x.endswith(",readonly") for x in mounts))
        self.assertFalse(any("docker.sock" in x for x in mounts))

    def test_resume_argument_is_the_only_benchmark_recipe_change(self):
        name = "gargantua-s5-opus-resume-001122334455"
        original = live.docker_args(name, Path("C:/pilot/results"))
        resumed = live.docker_args(name, Path("C:/pilot/results"), resume=True)
        self.assertEqual(resumed, [*original, "--resume"])

    def test_mount_delimiters_and_output_escape_rejected(self):
        for path in ("C:/data,other", "C:/data\nother"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                live.checked_mount(path)
        for path in (".local/s5-pilot/downloads/new", ".local/s5-pilot/../escape", "production/data"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                live.checked_case(Path(path))


if __name__ == "__main__": unittest.main()
