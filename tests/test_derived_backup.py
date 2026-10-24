"""Offline derivative snapshot tests: synthetic text/PCM only, no model or DB.

The successful fixture is also checked against the actual Node segmentation
contract, so backup coverage is not inferred from a self-consistent fake hash.
"""
import copy
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("derived_backup_base", ROOT / "tests/test_backup_artifacts.py")
BASE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BASE)
B = BASE.backup


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else B.canonical_json(value).encode()).hexdigest()


def identity(number):
    return "70000000-0000-4000-8000-" + str(number).zfill(12)


def pcm_bytes():
    frames = 2205
    samples = b"".join(struct.pack("<h", round(math.sin(i / 16) * 1000)) for i in range(frames))
    return b"RIFF" + struct.pack("<I", 36 + len(samples)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 22050, 44100, 2, 16) + b"data" + struct.pack("<I", len(samples)) + samples


class DerivedBackupTests(unittest.TestCase):
    def setUp(self):
        self.base = BASE.BackupArtifactTests()
        self.base.setUp()
        self.snapshot = self.base.snapshot
        self.inventory = self.base.inventory
        self.inventory.update(derivedSupported=True, derivedMetadataFormat="source-jsonl-v1")
        self.book = self.inventory["tables"]["books"][0]
        work_id, expression_id, edition_id = identity(1), identity(2), identity(3)
        self.book.update(work_id=work_id, expression_id=expression_id, edition_id=edition_id, security_state="passed")
        self.seal_book(self.book, self.base.content)
        self.meta = {name: [] for name in B.DERIVED_METADATA_TABLES}
        self.meta["works"] = [{"id": work_id, "title": self.base.content["title"]}]
        self.meta["expressions"] = [{"id": expression_id, "work_id": work_id, "kind": "original", "source_expression_id": None}]
        self.meta["editions"] = [{"id": edition_id, "expression_id": expression_id}]
        recipe = {"kind": "audio", "language": "ru", "manifest": {"profile": "offline-fixture", "profileSha256": "c" * 64, "segmentationRevision": "derived-unicode-v1"}}
        self.recipe_sha = digest(recipe)
        self.meta["derived_recipes"] = [{"sha256": self.recipe_sha, **recipe}]
        source = {"schemaVersion": 1, "sourceLanguage": "ru", "workId": work_id, "expressionId": expression_id, "snapshotId": None,
                  "parts": [{"ordinal": 0, "publicationId": self.book["id"], "editionId": edition_id, "publicationSha256": self.book["publication_sha256"], "packageSha256": self.book["package_sha256"], "chapterCount": 1}]}
        self.source_sha = digest(source)
        self.source = {"sha256": self.source_sha, "work_id": work_id, "expression_id": expression_id, "snapshot_id": None, "manifest": source}
        self.meta["derived_sources"] = [self.source]
        self.meta["derived_source_parts"] = [{"source_sha256": self.source_sha, "ordinal": 0, "book_id": self.book["id"], "expression_id": expression_id, "edition_id": edition_id, "publication_sha256": self.book["publication_sha256"], "package_sha256": self.book["package_sha256"]}]
        self.job_id, self.attempt_id, self.request_id = identity(4), identity(5), identity(6)
        plan = B.derived_plan(self.source, "audio", self.snapshot / "books")
        count = len(plan["segments"])
        self.job = {"id": self.job_id, "kind": "audio", "source_sha256": self.source_sha, "recipe_sha256": self.recipe_sha, "status": "completed", "plan": plan, "plan_sha256": digest(plan), "total_segments": count, "completed_segments": count, "attempt_token": self.attempt_id, "lease_expires_at": None}
        self.meta["derived_jobs"] = [self.job]
        self.meta["derived_attempts"] = [{"token": self.attempt_id, "job_id": self.job_id, "number": 1, "state": "finished"}]
        self.meta["derived_requests"] = [{"id": self.request_id, "job_id": self.job_id, "requested_by": BASE.PROFILE, "approved_by": BASE.PROFILE, "decision_reason": "role-auto-approval", "status": "completed", "parent_job_id": None, "parent_request_id": None}]
        self.meta["derived_idempotency"] = [{"profile_id": BASE.PROFILE, "key": identity(7), "request_id": self.request_id, "body_sha256": "f" * 64}]
        raw = pcm_bytes()
        self.raw = raw
        self.derived_root = self.snapshot / "derived"
        self.segments = []
        for ordinal, unit in enumerate(plan["segments"]):
            file = {"path": self.attempt_id + "/" + str(ordinal).zfill(6) + ".wav", "sha256": digest(raw), "bytes": len(raw), "mediaType": "audio/wav"}
            manifest = {"schemaVersion": 1, "jobId": self.job_id, "attemptId": self.attempt_id, "ordinal": ordinal, "kind": "audio", "inputSha256": unit["sourceSha256"], "recipeSha256": self.recipe_sha, "profileSha256": "c" * 64, "file": file,
                        "pcm": {"frames": 2205, "sampleRate": 22050, "channels": 1, "sampleWidth": 2, "durationSeconds": 0.1},
                        "scan": {"version": "ClamAV synthetic fixture", "checkedAt": "2026-10-23T01:00:00.000Z", "sha256": digest(raw)}, "quality": "technical-unlistened"}
            self.segments.append(manifest)
            self.meta["derived_checkpoints"].append({"job_id": self.job_id, "ordinal": ordinal, "attempt_token": self.attempt_id, "source_sha256": unit["sourceSha256"], "output_sha256": digest(raw), "output_bytes": len(raw), "manifest": manifest})
            file_path = self.derived_root / self.job_id / file["path"]
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_bytes(raw)
        final = {"schemaVersion": 1, "jobId": self.job_id, "kind": "audio", "sourceSha256": self.source_sha, "recipeSha256": self.recipe_sha, "quality": "technical-unlistened", "segments": self.segments}
        self.final_path = self.derived_root / self.job_id / "manifest.json"
        self.final_path.write_text(B.canonical_json(final), encoding="utf-8")
        self.result = {"job_id": self.job_id, "work_id": work_id, "expression_id": expression_id, "edition_id": edition_id, "manifest": final, "sha256": digest(self.final_path.read_bytes()), "bytes": self.final_path.stat().st_size}
        self.meta["derived_results"] = [self.result]
        self.write_inputs()

    def tearDown(self):
        self.base.tearDown()

    def write_inputs(self):
        BASE.write(self.snapshot / "db-inventory.json", self.inventory)
        rows = {**self.inventory["tables"], **self.meta, **getattr(self, "ranobe_meta", {})}
        self.fingerprints = {name: {"table": name, "count": len(items), "fingerprint": hashlib.md5(name.encode()).hexdigest()} for name, items in rows.items()}
        (self.snapshot / "db-table-fingerprints.jsonl").write_text("\n".join(json.dumps(row) for row in self.fingerprints.values()), encoding="utf-8")
        self.sidecar = self.snapshot / "derived-metadata.jsonl"
        self.sidecar.write_text("".join(json.dumps({"table": name, "row": row}, ensure_ascii=False) + "\n" for name, rows in self.meta.items() for row in rows), encoding="utf-8")
        if hasattr(self, "ranobe_meta"):
            self.ranobe_sidecar = self.snapshot / "ranobe-metadata.jsonl"
            self.ranobe_sidecar.write_text("".join(json.dumps({"table": name, "row": row}, ensure_ascii=False) + "\n" for name, rows in self.ranobe_meta.items() for row in rows), encoding="utf-8")

    def seal_book(self, row, book):
        path = self.snapshot / "books" / row["id"] / "book.json"
        raw = path.read_bytes()
        entry = {"path": "book.json", "bytes": len(raw), "sha256": digest(raw)}
        artifact = {"schemaVersion": 1, "files": [entry]}
        row.update(content_sha256=digest(raw), content_bytes=len(raw), artifact_manifest=artifact, package_sha256=hashlib.sha256(json.dumps(artifact, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest())
        program = """import{makePublicationManifest,canonicalJson,sha256}from'./server/publication-model.mjs';let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data),manifest=makePublicationManifest(input.row,input.book);process.stdout.write(JSON.stringify({manifest,sha256:sha256(Buffer.from(canonicalJson(manifest)))}));"""
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", program], cwd=ROOT, input=json.dumps({"row": row, "book": book}, ensure_ascii=False), capture_output=True, text=True, encoding="utf-8", timeout=20, check=True)
        checked = json.loads(result.stdout)
        row.update(publication_manifest=checked["manifest"], publication_sha256=checked["sha256"])

    def validate(self):
        self.write_inputs()
        return B.validate_derived(self.derived_root, self.inventory, self.sidecar, self.fingerprints)

    def translation_fixture(self, original=None):
        original = copy.deepcopy(self.base.content if original is None else original)
        original["language"] = "en"
        BASE.write(self.snapshot / "books" / self.book["id"] / "book.json", original)
        self.seal_book(self.book, original)
        for key in ("publication_sha256", "package_sha256"):
            self.meta["derived_source_parts"][0][key] = self.book[key]
        self.source["manifest"]["parts"][0].update(publicationSha256=self.book["publication_sha256"], packageSha256=self.book["package_sha256"])
        self.source["manifest"]["sourceLanguage"] = "en"
        self.source_sha = self.source["sha256"] = digest(self.source["manifest"])
        self.meta["derived_source_parts"][0]["source_sha256"] = self.source_sha
        recipe = {"kind": "translation", "language": "ru", "manifest": {"profile": "synthetic-translation", "profileSha256": "c" * 64, "segmentationRevision": "derived-unicode-v1"}}
        self.recipe_sha = digest(recipe)
        self.meta["derived_recipes"] = [{"sha256": self.recipe_sha, **recipe}]
        plan = B.derived_plan(self.source, "translation", self.snapshot / "books")
        self.job.update(kind="translation", source_sha256=self.source_sha, recipe_sha256=self.recipe_sha, plan=plan, plan_sha256=digest(plan), total_segments=len(plan["segments"]), completed_segments=len(plan["segments"]))
        derivation = {"schemaVersion": 1, "kind": "machine-translation", "quality": "machine-draft", "sourceSha256": self.source_sha, "recipeSha256": self.recipe_sha, "jobId": self.job_id}
        node = shutil.which("node")
        program = """import{makeDerivedPlan,translatedBooks}from'./server/derived-plan.mjs';let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data),plan=makeDerivedPlan(input.source,[input.book],'translation').manifest,outputs=plan.segments.map(unit=>'Перевод '+unit.ordinal);process.stdout.write(JSON.stringify(translatedBooks(input.source,[input.book],plan,outputs,input.derivation)[0]));"""
        result = subprocess.run([node, "--input-type=module", "-e", program], cwd=ROOT, input=json.dumps({"source": {"sha256": self.source_sha, "parts": [{"id": self.book["id"]}], "manifest": self.source["manifest"]}, "book": original, "derivation": derivation}, ensure_ascii=False), capture_output=True, text=True, encoding="utf-8", timeout=20, check=True)
        translated = json.loads(result.stdout)
        selected = self.source["manifest"]["schemaVersion"] == 2
        self.translation_id = B.derived_uuid("translated-book|" + self.job_id + "|0") if selected else identity(90)
        translation_import, translation_expression, translation_edition = identity(91), identity(92), identity(93)
        if selected:
            translation_edition = B.derived_uuid("translated-edition|" + self.job_id + "|0")
        self.translation_path = self.snapshot / "books" / self.translation_id / "book.json"
        BASE.write(self.translation_path, translated)
        self.translation_row = {"id": self.translation_id, "import_id": translation_import, "requested_by": BASE.PROFILE, "chapter_count": len(translated["chapters"]), "work_id": self.book["work_id"], "expression_id": translation_expression, "edition_id": translation_edition, "security_state": "passed"}
        self.seal_book(self.translation_row, translated)
        self.inventory["tables"]["books"].append(self.translation_row)
        self.inventory["tables"]["imports"].append({"id": translation_import, "requested_by": BASE.PROFILE, "approved_by": BASE.PROFILE, "book_id": self.translation_id})
        self.meta["expressions"].append({"id": translation_expression, "work_id": self.book["work_id"], "kind": "machine-translation", "source_expression_id": self.book["expression_id"]})
        self.meta["editions"].append({"id": translation_edition, "expression_id": translation_expression})
        self.meta["derived_checkpoints"] = []
        self.segments = []
        for ordinal, unit in enumerate(plan["segments"]):
            raw = ("Перевод " + str(ordinal)).encode()
            file = {"path": self.attempt_id + "/" + str(ordinal).zfill(6) + ".txt", "sha256": digest(raw), "bytes": len(raw), "mediaType": "text/plain; charset=utf-8"}
            path = self.derived_root / self.job_id / file["path"]
            path.write_bytes(raw)
            segment = {"schemaVersion": 1, "jobId": self.job_id, "attemptId": self.attempt_id, "ordinal": ordinal, "kind": "translation", "inputSha256": unit["sourceSha256"], "recipeSha256": self.recipe_sha, "profileSha256": "c" * 64, "file": file, "scan": {"version": "ClamAV synthetic fixture", "checkedAt": "2026-10-23T01:00:00.000Z", "sha256": digest(raw)}, "quality": "machine-draft"}
            self.segments.append(segment)
            self.meta["derived_checkpoints"].append({"job_id": self.job_id, "ordinal": ordinal, "attempt_token": self.attempt_id, "source_sha256": unit["sourceSha256"], "output_sha256": digest(raw), "output_bytes": len(raw), "manifest": segment})
        manifest = {"schemaVersion": 1, "jobId": self.job_id, "kind": "translation", "sourceSha256": self.source_sha, "recipeSha256": self.recipe_sha, "quality": "machine-draft", "segments": self.segments, "publicationIds": [self.translation_id]}
        self.final_path.write_text(B.canonical_json(manifest), encoding="utf-8")
        self.result.update(expression_id=translation_expression, edition_id=translation_edition, manifest=manifest, sha256=digest(self.final_path.read_bytes()), bytes=self.final_path.stat().st_size)
        self.write_inputs()

    def test_complete_synthetic_audio_snapshot_finalizes_and_restores_all_files(self):
        result = B.finalize(self.snapshot)
        self.assertEqual(result["library"]["derivedJobsChecked"], 1)
        self.assertEqual(result["library"]["derivedCheckpointsChecked"], len(self.segments))
        restored = self.base.root / "restored"
        shutil.copytree(self.snapshot, restored)
        inventory = copy.deepcopy(self.inventory)
        inventory["sessionRows"] = 0
        BASE.write(restored / "db-inventory.json", inventory)
        result = B.compare_restore(self.snapshot, restored, restored / "books")
        self.assertEqual(result["library"]["derivedResultsChecked"], 1)

    def test_real_node_translation_package_and_original_are_saved_as_separate_publications(self):
        self.translation_fixture()
        original = (self.snapshot / "books" / self.book["id"] / "book.json").read_bytes()
        report = B.finalize(self.snapshot)
        self.assertEqual(report["library"]["derivedResultsChecked"], 1)
        self.assertEqual(report["library"]["books"], 2)
        self.assertEqual((self.snapshot / "books" / self.book["id"] / "book.json").read_bytes(), original)

    def test_translated_package_provenance_must_match_exact_job_recipe(self):
        self.translation_fixture()
        content = json.loads(self.translation_path.read_text(encoding="utf-8"))
        content["derivation"]["recipeSha256"] = "0" * 64
        BASE.write(self.translation_path, content)
        self.seal_book(self.translation_row, content)
        with self.assertRaisesRegex(ValueError, "provenance differs"):
            self.validate()

    def selected_source_fixture(self):
        original = copy.deepcopy(self.base.content)
        original["chapters"] = [{"title": "Original chapter " + str(index + 1), "blocks": [{"type": "text", "text": "\ufeff Original body " + str(index + 1) + ". 😀\n"}]} for index in range(3)]
        self.book["chapter_count"] = 3
        BASE.write(self.snapshot / "books" / self.book["id"] / "book.json", original)
        self.seal_book(self.book, original)
        self.source["manifest"]["parts"][0].update(chapterCount=3, publicationSha256=self.book["publication_sha256"], packageSha256=self.book["package_sha256"])
        self.source["manifest"].update(schemaVersion=2, selection={"schemaVersion": 1, "start": 2, "count": 1, "total": 3, "chapters": [{"ordinal": 1, "partIndex": 0, "publicationId": self.book["id"], "chapterIndex": 1, "chapterId": "c-1"}]})
        for key in ("publication_sha256", "package_sha256"):
            self.meta["derived_source_parts"][0][key] = self.book[key]
        self.rehash_selected_source()
        return original

    def rehash_selected_source(self):
        self.source_sha = self.source["sha256"] = digest(self.source["manifest"])
        self.meta["derived_source_parts"][0]["source_sha256"] = self.source_sha
        self.job["source_sha256"] = self.source_sha
        self.result["manifest"]["sourceSha256"] = self.source_sha

    def test_selected_audio_snapshot_restores_exact_chapter_and_preserves_the_whole_original(self):
        self.selected_source_fixture()
        original = (self.snapshot / "books" / self.book["id"] / "book.json").read_bytes()
        self.packed_audio_fixture()
        self.assertEqual({unit["chapterIndex"] for unit in self.job["plan"]["segments"]}, {1})
        self.assertEqual(self.validate()["derivedResultsChecked"], 1)
        self.assertEqual(B.finalize(self.snapshot)["library"]["derivedResultsChecked"], 1)
        restored = self.base.root / "selected-audio-restored"
        shutil.copytree(self.snapshot, restored)
        inventory = copy.deepcopy(self.inventory)
        inventory["sessionRows"] = 0
        BASE.write(restored / "db-inventory.json", inventory)
        self.assertEqual(B.compare_restore(self.snapshot, restored, restored / "books")["library"]["derivedResultsChecked"], 1)
        self.assertEqual((restored / "books" / self.book["id"] / "book.json").read_bytes(), original)

    def test_selected_translation_is_compact_and_independently_reconstructed_before_restore(self):
        original = self.selected_source_fixture()
        self.translation_fixture(original)
        package = json.loads(self.translation_path.read_text(encoding="utf-8"))
        self.assertEqual(len(package["chapters"]), 1)
        self.assertEqual(package["structure"]["chapters"][0]["id"], "c-1")
        self.assertIn("главы 2–2", package["title"])
        self.assertEqual(self.validate()["derivedResultsChecked"], 1)
        self.assertEqual(B.finalize(self.snapshot)["library"]["derivedResultsChecked"], 1)
        restored = self.base.root / "selected-translation-restored"
        shutil.copytree(self.snapshot, restored)
        inventory = copy.deepcopy(self.inventory)
        inventory["sessionRows"] = 0
        BASE.write(restored / "db-inventory.json", inventory)
        self.assertEqual(B.compare_restore(self.snapshot, restored, restored / "books")["library"]["derivedResultsChecked"], 1)

    def selected_ranobe_snapshot_fixture(self):
        original = self.selected_source_fixture()
        feed_id, parent_id, snapshot_id = identity(80), identity(81), identity(88)
        self.source["snapshot_id"] = self.source["manifest"]["snapshotId"] = snapshot_id
        self.rehash_selected_source()
        keys = ["ranobelib:123:branch:23137:v0:c" + str(i + 1) for i in range(3)]
        inventory = [{"key": key, "revisionHint": "1", "title": original["chapters"][i]["title"], "volume": "0", "number": str(i + 1)} for i, key in enumerate(keys)]
        self.inventory.update(ranobeSupported=True, ranobeMetadataFormat="source-jsonl-v1")
        self.inventory["tables"]["imports"][0].update(kind="ranobe-part", status="completed", security_state="passed", options={"ranobePart": {"parentId": parent_id, "runId": snapshot_id, "keys": keys}})
        self.inventory["tables"]["imports"].append({"id": parent_id, "requested_by": BASE.PROFILE, "approved_by": BASE.PROFILE, "book_id": self.book["id"], "kind": "ranobe", "status": "completed", "security_state": "passed", "options": {"mode": "full", "feedId": feed_id, "branch": 23137, "language": "ru"}})
        self.ranobe_meta = {name: [] for name in B.RANOBE_TABLES}
        self.ranobe_meta["ranobe_feeds"] = [{"id": feed_id, "provider": "ranobelib", "remote_id": "123", "branch_key": "23137", "slug": "123--synthetic-fixture", "language": "ru", "requested_by": BASE.PROFILE, "approved_by": BASE.PROFILE, "head_run_id": snapshot_id, "active_import_id": None}]
        self.ranobe_meta["ranobe_runs"] = [{"id": snapshot_id, "feed_id": feed_id, "import_id": parent_id, "status": "ready", "activated_at": "2026-10-23T01:00:00.000Z", "chapter_count": 3, "inventory_sha256": digest(inventory), "policy_version": 1}]
        for i, entry in enumerate(inventory):
            chapter_id = identity(100 + i)
            self.ranobe_meta["ranobe_chapters"].append({"id": chapter_id, "feed_id": feed_id, "source_key": entry["key"], "revision_hint": entry["revisionHint"], "policy_version": 1, "raw_sha256": "a" * 64, "content_sha256": B.chapter_fingerprint(original, i), "prepared_bytes": len(B.canonical_json(original).encode()), "prepared_present": False, "book_id": self.book["id"], "chapter_index": i})
            self.ranobe_meta["ranobe_run_chapters"].append({"run_id": snapshot_id, "feed_id": feed_id, "ordinal": i, "source_key": entry["key"], "revision_hint": entry["revisionHint"], "metadata": {key: entry[key] for key in ("title", "volume", "number")}, "chapter_id": chapter_id})
        self.ranobe_meta["ranobe_run_parts"] = [{"id": identity(89), "run_id": snapshot_id, "ordinal": 0, "import_id": BASE.IMPORT, "source_keys": keys, "keys_sha256": digest(keys), "status": "ready", "book_id": self.book["id"], "package_sha256": self.book["package_sha256"]}]
        self.packed_audio_fixture()
        B.finalize(self.snapshot)

    def narrow_restore_fixture(self):
        # Match verify-backup.ps1: only publication trees and restored database
        # inventories live here; trusted source sidecars stay in the snapshot.
        restored = self.base.root / "narrow-restored"
        restored.mkdir()
        for name in ("books", "derived"):
            shutil.copytree(self.snapshot / name, restored / name)
        shutil.copyfile(self.snapshot / "db-table-fingerprints.jsonl", restored / "db-table-fingerprints.jsonl")
        inventory = copy.deepcopy(self.inventory)
        inventory["sessionRows"] = 0
        BASE.write(restored / "db-inventory.json", inventory)
        return restored, inventory

    def test_selected_ranobe_restore_uses_trusted_snapshot_sidecars_in_narrow_restore_layout(self):
        self.selected_ranobe_snapshot_fixture()
        restored, _ = self.narrow_restore_fixture()
        self.assertEqual(self.source["manifest"]["schemaVersion"], 2)
        self.assertFalse((restored / "ranobe-metadata.jsonl").exists())
        self.assertFalse((restored / "derived-metadata.jsonl").exists())
        result = B.compare_restore(self.snapshot, restored, restored / "books")
        self.assertEqual(result["library"]["derivedResultsChecked"], 1)
        self.assertEqual(result["library"]["ranobeRunsChecked"], 1)
        self.assertEqual(result["library"]["ranobeCheckpointsChecked"], 3)

    def test_selected_ranobe_restore_cannot_substitute_a_restore_local_sidecar(self):
        self.selected_ranobe_snapshot_fixture()
        restored, _ = self.narrow_restore_fixture()
        (restored / "ranobe-metadata.jsonl").write_text("not trusted metadata\n", encoding="utf-8")
        self.assertEqual(B.compare_restore(self.snapshot, restored, restored / "books")["library"]["derivedResultsChecked"], 1)

    def test_selected_ranobe_restore_rejects_missing_trusted_sidecar_even_if_local_copy_exists(self):
        self.selected_ranobe_snapshot_fixture()
        restored, inventory = self.narrow_restore_fixture()
        shutil.copyfile(self.ranobe_sidecar, restored / "ranobe-metadata.jsonl")
        self.ranobe_sidecar.unlink()
        with self.assertRaisesRegex(ValueError, "sidecar is missing"):
            B.validate_derived(restored / "derived", inventory, self.sidecar, self.fingerprints)
        with self.assertRaises(FileNotFoundError):
            B.compare_restore(self.snapshot, restored, restored / "books")

    def test_selected_ranobe_restore_rejects_changed_trusted_snapshot_coverage(self):
        self.selected_ranobe_snapshot_fixture()
        restored, inventory = self.narrow_restore_fixture()
        shutil.copyfile(self.ranobe_sidecar, restored / "ranobe-metadata.jsonl")
        self.ranobe_meta["ranobe_run_parts"][0]["book_id"] = identity(999)
        self.write_inputs()
        with self.assertRaisesRegex(ValueError, "complete pinned Ranobe"):
            B.validate_derived(restored / "derived", inventory, self.sidecar, self.fingerprints)
        with self.assertRaisesRegex(ValueError, "hash/size differs"):
            B.compare_restore(self.snapshot, restored, restored / "books")

    def test_rehashed_selected_chapter_id_cannot_retarget_the_original(self):
        self.selected_source_fixture()
        self.packed_audio_fixture()
        self.source["manifest"]["selection"]["chapters"][0]["chapterId"] = "c-2"
        self.rehash_selected_source()
        with self.assertRaisesRegex(ValueError, "selected chapter identity"):
            self.validate()

    def test_a_resealed_compact_translation_cannot_insert_an_untranslated_chapter(self):
        original = self.selected_source_fixture()
        self.translation_fixture(original)
        package = json.loads(self.translation_path.read_text(encoding="utf-8"))
        package["chapters"].append(original["chapters"][0])
        package["structure"]["chapters"].append({"id": "c-0", "revision": 1, "title": original["chapters"][0]["title"], "blocks": [{"id": "c-0-b-0", "type": "paragraph", "text": original["chapters"][0]["blocks"][0]["text"]}]})
        self.translation_row["chapter_count"] = 2
        BASE.write(self.translation_path, package)
        self.seal_book(self.translation_row, package)
        with self.assertRaisesRegex(ValueError, "exact selected chapter output"):
            self.validate()

    def test_resealed_translated_text_still_must_equal_accepted_checkpoint_outputs(self):
        self.translation_fixture(self.selected_source_fixture())
        package = json.loads(self.translation_path.read_text(encoding="utf-8"))
        package["chapters"][0]["blocks"][0]["text"] = package["structure"]["chapters"][0]["blocks"][0]["text"] = "Подменённый перевод"
        BASE.write(self.translation_path, package)
        self.seal_book(self.translation_row, package)
        with self.assertRaisesRegex(ValueError, "exact selected chapter output"):
            self.validate()

    def test_legacy_source_cannot_gain_selection_semantics_after_rehashing(self):
        self.source["manifest"]["selection"] = {}
        self.rehash_selected_source()
        with self.assertRaisesRegex(ValueError, "Legacy derivative source"):
            self.validate()

    def test_offline_source_plan_matches_real_node_unicode_contract(self):
        node = shutil.which("node")
        self.assertTrue(node)
        program = """import{makeDerivedPlan}from'./server/derived-plan.mjs';let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data);process.stdout.write(JSON.stringify(makeDerivedPlan(input.source,input.books,'audio').manifest));"""
        original = copy.deepcopy(self.base.content)
        original["chapters"][0]["blocks"][0]["text"] = (" \ufeff😀 e\u0301 word\n" * 120) + "finish"
        BASE.write(self.snapshot / "books" / self.book["id"] / "book.json", original)
        actual = subprocess.run([node, "--input-type=module", "-e", program], cwd=ROOT, input=json.dumps({"source": {"sha256": self.source_sha, "parts": [{"id": self.book["id"]}]}, "books": [original]}, ensure_ascii=False), capture_output=True, text=True, encoding="utf-8", timeout=20, check=True)
        self.assertEqual(B.derived_plan(self.source, "audio", self.snapshot / "books"), json.loads(actual.stdout))

    def packed_audio_fixture(self):
        recipe = copy.deepcopy(self.meta["derived_recipes"][0])
        recipe["manifest"]["segmentationRevision"] = B.PACKED_AUDIO_SEGMENTATION
        recipe["sha256"] = self.recipe_sha = digest({key: recipe[key] for key in ("kind", "language", "manifest")})
        self.meta["derived_recipes"] = [recipe]
        plan = B.derived_plan(self.source, "audio", self.snapshot / "books", B.PACKED_AUDIO_SEGMENTATION)
        self.job.update(recipe_sha256=self.recipe_sha, plan=plan, plan_sha256=digest(plan), total_segments=len(plan["segments"]), completed_segments=len(plan["segments"]))
        template = copy.deepcopy(self.segments[0])
        self.segments = []
        self.meta["derived_checkpoints"] = []
        for ordinal, unit in enumerate(plan["segments"]):
            segment = copy.deepcopy(template)
            segment.update(ordinal=ordinal, inputSha256=unit["sourceSha256"], recipeSha256=self.recipe_sha)
            segment["file"]["path"] = self.attempt_id + "/" + str(ordinal).zfill(6) + ".wav"
            target = self.derived_root / self.job_id / segment["file"]["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self.raw)
            self.segments.append(segment)
            self.meta["derived_checkpoints"].append({"job_id": self.job_id, "ordinal": ordinal, "attempt_token": self.attempt_id, "source_sha256": unit["sourceSha256"], "output_sha256": digest(self.raw), "output_bytes": len(self.raw), "manifest": segment})
        final = self.result["manifest"]
        final.update(recipeSha256=self.recipe_sha, segments=self.segments)
        self.final_path.write_text(B.canonical_json(final), encoding="utf-8")
        self.result.update(sha256=digest(self.final_path.read_bytes()), bytes=self.final_path.stat().st_size)
        self.write_inputs()

    def test_packed_audio_restore_checks_complete_source_and_preserves_legacy_files(self):
        original = (self.snapshot / "books" / self.book["id"] / "book.json").read_bytes()
        self.packed_audio_fixture()
        self.assertEqual(self.job["total_segments"], 1)
        self.assertEqual(self.validate()["derivedResultsChecked"], 1)
        self.assertEqual((self.snapshot / "books" / self.book["id"] / "book.json").read_bytes(), original)
        self.write_inputs()
        self.assertEqual(B.finalize(self.snapshot)["library"]["derivedResultsChecked"], 1)

    def test_packed_offline_plan_matches_real_node_unicode_ranges_and_sentence_seams(self):
        original = copy.deepcopy(self.base.content)
        texts = ["А" * 390 + ". " + "Б" * 500, "  \ufeff😀 e\u0301 слово\n" * 130, " " * 1500 + "Слово." + " " * 1500] + [str(n) for n in range(1000)]
        original["chapters"][0]["blocks"] = [{"type": "text", "text": text} for text in texts]
        BASE.write(self.snapshot / "books" / self.book["id"] / "book.json", original)
        program = """import{makePackedAudioPlan}from'./server/derived-audio-plan.mjs';let data='';for await(const chunk of process.stdin)data+=chunk;const input=JSON.parse(data);process.stdout.write(JSON.stringify(makePackedAudioPlan(input.source,input.books).manifest));"""
        actual = subprocess.run([shutil.which("node"), "--input-type=module", "-e", program], cwd=ROOT, input=json.dumps({"source": {"sha256": self.source_sha, "parts": [{"id": self.book["id"]}]}, "books": [original]}, ensure_ascii=False), capture_output=True, text=True, encoding="utf-8", timeout=20, check=True)
        self.assertEqual(B.derived_plan(self.source, "audio", self.snapshot / "books", B.PACKED_AUDIO_SEGMENTATION), json.loads(actual.stdout))

    def test_rehashed_packed_plan_cannot_hide_range_omission_or_wrong_revision(self):
        self.packed_audio_fixture()
        self.job["plan"]["segments"][0]["ranges"][0]["start"] += 1
        self.job["plan_sha256"] = digest(self.job["plan"])
        with self.assertRaisesRegex(ValueError, "exact original"):
            self.validate()

    def test_unknown_or_wrong_kind_packed_segmentation_fails_closed(self):
        for kind, revision in [("translation", B.PACKED_AUDIO_SEGMENTATION), ("audio", "future-v9"), ("audio", None)]:
            with self.assertRaisesRegex(ValueError, "segmentation"):
                B.derived_plan(self.source, kind, self.snapshot / "books", revision)

    def test_support_flag_cannot_hide_fingerprinted_derived_tables(self):
        self.inventory["derivedSupported"] = False
        with self.assertRaisesRegex(ValueError, "support flag"):
            self.validate()

    def test_missing_sidecar_fails_before_backup_ready(self):
        self.sidecar.unlink()
        with self.assertRaises(ValueError):
            B.finalize(self.snapshot)

    def test_sidecar_omitted_record_count_is_rejected(self):
        self.sidecar.write_text(self.sidecar.read_text(encoding="utf-8").split("\n", 1)[1], encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "row count"):
            B.validate_derived(self.derived_root, self.inventory, self.sidecar, self.fingerprints)

    def test_partial_source_coverage_is_not_made_valid_by_rehashing_plan(self):
        self.job["plan"]["segments"].pop()
        self.job["total_segments"] -= 1
        self.job["plan_sha256"] = digest(self.job["plan"])
        with self.assertRaisesRegex(ValueError, "exact original"):
            self.validate()

    def test_changed_recipe_is_not_reused(self):
        self.meta["derived_recipes"][0]["manifest"]["profile"] = "different"
        with self.assertRaisesRegex(ValueError, "recipe identity"):
            self.validate()

    def test_source_part_hash_or_order_mismatch_is_rejected(self):
        self.meta["derived_source_parts"][0]["package_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "part hash"):
            self.validate()

    def test_full_ranobe_snapshot_cannot_be_reduced_to_its_first_part(self):
        snapshot_id = identity(88)
        self.inventory["ranobeSupported"] = True
        self.source["snapshot_id"] = self.source["manifest"]["snapshotId"] = snapshot_id
        self.source_sha = self.source["sha256"] = digest(self.source["manifest"])
        self.meta["derived_source_parts"][0]["source_sha256"] = self.source_sha
        self.job["source_sha256"] = self.source_sha
        self.job["plan"] = B.derived_plan(self.source, "audio", self.snapshot / "books")
        self.job["plan_sha256"] = digest(self.job["plan"])
        self.result["manifest"]["sourceSha256"] = self.source_sha
        rows = [{"table": "ranobe_runs", "row": {"id": snapshot_id, "status": "ready"}},
                {"table": "ranobe_run_parts", "row": {"run_id": snapshot_id, "ordinal": 0, "status": "ready", "book_id": self.book["id"]}},
                {"table": "ranobe_run_parts", "row": {"run_id": snapshot_id, "ordinal": 50, "status": "ready", "book_id": identity(89)}}]
        (self.snapshot / "ranobe-metadata.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "complete pinned Ranobe"):
            self.validate()

    def test_checkpoint_hash_must_match_file_and_scanner_receipt(self):
        self.segments[0]["scan"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "scan receipt"):
            self.validate()

    def test_checkpoint_profile_cannot_change_inside_same_recipe(self):
        self.segments[0]["profileSha256"] = "a" * 64
        with self.assertRaisesRegex(ValueError, "profile differs"):
            self.validate()

    def test_strict_package_derivation_rejects_authority_and_unpinned_fields(self):
        value = {"schemaVersion": 1, "kind": "machine-translation", "quality": "machine-draft", "sourceSha256": self.source_sha, "recipeSha256": self.recipe_sha, "jobId": self.job_id}
        self.assertEqual(B.validate_derivation_metadata(value), value)
        for mutation in ({"role": "owner"}, {"sourceSha256": None}, {"recipeSha256": "ABC"}, {"jobId": "../outside"}, {"schemaVersion": True}):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                B.validate_derivation_metadata({**value, **mutation})

    def test_checkpoint_traversal_never_becomes_a_file_lookup(self):
        self.segments[0]["file"]["path"] = "../../outside.wav"
        with self.assertRaisesRegex(ValueError, "artifact manifest"):
            self.validate()

    def test_changed_pcm_header_with_forged_hash_is_still_rejected(self):
        raw = bytearray(self.raw)
        struct.pack_into("<I", raw, 40, 99999999)
        manifest = self.segments[0]
        path = self.derived_root / self.job_id / manifest["file"]["path"]
        path.write_bytes(raw)
        new_sha = digest(bytes(raw))
        manifest["file"]["sha256"] = manifest["scan"]["sha256"] = self.meta["derived_checkpoints"][0]["output_sha256"] = new_sha
        with self.assertRaisesRegex(ValueError, "WAV chunk"):
            self.validate()

    def test_output_frames_and_recorded_duration_must_match(self):
        self.segments[0]["pcm"]["frames"] += 1
        with self.assertRaisesRegex(ValueError, "PCM manifest"):
            self.validate()

    def test_final_manifest_cannot_omit_or_reorder_checkpoint_segments(self):
        self.result["manifest"]["segments"] = list(reversed(self.segments))
        with self.assertRaisesRegex(ValueError, "coverage/order"):
            self.validate()

    def test_completed_job_without_result_is_rejected(self):
        self.meta["derived_results"] = []
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.validate()

    def test_completed_counter_cannot_skip_the_checkpoint_prefix(self):
        self.meta["derived_checkpoints"].pop(0)
        self.job["completed_segments"] -= 1
        with self.assertRaisesRegex(ValueError, "prefix"):
            self.validate()

    def test_interrupted_job_keeps_only_accepted_prefix_and_preserves_unissued_orphan(self):
        self.job.update(status="paused", completed_segments=1)
        self.meta["derived_attempts"][0]["state"] = "paused"
        self.meta["derived_checkpoints"] = self.meta["derived_checkpoints"][:1]
        self.meta["derived_results"] = []
        self.meta["derived_requests"][0]["status"] = "active"
        result = self.validate()
        self.assertEqual(result["derivedCheckpointsChecked"], 1)
        self.assertEqual(result["derivedResultsChecked"], 0)
        self.assertEqual(result["derivedOrphanFilesPreserved"], len(self.segments))

    def test_result_cannot_point_to_a_different_expression(self):
        self.result["expression_id"] = identity(987)
        with self.assertRaisesRegex(ValueError, "lineage"):
            self.validate()

    def test_new_inventory_sql_bounds_sidecar_and_keeps_consistent_snapshot(self):
        sql = B.inventory_sql("/tmp/gargantua-snapshot-" + "a" * 32, True)
        self.assertIn("pg_export_snapshot()", sql)
        self.assertIn("derived-metadata.jsonl", sql)
        self.assertIn("COALESCE(max(octet_length(line)+1),0)<=20971520", sql)
        for name in B.DERIVED_METADATA_TABLES:
            self.assertIn("FROM public." + name, sql)
        self.assertNotIn("derived-metadata.jsonl", B.inventory_sql("/tmp/gargantua-verify-" + "a" * 32, False))

    def test_model_reconstruction_code_is_archived_without_model_or_wheel_caches(self):
        selected, _ = B.source_candidates(ROOT)
        for relative in ("inference/executor.py", "inference/profiles.lock.json", "experiments/s5/tts/prepare.py", "experiments/s5/runtime/Dockerfile", "experiments/s5/runtime/requirements.lock", "experiments/s5/runtime/wheel-lock.json"):
            self.assertIn(relative, selected)
        self.assertFalse(any("/wheels/" in name or "/prefetched/" in name or "/pip-tmp/" in name or name.endswith((".whl", ".gguf", ".onnx", ".safetensors")) for name in selected if name.startswith("experiments/s5/")))
        self.assertFalse(any("/.backup-test-tmp/" in name for name in selected))


class DerivedSelectionParityTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads((ROOT / "tests/fixtures/derived-selection-v2.json").read_text(encoding="utf-8"))
        parent = ROOT / "tests/.backup-test-tmp"
        parent.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.books = Path(self.temporary.name) / "books"
        self.write_books()

    def tearDown(self):
        self.temporary.cleanup()

    def write_books(self):
        for part, book in zip(self.fixture["source"]["manifest"]["parts"], self.fixture["contents"]):
            BASE.write(self.books / part["publicationId"] / "book.json", book)

    def real_node(self):
        program = """import{makeDerivedPlan,translatedBooks}from'./server/derived-plan.mjs';import{makePackedAudioPlan}from'./server/derived-audio-plan.mjs';let text='';for await(const chunk of process.stdin)text+=chunk;const x=JSON.parse(text),translationPlan=makeDerivedPlan(x.source,x.contents,'translation').manifest,audioPlan=makePackedAudioPlan(x.source,x.contents).manifest,outputs=translationPlan.segments.map((unit,index)=>'Перевод '+index);process.stdout.write(JSON.stringify({translationPlan,audioPlan,outputs,translated:translatedBooks(x.source,x.contents,translationPlan,outputs)}));"""
        value = subprocess.run([shutil.which("node"), "--input-type=module", "-e", program], cwd=ROOT, input=json.dumps(self.fixture, ensure_ascii=False), capture_output=True, text=True, encoding="utf-8", timeout=20, check=True)
        return json.loads(value.stdout)

    def test_shared_v2_fixture_pins_exact_cross_part_node_python_plans_and_compact_outputs(self):
        source = self.fixture["source"]
        self.assertEqual(digest(source["manifest"]), source["sha256"])
        self.assertEqual(B.derived_plan(source, "translation", self.books), self.fixture["translationPlan"]["manifest"])
        self.assertEqual(B.derived_plan(source, "audio", self.books, B.PACKED_AUDIO_SEGMENTATION), self.fixture["audioPlan"]["manifest"])
        translated = B.derived_compact_translations(source, self.fixture["translationPlan"]["manifest"], self.fixture["outputs"], self.books, None)
        self.assertEqual([index for index, _ in translated], [1, 2])
        self.assertEqual([book for _, book in translated], self.fixture["translated"])
        actual = self.real_node()
        self.assertEqual(actual["translationPlan"], self.fixture["translationPlan"]["manifest"])
        self.assertEqual(actual["audioPlan"], self.fixture["audioPlan"]["manifest"])
        self.assertEqual([book for _, book in B.derived_compact_translations(source, actual["translationPlan"], actual["outputs"], self.books, None)], actual["translated"])

    def test_v2_rehashed_ranges_cannot_omit_reorder_or_retarget_selected_chapters(self):
        original = self.fixture["source"]
        changes = [lambda s: s.update(start=5), lambda s: s.update(count=2), lambda s: s.update(total=8), lambda s: s.update(schemaVersion=True), lambda s: s.update(start=True), lambda s: s.update(count=51), lambda s: s["chapters"].reverse(), lambda s: s["chapters"][0].update(ordinal=4), lambda s: s["chapters"][0].update(partIndex=0), lambda s: s["chapters"][0].update(chapterIndex=0), lambda s: s["chapters"][0].update(publicationId=identity(999)), lambda s: s["chapters"][0].update(chapterId="c-0"), lambda s: s["chapters"][0].update(role="owner")]
        for change in changes:
            with self.subTest(change=change):
                source = copy.deepcopy(original)
                change(source["manifest"]["selection"])
                source["sha256"] = digest(source["manifest"])
                with self.assertRaises(ValueError):
                    B.derived_plan(source, "audio", self.books, B.PACKED_AUDIO_SEGMENTATION)

    def test_compact_unicode_title_whitespace_spans_and_selected_asset_rules_match_node(self):
        book = self.fixture["contents"][1]
        book["title"] = "😀" * 145 + "Z" * 10
        book["assets"] = {"image-1.png": "iVBORw0KGgo=", "image-2.png": "iVBORw0KGgo="}
        book["chapters"][2]["blocks"][0]["text"] = "\ufeff  😀 sentence. " * 80 + "\nEnd.\ufeff"
        book["chapters"][2]["blocks"].append({"type": "image", "asset": "image-1.png", "text": "Selected caption"})
        book["chapters"][0]["blocks"].append({"type": "image", "asset": "image-2.png", "text": "Not selected"})
        book["structure"] = {"schemaVersion": 2, "warnings": ["EXPLICIT_STRUCTURE"], "chapters": [{"id": "c-" + str(c), "revision": 1, "title": chapter["title"], "blocks": [{"id": "c-" + str(c) + "-b-" + str(b), "type": "image" if block["type"] == "image" else "paragraph", "text": block["text"], **({"resource": block["asset"]} if block["type"] == "image" else {})} for b, block in enumerate(chapter["blocks"])]} for c, chapter in enumerate(book["chapters"])]}
        book["structure"]["chapters"][2]["blocks"][0]["spans"] = [{"start": 3, "end": 5, "kind": "emphasis"}]
        self.write_books()
        actual = self.real_node()
        source = self.fixture["source"]
        self.assertEqual(B.derived_plan(source, "translation", self.books), actual["translationPlan"])
        self.assertEqual(B.derived_plan(source, "audio", self.books, B.PACKED_AUDIO_SEGMENTATION), actual["audioPlan"])
        expected = [value for _, value in B.derived_compact_translations(source, actual["translationPlan"], actual["outputs"], self.books, None)]
        self.assertEqual(expected, actual["translated"])
        self.assertEqual(set(expected[0]["assets"]), {"image-1.png"})
        self.assertNotIn("spans", expected[0]["structure"]["chapters"][0]["blocks"][0])
        self.assertLessEqual(len(expected[0]["title"].encode("utf-16-le")) // 2, 300)


if __name__ == "__main__":
    unittest.main()
