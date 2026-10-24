import copy
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import bench


class CorpusTests(unittest.TestCase):
    def test_original_corpus_unique_references_and_fact_review(self):
        corpus, digest = bench.load_corpus(Path(__file__).with_name("corpus.json"))
        self.assertEqual(len(corpus["segments"]), 16)
        self.assertEqual(len(digest), 64)
        self.assertEqual(sum(s["language"] == "en" for s in corpus["segments"]), 12)
        for segment in corpus["segments"]:
            self.assertGreaterEqual(len(segment["facts"]), 2)
            self.assertGreaterEqual(len(segment["reviewRisks"]), 2)

    def test_duplicate_corpus_ids_rejected(self):
        corpus = json.loads(Path(__file__).with_name("corpus.json").read_text(encoding="utf-8"))
        corpus["segments"][1]["id"] = corpus["segments"][0]["id"]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "corpus.json"
            path.write_text(json.dumps(corpus), encoding="utf-8")
            with self.assertRaises(ValueError):
                bench.load_corpus(path)


class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.model = self.root / "model"
        self.model.mkdir()
        (self.model / "weights.safetensors").write_bytes(b"not executed by test")
        self.lock = {"models": [{"id": "fixture", "files": [{"path": "weights.safetensors", "bytes": 20, "sha256": hashlib.sha256(b"not executed by test").hexdigest()}]}]}

    def tearDown(self):
        self.tmp.cleanup()

    def test_pinned_bytes_are_verified(self):
        _, files = bench.verify_model(self.lock, "fixture", self.model)
        self.assertEqual(len(files), 1)

    def test_same_size_mutation_rejected(self):
        (self.model / "weights.safetensors").write_bytes(b"not executed by TEST")
        with self.assertRaises(ValueError):
            bench.verify_model(self.lock, "fixture", self.model)

    def test_missing_artifact_rejected(self):
        (self.model / "weights.safetensors").unlink()
        with self.assertRaises(ValueError):
            bench.verify_model(self.lock, "fixture", self.model)

    def test_pickle_and_remote_python_rejected(self):
        for name in ("pytorch_model.bin", "model.py"):
            with self.subTest(name=name):
                file = self.model / name
                file.write_text("untrusted", encoding="utf-8")
                with self.assertRaises(ValueError):
                    bench.verify_model(self.lock, "fixture", self.model)
                file.unlink()

    def test_path_escape_rejected(self):
        (self.root / "outside").write_bytes(b"not executed by test")
        lock = copy.deepcopy(self.lock)
        lock["models"][0]["files"][0]["path"] = "../outside"
        with self.assertRaises(ValueError):
            bench.verify_model(lock, "fixture", self.model)


class DiagnosticTests(unittest.TestCase):
    def test_overlap_exact_identity_and_disagreement(self):
        self.assertEqual(bench.reference_overlap("Тихая ночь.", "Тихая ночь."), 100)
        self.assertLess(bench.reference_overlap("Wrong text", "Тихая ночь."), 10)

    def test_truncation_and_russian_warning_dont_claim_semantic_quality(self):
        row = bench.diagnostics({"text": "Original source sentence", "reference": "Оригинал", "digitTokens": ["4"]}, "ACCESS GRANTED", "length")
        self.assertIn("output-cap-hit", row["flags"])
        self.assertIn("low-russian-letter-ratio", row["flags"])
        self.assertEqual(row["missingDigitForms"], ["4"])
        self.assertIn("semantic review", row["warning"])

    def test_atomic_report_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "report.json"
            bench.atomic_json(path, {"text": "Русский текст"})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["text"], "Русский текст")
            self.assertFalse(path.with_suffix(".json.tmp").exists())


