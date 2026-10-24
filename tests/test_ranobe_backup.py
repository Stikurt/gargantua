"""Offline 005 backup semantics, with candidate Node publication/fingerprint contracts.

Uses synthetic bytes only. No Docker, PostgreSQL, network or production path.
"""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import unittest
import uuid

PROJECT = Path(__file__).resolve().parents[1]


def module(name, relative):
    spec = importlib.util.spec_from_file_location(name, PROJECT / relative)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


BACKUP = module("ranobe_backup_artifacts", "scripts/backup-artifacts.py")
FIXTURE = module("ranobe_restore_fixture", "tests/fixtures/restore-fixture.py")


class RanobeBackupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = PROJECT / ".local/test-results" / ("ranobe-backup-offline-" + uuid.uuid4().hex)
        cls.seed = cls.root / "seed"
        cls.seed.mkdir(parents=True, exist_ok=False)
        FIXTURE.build(cls.seed)
        cls.expected = FIXTURE.read_json(cls.seed / "expected.json")
        expected = cls.expected
        rows = copy.deepcopy(expected["books"])
        payload = []
        for i, row in enumerate(rows):
            row.update(work_id=FIXTURE.identity(3001 + i), expression_id=FIXTURE.identity(3101 + i), edition_id=FIXTURE.identity(3201 + i))
            payload.append({"row": row, "book": FIXTURE.read_json(cls.seed / "books" / row["id"] / "book.json")})
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node is required for the independent publication contract check")
        program = """import {makePublicationManifest,canonicalJson,sha256} from './server/publication-model.mjs';
import {ranobeChapterFingerprint} from './server/ranobe-store.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const data=JSON.parse(input),books=data.books.map(({row,book})=>{const manifest=makePublicationManifest(row,book);return {...row,publication_manifest:manifest,publication_sha256:sha256(Buffer.from(canonicalJson(manifest)))};});
for(const row of data.chapters){const book=row.prepared_book??data.books.find(x=>x.row.id===row.book_id).book;if(ranobeChapterFingerprint(book,row.prepared_book?0:row.chapter_index)!==row.content_sha256)throw Error('Cross-language checkpoint hash differs');}
process.stdout.write(JSON.stringify(books));"""
        result = subprocess.run([node, "--input-type=module", "-e", program], cwd=PROJECT,
                                input=json.dumps({"books": payload, "chapters": expected["ranobeTables"]["ranobe_chapters"]}, ensure_ascii=False),
                                capture_output=True, encoding="utf-8", timeout=30, check=True)
        rows = json.loads(result.stdout)
        tables = {"profiles": [{k: v for k, v in row.items() if k != "password"} for row in expected["profiles"]],
                  "imports": expected["imports"], "books": rows, "reading": expected["reading"], "bookmarks": expected["bookmarks"],
                  "settings": [{"id": 1}], "profile_catalogs": expected["catalogs"], **copy.deepcopy(expected["ranobeTables"])}
        attempts = {row["token"]: row for row in expected["attempts"]}
        for row in tables["ranobe_scratch"]:
            row["parent_import_id"] = attempts[row["parent_attempt"]]["import_id"]
        for row in tables["ranobe_chapters"]:
            book = row.pop("prepared_book")
            row.update(prepared_present=book is not None, prepared_json_sha256=None, prepared_json_bytes=None)
        cls.inventory = {"schemaVersion": 1, "catalogsSupported": True, "ranobeSupported": True, "sessionRows": 3, "tables": tables}
        cls.prepared = {row["id"]: row["prepared_book"] for row in expected["ranobeTables"]["ranobe_chapters"] if row["prepared_book"] is not None}

    def setUp(self):
        self.inventory = copy.deepcopy(type(self).inventory)
        self.path = self.root / self._testMethodName
        self.path.mkdir()
        self.sidecar = self.path / "ranobe-checkpoints.jsonl"
        self.metadata = self.path / "ranobe-metadata.jsonl"
        self.write_sidecar(copy.deepcopy(self.prepared))

    def write_sidecar(self, prepared):
        rows = {row["id"]: row for row in self.inventory["tables"]["ranobe_chapters"]}
        lines = []
        for ident, book in prepared.items():
            # Deliberately includes JSONB-style whitespace. The sidecar hash is
            # over exact serialized bytes; semantic hash uses canonical JSON.
            encoded = json.dumps(book, ensure_ascii=False, sort_keys=True, separators=(", ", ": "))
            rows[ident].update(prepared_json_sha256=hashlib.sha256(encoded.encode()).hexdigest(), prepared_json_bytes=len(encoded.encode()),
                               prepared_bytes=len(BACKUP.canonical_json(book).encode()), content_sha256=BACKUP.chapter_fingerprint(book))
            lines.append('{"id":' + json.dumps(ident) + ',"prepared_book":' + encoded + '}\n')
        self.sidecar.write_text("".join(lines), encoding="utf-8", newline="\n")

    def core_inventory(self):
        return {**self.inventory, "ranobeMetadataFormat": "source-jsonl-v1", "tables": {name: rows for name, rows in self.inventory["tables"].items() if name not in BACKUP.RANOBE_TABLES}}

    def write_metadata(self):
        with self.metadata.open("w", encoding="utf-8", newline="\n") as stream:
            for table in BACKUP.RANOBE_TABLES:
                for row in self.inventory["tables"][table]:
                    stream.write(json.dumps({"table": table, "row": row}, ensure_ascii=False) + "\n")

    def validate(self, write_metadata=True, expected_tables=None):
        if write_metadata:
            self.write_metadata()
        return BACKUP.validate_library(self.seed / "books", self.core_inventory(), self.sidecar, expected_tables=expected_tables)

    def test_complete_head_building_checkpoint_and_second_branch_share_safe_bytes(self):
        result = self.validate()
        self.assertEqual((result["ranobeFeedsChecked"], result["ranobeRunsChecked"], result["ranobePartsChecked"], result["ranobeCheckpointsChecked"], result["ranobePreparedBlobsChecked"]), (2, 3, 3, 7, 1))

    def test_no_change_completed_request_reuses_old_snapshot_without_new_maps(self):
        tables = self.inventory["tables"]
        request = tables["ranobe_feed_requests"][-1]
        run = next(row for row in tables["ranobe_runs"] if row["id"] == request["result_run_id"])
        imports = {row["id"]: row for row in tables["imports"]}
        self.assertNotEqual(request["import_id"], run["import_id"])
        self.assertNotEqual(request["profile_id"], imports[run["import_id"]]["requested_by"])
        self.assertEqual(imports[request["import_id"]]["status"], "completed")
        self.assertEqual((len(tables["ranobe_runs"]), len(tables["ranobe_run_chapters"])), (3, 11))
        self.validate()

    def test_result_snapshot_from_another_branch_rejected(self):
        tables = self.inventory["tables"]
        tables["ranobe_feed_requests"][-1]["result_run_id"] = tables["ranobe_runs"][2]["id"]
        with self.assertRaisesRegex(ValueError, "result snapshot/branch/state"):
            self.validate()

    def test_result_snapshot_must_be_ready(self):
        tables = self.inventory["tables"]
        tables["ranobe_feed_requests"][-1]["result_run_id"] = tables["ranobe_runs"][1]["id"]
        with self.assertRaisesRegex(ValueError, "result snapshot/branch/state"):
            self.validate()

    def test_result_snapshot_requires_completed_request_import(self):
        tables = self.inventory["tables"]
        tables["ranobe_feed_requests"][1]["result_run_id"] = tables["ranobe_runs"][0]["id"]
        with self.assertRaisesRegex(ValueError, "result snapshot/branch/state"):
            self.validate()

    def test_completed_new_request_requires_result_pointer(self):
        self.inventory["tables"]["ranobe_feed_requests"][-1]["result_run_id"] = None
        with self.assertRaisesRegex(ValueError, "lacks a ready result"):
            self.validate()

    def test_old_005_request_without_result_column_uses_original_parent(self):
        rows = self.inventory["tables"]["ranobe_feed_requests"]
        rows.pop()  # No-change reuse did not exist before the result pointer.
        for row in rows:
            row.pop("result_run_id")
        self.validate()

    def test_dangling_published_pointer_rejected(self):
        self.inventory["tables"]["ranobe_chapters"][0]["book_id"] = FIXTURE.identity(9999)
        with self.assertRaisesRegex(ValueError, "Dangling/blocked"):
            self.validate()

    def test_wrong_part_package_hash_rejected(self):
        self.inventory["tables"]["ranobe_run_parts"][0]["package_sha256"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "hash-mismatched"):
            self.validate()

    def test_wrong_checkpoint_blob_hash_rejected(self):
        row = next(row for row in self.inventory["tables"]["ranobe_chapters"] if row["prepared_present"])
        row["prepared_json_sha256"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "JSON hash/size"):
            self.validate()

    def test_wrong_checkpoint_semantic_hash_rejected(self):
        row = next(row for row in self.inventory["tables"]["ranobe_chapters"] if row["prepared_present"])
        row["content_sha256"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "semantic hash/size"):
            self.validate()

    def test_branch_mismatch_rejected(self):
        self.inventory["tables"]["ranobe_feeds"][0]["branch_key"] = "77"
        with self.assertRaisesRegex(ValueError, "branch/feed mismatch"):
            self.validate()

    def test_identical_content_from_another_branch_does_not_authorize_checkpoint_mapping(self):
        rows = self.inventory["tables"]["ranobe_run_chapters"]
        rows[0]["chapter_id"] = self.inventory["tables"]["ranobe_chapters"][4]["id"]
        with self.assertRaisesRegex(ValueError, "branch/source mismatch"):
            self.validate()

    def test_missing_required_sidecar_rejected(self):
        self.sidecar.unlink()
        with self.assertRaisesRegex(ValueError, "sidecar is missing"):
            self.validate()

    def test_unsupported_raw_html_field_rejected_even_with_coherent_hashes(self):
        prepared = copy.deepcopy(self.prepared)
        next(iter(prepared.values()))["html"] = "<script>synthetic</script>"
        self.write_sidecar(prepared)
        with self.assertRaisesRegex(ValueError, "sanitized Ranobe checkpoint book"):
            self.validate()

    def test_corrupt_png_rejected_even_with_coherent_json_and_semantic_hashes(self):
        prepared = copy.deepcopy(self.prepared)
        book = next(iter(prepared.values()))
        raw = bytearray(base64.b64decode(book["assets"]["image-0.png"]))
        raw[-1] ^= 1
        book["assets"]["image-0.png"] = base64.b64encode(raw).decode()
        self.write_sidecar(prepared)
        with self.assertRaisesRegex(ValueError, "PNG CRC"):
            self.validate()

    def test_duplicate_sidecar_record_rejected(self):
        self.sidecar.write_bytes(self.sidecar.read_bytes() * 2)
        with self.assertRaisesRegex(ValueError, "duplicate checkpoint"):
            self.validate()

    def test_bounded_sidecar_file_limit_rejected_before_loading(self):
        with self.sidecar.open("r+b") as stream:
            stream.truncate(96 * 1024**2 + 1)
        with self.assertRaisesRegex(ValueError, "bounded regular-file budget"):
            self.validate()

    def test_snapshot_sql_captures_source_sidecar_inside_exported_transaction_only(self):
        snapshot = BACKUP.inventory_sql("/tmp/gargantua-snapshot-" + "a" * 32, True)
        restored = BACKUP.inventory_sql("/tmp/gargantua-verify-" + "b" * 32, False)
        self.assertLess(snapshot.index("pg_export_snapshot()"), snapshot.index("/ranobe-checkpoints.jsonl"))
        self.assertLess(snapshot.index("/ranobe-checkpoints.jsonl"), snapshot.index("COMMIT;"))
        self.assertNotIn("/ranobe-checkpoints.jsonl", restored)
        self.assertIn("to_jsonb(t)-'prepared_book'", snapshot)
        self.assertIn("/ranobe-metadata.jsonl", snapshot)
        self.assertNotIn("/ranobe-metadata.jsonl", restored)
        self.assertNotIn("ranobe_run_chapters t", BACKUP.inventory_query(True, True))
        self.assertEqual(BACKUP.MAX_JSON, 32 * 1024**2)

    def test_source_sql_checks_exact_line_and_total_bytes_before_sidecar_output(self):
        sql = BACKUP.inventory_sql("/tmp/gargantua-snapshot-" + "c" * 32, True)
        for name, total, line in (("ranobe-checkpoints.jsonl", 96 * 1024**2, 22 * 1024**2), ("ranobe-metadata.jsonl", 256 * 1024**2, 1024**2)):
            guard = "COALESCE(sum(octet_length(line)+1),0)<=" + str(total)
            self.assertIn(guard, sql)
            self.assertLess(sql.index(guard), sql.index("/" + name))
            self.assertIn("COALESCE(max(octet_length(line)+1),0)<=" + str(line), sql)
        self.assertIn("count(*)<=500000", sql)
        self.assertIn("sum(prepared_bytes),0)<=67108864", sql)
        self.assertIn("\\else\nSELECT 1/0;\n\\endif", sql)
        self.assertNotIn("\\quit 5", sql)

    def test_main_inventory_omits_all_005_arrays(self):
        self.write_metadata()
        core = self.core_inventory()
        self.assertFalse(set(core["tables"]) & set(BACKUP.RANOBE_TABLES))
        self.assertEqual(core["ranobeMetadataFormat"], "source-jsonl-v1")
        self.assertEqual(self.validate()["ranobeRunsChecked"], 3)

    def test_missing_source_metadata_rejected(self):
        with self.assertRaisesRegex(ValueError, "metadata sidecar is missing"):
            self.validate(write_metadata=False)

    def test_every_metadata_table_count_is_bound_to_fingerprints(self):
        expected = {name: {"count": len(self.inventory["tables"][name])} for name in BACKUP.RANOBE_TABLES}
        self.assertEqual(self.validate(expected_tables=expected)["ranobeRunsChecked"], 3)
        for name in BACKUP.RANOBE_TABLES:
            with self.subTest(table=name):
                changed = copy.deepcopy(expected)
                changed[name]["count"] += 1
                with self.assertRaisesRegex(ValueError, "row count differs"):
                    self.validate(expected_tables=changed)

    def test_support_flag_cannot_hide_fingerprinted_005_tables(self):
        core = self.core_inventory()
        core["ranobeSupported"] = False
        with self.assertRaisesRegex(ValueError, "support flag omits"):
            BACKUP.validate_library(self.seed / "books", core, self.sidecar, expected_tables={"ranobe_feeds": {"count": 2}})

    def test_unknown_metadata_table_rejected(self):
        self.metadata.write_text('{"table":"profiles","row":{}}\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "metadata table/record"):
            self.validate(write_metadata=False)

    def test_prepared_blob_cannot_return_to_metadata(self):
        self.metadata.write_text('{"table":"ranobe_chapters","row":{"prepared_book":{}}}\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "blob is forbidden"):
            self.validate(write_metadata=False)

    def test_oversized_metadata_record_rejected_before_json_decode(self):
        self.metadata.write_bytes(b"x" * (1024**2 + 1))
        with self.assertRaisesRegex(ValueError, "record is oversized"):
            self.validate(write_metadata=False)

    def test_20k_chapters_and_multiple_snapshots_stream_beyond_main_inventory_limit(self):
        chapter = self.inventory["tables"]["ranobe_chapters"][0]
        mapping = self.inventory["tables"]["ranobe_run_chapters"][0]
        # Real fixture row shapes, expanded to 20k chapter revisions and three
        # frozen inventories. This tests the bounded transport, not a fake PG run.
        with self.metadata.open("w", encoding="utf-8", newline="\n") as stream:
            for i in range(20000):
                row = {**chapter, "id": FIXTURE.identity(40000 + i), "source_key": "v1:n" + str(i+1)}
                stream.write(json.dumps({"table": "ranobe_chapters", "row": row}, ensure_ascii=False) + "\n")
            for snapshot in range(3):
                for i in range(20000):
                    row = {**mapping, "run_id": FIXTURE.identity(70000 + snapshot), "ordinal": i, "source_key": "v1:n" + str(i+1), "chapter_id": FIXTURE.identity(40000 + i)}
                    stream.write(json.dumps({"table": "ranobe_run_chapters", "row": row}, ensure_ascii=False) + "\n")
        self.assertGreater(self.metadata.stat().st_size, BACKUP.MAX_JSON)
        tables = BACKUP.ranobe_metadata(self.metadata)
        self.assertEqual((len(tables["ranobe_chapters"]), len(tables["ranobe_run_chapters"])), (20000, 60000))
        self.assertLess(len(json.dumps(self.core_inventory(), ensure_ascii=False).encode()), BACKUP.MAX_JSON)
        FIXTURE.write_json(self.path / "capacity-evidence.json", {"scope": "synthetic fixture-shape metadata transport", "chapters": 20000, "snapshots": 3,
            "metadataBytes": self.metadata.stat().st_size, "coreInventoryBytes": len(json.dumps(self.core_inventory(), ensure_ascii=False).encode()), "genericJsonLimitBytes": BACKUP.MAX_JSON})


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RanobeBackupTests))
    if hasattr(RanobeBackupTests, "root"):
        FIXTURE.write_json(RanobeBackupTests.root / "report.json", {"status": "PASS" if result.wasSuccessful() else "FAIL", "tests": result.testsRun,
            "failures": len(result.failures), "errors": len(result.errors), "scope": "offline semantic/fault checks with real Node contracts; no database restore", "runtimeAccepted": False, "dockerCommands": False})
        print("Ranobe backup offline report:", RanobeBackupTests.root / "report.json")
    raise SystemExit(0 if result.wasSuccessful() else 1)
