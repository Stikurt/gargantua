import copy
import json
from pathlib import Path
import unittest
from unittest import mock

import sentence_bench
import sentence_catalog


class SentenceCoverageTests(unittest.TestCase):
    def test_shallow_sandbox_module_import_never_resolves_host_repository(self):
        source = Path(sentence_catalog.__file__).read_text(encoding="utf-8")
        namespace = {"__file__": "/pilot/translation/sentence_catalog.py", "__name__": "sandbox_catalogue_validation"}
        with mock.patch("pathlib.Path.resolve", side_effect=AssertionError("No repository resolution allowed during import")):
            exec(compile(source, namespace["__file__"], "exec"), namespace)
            self.assertEqual(namespace["validate_intervals"]("abc", [{"startByte": 0, "endByte": 3, "kind": "translate"}]), b"abc")

    def test_catalogue_covers_every_source_byte_once_and_is_frozen(self):
        root = sentence_catalog.workspace_root()
        lock = json.loads(Path(sentence_catalog.__file__).with_name("sentence-catalog.lock.json").read_text(encoding="utf-8"))
        count = 0
        for corpus in lock["corpora"]:
            raw = (root / corpus["path"]).read_bytes()
            rows = sentence_catalog.source_segments(json.loads(raw))
            entries = sentence_bench.verify_catalog(lock, raw, corpus["path"], rows)
            by_id = {row["id"]: row for row in rows}
            for entry in entries:
                source = by_id[entry["id"]]["text"]
                source_raw = source.encode("utf-8")
                translations = [source_raw[span["startByte"]:span["endByte"]].decode("utf-8") for span in entry["intervals"] if span["kind"] == "translate"]
                self.assertEqual(sentence_bench.reconstruct(source, entry["intervals"], translations), source)
                count += len(translations)
        self.assertEqual(count, lock["translationUnits"])
        self.assertEqual(count, 59)

    def test_negative_gap_overlap_and_uncovered_suffix_refused(self):
        for intervals in ([{"startByte": -1, "endByte": 3, "kind": "translate"}], [{"startByte": 1, "endByte": 3, "kind": "translate"}], [{"startByte": 0, "endByte": 2, "kind": "translate"}], [{"startByte": 0, "endByte": 2, "kind": "translate"}, {"startByte": 1, "endByte": 3, "kind": "translate"}]):
            with self.subTest(intervals=intervals), self.assertRaises(ValueError):
                sentence_catalog.validate_intervals("abc", intervals)

    def test_utf8_code_point_split_and_content_as_whitespace_refused(self):
        with self.assertRaises(ValueError):
            sentence_catalog.validate_intervals("éx", [{"startByte": 0, "endByte": 1, "kind": "translate"}, {"startByte": 1, "endByte": 3, "kind": "translate"}])
        with self.assertRaises(ValueError):
            sentence_catalog.validate_intervals("abc", [{"startByte": 0, "endByte": 3, "kind": "whitespace"}])

    def test_abbreviations_decimals_and_titles_are_not_split_by_regex(self):
        text = "Dr. Hart measured 0.4 litres near St. Anne's gate. He waited."
        intervals = sentence_catalog.reviewed_intervals(text, ["Anne's gate."])
        translated = [text.encode()[row["startByte"]:row["endByte"]].decode() for row in intervals if row["kind"] == "translate"]
        self.assertEqual(len(translated), 2)
        self.assertTrue(translated[0].startswith("Dr. Hart measured 0.4 litres"))
        self.assertIn("St. Anne's", translated[0])

    def test_paragraph_whitespace_preserved_and_partial_output_refused(self):
        source = "First sentence.\n\nSecond sentence."
        intervals = sentence_catalog.reviewed_intervals(source, ["First sentence."])
        self.assertEqual(sentence_bench.reconstruct(source, intervals, ["Первое предложение.", "Второе предложение."]), "Первое предложение.\n\nВторое предложение.")
        with self.assertRaises(ValueError):
            sentence_bench.reconstruct(source, intervals, ["Только одно."])

    def test_references_and_context_never_enter_model_input_and_nonenglish_refused(self):
        safe = sentence_bench.model_input("Quoted fiction.", "en")
        self.assertEqual(set(safe), {"id", "language", "text"})
        self.assertNotIn("reference", safe)
        with self.assertRaises(ValueError):
            sentence_bench.model_input("源文本", "zh")

    def test_source_mutation_invalidates_frozen_catalogue(self):
        lock = json.loads(Path(sentence_catalog.__file__).with_name("sentence-catalog.lock.json").read_text(encoding="utf-8"))
        corpus = lock["corpora"][0]
        raw = (sentence_catalog.workspace_root() / corpus["path"]).read_bytes()
        rows = sentence_catalog.source_segments(json.loads(raw))
        with self.assertRaises(ValueError):
            sentence_bench.verify_catalog(lock, raw+b" ", corpus["path"], rows)
        changed = copy.deepcopy(rows)
        changed[0]["text"] += " changed"
        with self.assertRaises(ValueError):
            sentence_bench.verify_catalog(lock, raw, corpus["path"], changed)


if __name__ == "__main__":
    unittest.main()