class HoldoutTests(unittest.TestCase):
    def test_holdout_loads_without_references_and_context_never_looks_ahead(self):
        corpus, _ = bench.load_corpus(Path(__file__).parents[1] / "holdout-inputs.json")
        self.assertEqual(len(corpus["segments"]), 8)
        self.assertFalse(any("reference" in row for row in corpus["segments"]))
        self.assertEqual(corpus["segments"][0]["previousSourceContext"], [])
        self.assertEqual([row["id"] for row in corpus["segments"][1]["previousSourceContext"]], ["bells-1"])
        self.assertEqual(corpus["segments"][2]["previousSourceContext"], [])
        self.assertEqual(corpus["segments"][4]["glossary"]["Ash"], "Ясень")

    def test_no_reference_means_no_overlap_metric(self):
        diagnostic = bench.diagnostics({"text": "The rain stopped."}, "Дождь закончился.", "stop")
        self.assertFalse(diagnostic["referenceAvailable"])
        self.assertNotIn("referenceCharNgramF1Diagnostic", diagnostic)

    def test_context_is_explicit_separate_and_changes_prompt_identity(self):
        args = SimpleNamespace(model_id="fixture", glossary=False, context=False, max_output_tokens=384)
        segment = {"language": "en", "text": "Current source.", "reference": "NEVER FEED THIS", "previousSourceContext": [{"id": "prior-1", "text": "Previous source."}]}
        baseline = bench.llama_body(segment, args)
        self.assertNotIn("Previous source.", json.dumps(baseline))
        args.context = True
        context = bench.llama_body(segment, args)
        self.assertIn("Previous source.", json.dumps(context))
        self.assertNotIn("NEVER FEED THIS", json.dumps(context))
        self.assertNotEqual(bench.canonical_digest(baseline), bench.canonical_digest(context))
        self.assertIn("Translate only sourceText", context["messages"][0]["content"])


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "checkpoint.json"
        self.identity = {"model": {"revision": "immutable-model"}, "corpusSha256": "corpus-sha", "settings": {"repeat": 2}, "runnerSha256": "runner-sha"}
        self.segments = [{"id": "test-1", "language": "en", "text": "The first rain."}, {"id": "test-2", "language": "en", "text": "The second rain."}]
        self.plan = [(row, index) for index in (1, 2) for row in self.segments]
        self.fresh = {"status": "running", "segments": [], "errors": []}

    def tearDown(self):
        self.tmp.cleanup()

    def create(self):
        report = bench.prepare_checkpoint(self.path, False, self.identity, copy.deepcopy(self.fresh), self.plan)
        bench.save_report(self.path, report)
        return report

    def test_existing_output_requires_explicit_resume(self):
        self.create()
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            bench.prepare_checkpoint(self.path, False, self.identity, self.fresh, self.plan)
        self.assertEqual(self.path.read_bytes(), before)

    def test_completed_output_never_overwritten(self):
        report = self.create()
        report["status"] = "completed"
        bench.save_report(self.path, report)
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            bench.prepare_checkpoint(self.path, True, self.identity, self.fresh, self.plan)
        self.assertEqual(self.path.read_bytes(), before)

    def test_each_identity_component_mismatch_rejected(self):
        self.create()
        for field in self.identity:
            with self.subTest(field=field):
                changed = copy.deepcopy(self.identity)
                changed[field] = "different"
                with self.assertRaisesRegex(ValueError, "identity mismatch"):
                    bench.prepare_checkpoint(self.path, True, changed, self.fresh, self.plan)

    def test_mutated_checkpoint_rejected_even_when_parseable(self):
        self.create()
        data = json.loads(self.path.read_text(encoding="utf-8"))
        data["errors"].append({"message": "mutation"})
        self.path.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "integrity mismatch"):
            bench.prepare_checkpoint(self.path, True, self.identity, self.fresh, self.plan)

    def test_nonprefix_row_rejected(self):
        report = self.create()
        report["segments"].append({"id": "test-2", "repeatIndex": 1, "status": "unsupported-language"})
        bench.save_report(self.path, report)
        with self.assertRaisesRegex(ValueError, "ordered prefix"):
            bench.prepare_checkpoint(self.path, True, self.identity, self.fresh, self.plan)

    def test_interrupted_run_resumes_only_remaining_repeats_and_counts_unique_texts(self):
        report = self.create()
        args = SimpleNamespace(context=False)
        class FixtureEngine:
            def __init__(self, fail_second=False):
                self.calls = []
                self.fail_second = fail_second
            def translate(self, segment, args):
                self.calls.append(segment["id"])
                if self.fail_second and len(self.calls) == 2:
                    raise RuntimeError("fixture interrupted")
                return {"text": "Шёл дождь.", "wallSeconds": 1.0, "cpuSeconds": .5, "finishReason": "stop"}
        first = FixtureEngine(True)
        with self.assertRaises(RuntimeError):
            bench.run_remaining(report, self.plan, first, args, self.path)
        resumed = bench.prepare_checkpoint(self.path, True, self.identity, self.fresh, self.plan)
        second = FixtureEngine()
        bench.run_remaining(resumed, self.plan, second, args, self.path)
        self.assertEqual(second.calls, ["test-2", "test-1", "test-2"])
        self.assertEqual([row["repeatIndex"] for row in resumed["segments"]], [1, 1, 2, 2])
        summary = bench.summarize(resumed)
        self.assertEqual(summary["generatedInvocations"], 4)
        self.assertEqual(summary["uniqueGeneratedSegments"], 2)
        self.assertEqual(len(summary["byRepeat"]), 2)
        self.assertIsNone(summary["referenceCharNgramF1DiagnosticMean"])


if __name__ == "__main__":
    unittest.main()
