"""Offline snapshot checks. Fake dump bytes are never passed to a database."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("backup_artifacts", ROOT / "scripts/backup-artifacts.py")
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
PROFILE = "10000000-0000-4000-8000-000000000001"
IMPORT = "20000000-0000-4000-8000-000000000002"
BOOK = "30000000-0000-4000-8000-000000000003"
MARK = "40000000-0000-4000-8000-000000000004"
CATALOG = "50000000-0000-4000-8000-000000000005"
MISSING = "60000000-0000-4000-8000-000000000006"
DEVICE = "70000000-0000-4000-8000-000000000007"
READER_MARK = "80000000-0000-4000-8000-000000000008"
MUTATION = "90000000-0000-4000-8000-000000000009"
MUTATION_DELETE = "a0000000-0000-4000-8000-00000000000a"
STAMP = "2026-10-23T12:00:00.000Z"


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


class BackupArtifactTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / "tests/.backup-test-tmp"
        parent.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temporary.name).resolve()
        self.assertTrue(self.root.is_relative_to(ROOT.resolve()))
        self.snapshot = self.root / "snapshot"
        self.snapshot.mkdir()
        self.content = {"title": "Книга — 日本語", "author": "Автор", "language": "ru", "chapters": [
            {"title": "Глава", "blocks": [{"type": "heading", "text": "Начало"}, {"type": "text", "text": "Текст с заметкой."}]}], "assets": {}}
        self.inventory = {"schemaVersion": 1, "catalogsSupported": True, "sessionRows": 3, "tables": {
            "profiles": [{"id": PROFILE, "role": "owner"}],
            "imports": [{"id": IMPORT, "requested_by": PROFILE, "approved_by": None, "book_id": BOOK}],
            "books": [{"id": BOOK, "import_id": IMPORT, "requested_by": PROFILE, "chapter_count": 1, "sha256": "0" * 64}],
            "reading": [{"profile_id": PROFILE, "book_id": BOOK, "chapter": 0, "position": 0.25}],
            "bookmarks": [{"id": MARK, "profile_id": PROFILE, "book_id": BOOK, "chapter": 0, "position": 0.5, "note": "Цитата — 日本語"}],
            "settings": [{"id": 1, "imports_paused": False, "serving_paused": False}],
            "profile_catalogs": [{"profile_id": PROFILE, "revision": 1, "catalogs": [{"id": CATALOG, "parent": None, "title": "Серия", "items": [{"id": BOOK, "scope": "server", "title": "Книга", "author": "Автор"}]}]}],
        }}
        self.write_inputs()

    def tearDown(self):
        self.temporary.cleanup()

    def write_inputs(self):
        write(self.snapshot / "manifest.json", {"version": 2, "status": "building", "files": []})
        write(self.snapshot / "books" / BOOK / "book.json", self.content)
        write(self.snapshot / "db-inventory.json", self.inventory)
        write(self.snapshot / "snapshot-metadata.json", {"handlersRestored": True, "snapshotProtocol": "pg-exported-repeatable-read"})
        (self.snapshot / "database.dump").write_bytes(b"OFFLINE FAKE DUMP - NOT POSTGRESQL")
        records = [{"table": name, "count": len(rows), "fingerprint": hashlib.md5(name.encode()).hexdigest()} for name, rows in self.inventory["tables"].items()]
        (self.snapshot / "db-table-fingerprints.jsonl").write_text("\n".join(json.dumps(row) for row in records), encoding="utf-8")
        with tarfile.open(self.snapshot / "source.tar.gz", "w:gz") as bundle:
            item = tarfile.TarInfo("compose.yaml"); payload = b"services: {}\n"; item.size = len(payload)
            bundle.addfile(item, io.BytesIO(payload))

    def finalize(self):
        return backup.finalize(self.snapshot)

    def reader_inputs(self):
        payload = {"publicationId": BOOK, "publicationRevision": 1, "locator": {"type": "legacy", "chapter": 0, "position": 1e-7}, "note": "Метка — 日本語"}
        first = {"entityType": "bookmark", "entityId": READER_MARK, "revision": 1, "deleted": False, "payload": payload, "updatedAt": STAMP}
        deleted = {**first, "revision": 2, "deleted": True}
        body = {"mutationId": MUTATION, "deviceId": DEVICE, "counter": 1, "entityType": "bookmark", "entityId": READER_MARK, "baseRevision": 0, "operation": "upsert", "payload": payload}
        remove = {"mutationId": MUTATION_DELETE, "deviceId": DEVICE, "counter": 2, "entityType": "bookmark", "entityId": READER_MARK, "baseRevision": 1, "operation": "delete"}
        def receipt(value, entity):
            # JSON.stringify uses 1e-7, unlike Python's 1e-07. Keep original JS
            # canonical bytes so the backup never attempts to re-encode floats.
            canonical = backup.canonical_json(value).replace("1e-07", "1e-7")
            return {"profile_id": PROFILE, "mutation_id": value["mutationId"], "device_id": DEVICE, "counter": value["counter"], "body_sha256": hashlib.sha256(canonical.encode()).hexdigest(), "canonical_body": canonical, "body": value, "result": {"mutationId": value["mutationId"], "status": "accepted", "entity": entity}, "created_at": STAMP}
        self.reader = {
            "reader_profiles": [{"profile_id": PROFILE, "revision": 2, "min_revision": 0}],
            "reader_devices": [{"profile_id": PROFILE, "device_id": DEVICE, "last_counter": 2, "updated_at": STAMP}],
            "reader_entities": [{"profile_id": PROFILE, "entity_type": "bookmark", "entity_id": READER_MARK, "revision": 2, "deleted": True, "payload": payload, "legacy_id": None, "updated_at": STAMP}],
            "reader_mutations": [receipt(body, first), receipt(remove, deleted)],
            "reader_changes": [{"profile_id": PROFILE, "change_revision": 1, "entity_type": "bookmark", "entity_id": READER_MARK, "record": first}, {"profile_id": PROFILE, "change_revision": 2, "entity_type": "bookmark", "entity_id": READER_MARK, "record": deleted}],
        }
        self.inventory.update({"readerSupported": True, "readerMetadataFormat": "source-jsonl-v1"})
        self.write_reader()

    def write_reader(self):
        records = []
        for name in backup.READER_TABLES:
            for row in self.reader[name]:
                records.append(json.dumps({"table": name, "row": row}, ensure_ascii=False))
        raw = ("\n".join(records) + "\n").encode("utf-8")
        if self.inventory.get("readerMetadataFormat") == "source-jsonl-v2":
            self.inventory["readerBudget"] = {"format": "exact-jsonl-v1", "rows": len(records), "bytes": len(raw), "maxRows": 250000, "maxBytes": 96 * 1024**2}
        self.write_inputs()
        (self.snapshot / "reader-metadata.jsonl").write_bytes(raw)
        with (self.snapshot / "db-table-fingerprints.jsonl").open("a", encoding="utf-8") as stream:
            for name in backup.READER_TABLES:
                stream.write("\n" + json.dumps({"table": name, "count": len(self.reader[name]), "fingerprint": hashlib.md5(name.encode()).hexdigest()}))
            if self.inventory.get("readerMetadataFormat") == "source-jsonl-v2":
                stream.write("\n" + json.dumps({"table": "reader_journal_budget", "count": 1, "fingerprint": hashlib.md5(b"synthetic budget fixture").hexdigest()}))

    def modern_reader_inputs(self, protocol=1):
        self.reader_inputs()
        self.inventory["readerMetadataFormat"] = "source-jsonl-v2"
        self.reader["reader_devices"][0].update({"protocol_version": protocol, "compacted_through": 0, "compacted_accepted": 0, "compaction_sha256": None})
        for entity in self.reader["reader_entities"]:
            entity["modern_write"] = True
        for row in self.reader["reader_mutations"]:
            body = row["body"]
            if protocol == 2:
                body["protocolVersion"] = 2
                body["mutationId"] = backup.reader_mutation_id(PROFILE, DEVICE, row["counter"])
                row["mutation_id"] = body["mutationId"]
                row["result"]["mutationId"] = body["mutationId"]
                row["canonical_body"] = backup.canonical_json(body).replace("1e-07", "1e-7")
                row["body_sha256"] = hashlib.sha256(row["canonical_body"].encode()).hexdigest()
            row.update({"compacted": False, "entity_type": body["entityType"], "entity_id": body["entityId"], "accepted_revision": row["result"]["entity"]["revision"]})
        self.write_reader()

    def test_reader_v2_canonical_protocol_receipts_finalize_and_restore(self):
        self.modern_reader_inputs(2)
        original = copy.deepcopy(self.reader["reader_mutations"])
        self.assertEqual([row["body"]["protocolVersion"] for row in original], [2, 2])
        self.assertEqual([row["body"]["operation"] for row in original], ["upsert", "delete"])
        report = self.finalize()
        self.assertEqual(report["library"]["readerReceiptsChecked"], 2)
        self.assertEqual(report["library"]["readerTombstonesChecked"], 1)
        restored = self.root / "restored-v2-reader"
        shutil.copytree(self.snapshot, restored)
        inventory = copy.deepcopy(self.inventory)
        inventory["sessionRows"] = 0
        write(restored / "db-inventory.json", inventory)
        checked = backup.compare_restore(self.snapshot, restored, restored / "books")
        self.assertEqual(checked["library"]["readerReceiptsChecked"], 2)
        self.assertEqual(checked["library"]["readerChangesChecked"], 2)
        receipts = [row for table, row in backup.reader_metadata(restored / "reader-metadata.jsonl", "source-jsonl-v2") if table == "reader_mutations"]
        self.assertEqual(receipts, original)

    def test_reader_v2_protocol_field_is_required_exactly_typed_and_device_bound(self):
        self.modern_reader_inputs(2)
        original = copy.deepcopy(self.reader)
        for value in (None, 1, 3, True, 2.0, "2", "missing"):
            self.reader = copy.deepcopy(original)
            row = self.reader["reader_mutations"][0]
            if value == "missing":
                row["body"].pop("protocolVersion")
            else:
                row["body"]["protocolVersion"] = value
            row["canonical_body"] = backup.canonical_json(row["body"]).replace("1e-07", "1e-7")
            row["body_sha256"] = hashlib.sha256(row["canonical_body"].encode()).hexdigest()
            self.write_reader()
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "protocol differs"):
                self.check_reader()
        self.reader = original
        self.reader["reader_devices"][0]["protocol_version"] = 1
        self.write_reader()
        with self.assertRaisesRegex(ValueError, "Legacy reader receipt"):
            self.check_reader()

    def test_legacy_backup_receipt_cannot_smuggle_a_protocol_field(self):
        for modern in (False, True):
            if modern:
                self.modern_reader_inputs(1)
            else:
                self.reader_inputs()
            row = self.reader["reader_mutations"][0]
            row["body"]["protocolVersion"] = 2
            row["canonical_body"] = backup.canonical_json(row["body"]).replace("1e-07", "1e-7")
            row["body_sha256"] = hashlib.sha256(row["canonical_body"].encode()).hexdigest()
            self.write_reader()
            with self.subTest(modern=modern), self.assertRaisesRegex(ValueError, "Legacy reader receipt"):
                self.check_reader()

    def test_reader_v2_protocol_support_keeps_unknown_fields_rejected(self):
        self.modern_reader_inputs(2)
        row = self.reader["reader_mutations"][0]
        row["body"]["futureField"] = "not permitted"
        row["canonical_body"] = backup.canonical_json(row["body"]).replace("1e-07", "1e-7")
        row["body_sha256"] = hashlib.sha256(row["canonical_body"].encode()).hexdigest()
        self.write_reader()
        with self.assertRaisesRegex(ValueError, "digest/shape"):
            self.check_reader()

    def test_reader_v2_compacted_legacy_identity_roundtrips_without_claiming_original_body(self):
        self.modern_reader_inputs()
        row = self.reader["reader_mutations"][0]
        row.update({"compacted": True, "body": None, "canonical_body": None, "result": {"mutationId": row["mutation_id"], "status": "accepted", "compacted": True, "entityType": "bookmark", "entityId": READER_MARK, "revision": 1, "snapshotRequired": True}})
        self.write_reader()
        self.assertEqual(self.finalize()["library"]["readerReceiptsChecked"], 2)
        self.assertEqual(self.check_reader()["readerTombstonesChecked"], 1)
        for field, value in (("body", {}), ("accepted_revision", 3), ("entity_id", BOOK), ("body_sha256", "bad")):
            original = copy.deepcopy(row)
            row[field] = value
            self.write_reader()
            with self.subTest(field=field), self.assertRaises(ValueError): self.check_reader()
            row.clear(); row.update(original)

    def test_reader_v2_pruned_accepted_prefix_checks_counter_fence_and_snapshot_budget(self):
        self.modern_reader_inputs(2)
        self.reader["reader_mutations"].pop(0)
        self.reader["reader_devices"][0].update({"compacted_through": 1, "compacted_accepted": 1, "compaction_sha256": "a" * 64})
        self.write_reader()
        report = self.finalize()
        self.assertEqual(report["library"]["readerReceiptsChecked"], 1)
        self.assertEqual(report["library"]["readerChangesChecked"], 2)

    def test_reader_v2_fully_pruned_device_needs_valid_compaction_checkpoint(self):
        self.modern_reader_inputs(2)
        self.reader["reader_mutations"] = []
        self.reader["reader_devices"][0].update({"compacted_through": 2, "compacted_accepted": 2, "compaction_sha256": "a" * 64})
        self.write_reader()
        self.assertEqual(self.check_reader()["readerReceiptsChecked"], 0)
        for field, value in (("compacted_through", 1), ("compacted_accepted", 1), ("compaction_sha256", None), ("protocol_version", 1)):
            original = copy.deepcopy(self.reader)
            self.reader["reader_devices"][0][field] = value
            self.write_reader()
            with self.subTest(field=field), self.assertRaises(ValueError): self.check_reader()
            self.reader = original

    def test_reader_v2_keeps_full_conflict_below_pruned_accepted_prefix(self):
        self.modern_reader_inputs(2)
        first, final = copy.deepcopy(self.reader["reader_mutations"])
        conflict = copy.deepcopy(first)
        conflict["counter"] = 2
        conflict["mutation_id"] = backup.reader_mutation_id(PROFILE, DEVICE, 2)
        conflict["body"].update({"counter": 2, "mutationId": conflict["mutation_id"]})
        conflict["accepted_revision"] = None
        conflict["result"] = {"mutationId": conflict["mutation_id"], "status": "conflict", "code": "REVISION_CONFLICT", "current": first["result"]["entity"], "proposed": copy.deepcopy(conflict["body"])}
        final["counter"] = 4
        final["mutation_id"] = backup.reader_mutation_id(PROFILE, DEVICE, 4)
        final["body"].update({"counter": 4, "mutationId": final["mutation_id"], "baseRevision": 2})
        final["accepted_revision"] = 3
        final["result"]["mutationId"] = final["mutation_id"]
        final["result"]["entity"]["revision"] = 3
        for row in (conflict, final):
            row["canonical_body"] = backup.canonical_json(row["body"]).replace("1e-07", "1e-7")
            row["body_sha256"] = hashlib.sha256(row["canonical_body"].encode()).hexdigest()
        self.reader["reader_mutations"] = [conflict, final]
        self.reader["reader_devices"][0].update({"last_counter": 4, "compacted_through": 3, "compacted_accepted": 2, "compaction_sha256": "a" * 64})
        self.reader["reader_entities"][0]["revision"] = 3
        self.reader["reader_profiles"][0]["revision"] = 3
        self.reader["reader_changes"].append({"profile_id": PROFILE, "change_revision": 3, "entity_type": "bookmark", "entity_id": READER_MARK, "record": final["result"]["entity"]})
        self.write_reader()
        report = self.check_reader()
        self.assertEqual(report["readerReceiptsChecked"], 2)
        self.assertEqual(report["readerPrunedAcceptedChecked"], 2)
        self.assertEqual(self.reader["reader_mutations"][0]["result"]["proposed"]["payload"]["note"], "Метка — 日本語")
        self.reader["reader_mutations"].pop(0)
        self.write_reader()
        with self.assertRaises(ValueError): self.check_reader()

    def test_reader_v2_uuid_binds_profile_device_counter_and_cannot_be_compacted_as_v1(self):
        self.modern_reader_inputs(2)
        self.assertEqual(backup.reader_mutation_id(PROFILE, DEVICE, 1)[14], "8")
        self.assertNotEqual(backup.reader_mutation_id(PROFILE, DEVICE, 1), backup.reader_mutation_id(MISSING, DEVICE, 1))
        for field, value in (("mutation_id", MUTATION), ("counter", 3), ("compacted", True)):
            original = copy.deepcopy(self.reader)
            self.reader["reader_mutations"][0][field] = value
            self.write_reader()
            with self.subTest(field=field), self.assertRaises(ValueError): self.check_reader()
            self.reader = original

    def test_reader_v2_gaps_after_checkpoint_or_missing_receipts_fail_closed(self):
        self.modern_reader_inputs(2)
        self.reader["reader_mutations"].pop(0)
        self.write_reader()
        with self.assertRaises(ValueError): self.check_reader()
        self.reader["reader_devices"][0].update({"compacted_through": 1, "compacted_accepted": 1, "compaction_sha256": "a" * 64})
        self.write_reader()
        self.assertEqual(self.check_reader()["readerReceiptsChecked"], 1)
        self.reader["reader_mutations"] = []
        self.write_reader()
        with self.assertRaises(ValueError): self.check_reader()

    def test_reader_v2_budget_bytes_rows_limits_and_fingerprint_singleton_are_checked(self):
        self.modern_reader_inputs(2)
        baseline = copy.deepcopy(self.inventory)
        for field, value in (("bytes", baseline["readerBudget"]["bytes"] + 1), ("rows", baseline["readerBudget"]["rows"] + 1), ("maxBytes", 128 * 1024**2), ("maxRows", 500000), ("format", "unbounded")):
            self.inventory = copy.deepcopy(baseline)
            self.inventory["readerBudget"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): self.check_reader()
        self.inventory = baseline
        fingerprints = backup.table_fingerprints(self.snapshot / "db-table-fingerprints.jsonl")
        fingerprints.pop("reader_journal_budget")
        with self.assertRaises(ValueError): backup.validate_reader(self.snapshot / "books", self.inventory, self.snapshot / "reader-metadata.jsonl", fingerprints)

    def test_reader_v2_modern_guard_and_unknown_checkpoint_fields_are_not_silently_ignored(self):
        self.modern_reader_inputs()
        self.reader["reader_entities"][0]["modern_write"] = False
        self.write_reader()
        with self.assertRaises(ValueError): self.check_reader()
        self.reader["reader_entities"][0]["modern_write"] = True
        self.reader["reader_devices"][0]["hardware_fingerprint"] = "not-allowed"
        self.write_reader()
        with self.assertRaises(ValueError): self.check_reader()

    def test_reader_preflight_sql_is_read_only_bounded_and_rechecks_accounting(self):
        sql = backup.reader_preflight_sql()
        self.assertIn("REPEATABLE READ READ ONLY", sql)
        self.assertIn("b.rows=m.rows AND b.bytes=m.bytes", sql)
        self.assertIn("m.max_line<=131072", sql)
        self.assertIn("bytes<=100663296", sql)
        self.assertIn("SET LOCAL DateStyle TO 'ISO, YMD'", sql)
        self.assertNotIn("pg_dump", sql)
        self.assertNotIn("\\o ", sql)

    def test_table_fingerprints_accept_only_known_legacy_and_streaming_algorithms(self):
        path = self.snapshot / "db-table-fingerprints.jsonl"
        records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        records[0].update({"algorithm": "sha256-sorted-fold-v2", "fingerprint": "a" * 64})
        def save():
            path.write_text("\n".join(json.dumps(row) for row in records), encoding="utf-8")
        save()
        checked = backup.table_fingerprints(path)
        self.assertEqual(checked["profiles"]["algorithm"], "sha256-sorted-fold-v2")
        for field, value in (("algorithm", "unrecognized"), ("algorithm", "md5-sorted-v1"), ("fingerprint", "a" * 32), ("count", True)):
            original = copy.deepcopy(records)
            records[0][field] = value
            save()
            with self.subTest(field=field, value=value), self.assertRaises(ValueError): backup.table_fingerprints(path)
            records = original

    def check_reader(self):
        return backup.validate_reader(self.snapshot / "books", self.inventory, self.snapshot / "reader-metadata.jsonl", backup.table_fingerprints(self.snapshot / "db-table-fingerprints.jsonl"))

    def test_reader_unicode_receipts_tombstones_and_real_js_numeric_bytes_roundtrip(self):
        self.reader_inputs()
        receipt = self.reader["reader_mutations"][0]
        self.assertIn("1e-7", receipt["canonical_body"])
        self.assertNotEqual(receipt["canonical_body"], backup.canonical_json(receipt["body"]))
        result = self.finalize()
        self.assertEqual(result["library"]["readerReceiptsChecked"], 2)
        self.assertEqual(result["library"]["readerTombstonesChecked"], 1)
        restored = self.root / "restored-reader"
        shutil.copytree(self.snapshot, restored)
        inventory = copy.deepcopy(self.inventory); inventory["sessionRows"] = 0
        write(restored / "db-inventory.json", inventory)
        report = backup.compare_restore(self.snapshot, restored, restored / "books")
        self.assertEqual(report["library"]["readerChangesChecked"], 2)
        self.assertEqual(report["databaseTablesCompared"], len(self.inventory["tables"]) + 5)

    def test_reader_body_digest_and_canonical_body_mismatch_are_rejected(self):
        self.reader_inputs()
        for change in ("digest", "body"):
            original = copy.deepcopy(self.reader)
            if change == "digest": self.reader["reader_mutations"][0]["body_sha256"] = "f" * 64
            else: self.reader["reader_mutations"][0]["body"]["payload"]["note"] = "Другие данные"
            self.write_reader()
            with self.subTest(change=change), self.assertRaises(ValueError): self.check_reader()
            self.reader = original

    def test_reader_cross_profile_device_and_entity_receipt_are_rejected(self):
        self.reader_inputs()
        for change in ("profile", "device", "entity"):
            original = copy.deepcopy(self.reader)
            if change == "profile": self.reader["reader_entities"][0]["profile_id"] = MISSING
            elif change == "device": self.reader["reader_mutations"][0]["device_id"] = MISSING
            else: self.reader["reader_mutations"][0]["result"]["entity"]["entityId"] = MARK
            self.write_reader()
            with self.subTest(change=change), self.assertRaises(ValueError): self.check_reader()
            self.reader = original

    def test_reader_durable_conflict_keeps_current_tombstone_without_a_new_change(self):
        self.reader_inputs()
        body = copy.deepcopy(self.reader["reader_mutations"][0]["body"])
        body.update({"mutationId": MISSING, "counter": 3})
        canonical = backup.canonical_json(body).replace("1e-07", "1e-7")
        result = {"mutationId": MISSING, "status": "conflict", "code": "REVISION_CONFLICT", "current": copy.deepcopy(self.reader["reader_changes"][-1]["record"]), "proposed": body}
        self.reader["reader_mutations"].append({"profile_id": PROFILE, "mutation_id": MISSING, "device_id": DEVICE, "counter": 3, "body_sha256": hashlib.sha256(canonical.encode()).hexdigest(), "canonical_body": canonical, "body": body, "result": result, "created_at": STAMP})
        self.reader["reader_devices"][0]["last_counter"] = 3
        self.write_reader()
        self.assertEqual(self.check_reader()["readerReceiptsChecked"], 3)
        result["current"]["entityId"] = MARK
        self.write_reader()
        with self.assertRaises(ValueError): self.check_reader()

    def test_reader_cursor_gaps_wrong_revision_and_tombstone_change_are_rejected(self):
        self.reader_inputs()
        for change in ("gap", "revision", "tombstone", "device-counter"):
            original = copy.deepcopy(self.reader)
            if change == "gap": self.reader["reader_changes"].pop(0)
            elif change == "revision": self.reader["reader_entities"][0]["revision"] = 1
            elif change == "tombstone": self.reader["reader_changes"][-1]["record"]["deleted"] = False
            else: self.reader["reader_devices"][0]["last_counter"] = 3
            self.write_reader()
            with self.subTest(change=change), self.assertRaises(ValueError): self.check_reader()
            self.reader = original

    def test_reader_flags_counts_missing_sidecar_and_bounded_lines_fail_closed(self):
        self.reader_inputs()
        self.inventory["readerSupported"] = False
        with self.assertRaises(ValueError): self.check_reader()
        self.inventory["readerSupported"] = True
        path = self.snapshot / "reader-metadata.jsonl"
        original = path.read_bytes()
        for content in (b"", original[:-1], b" " * (128 * 1024 + 1) + b"\n"):
            path.write_bytes(content)
            with self.assertRaises(ValueError): self.check_reader()
        path.unlink()
        with self.assertRaises(ValueError): self.check_reader()

    def test_reader_metadata_rejects_credential_fields_and_foreign_legacy_identity(self):
        self.reader_inputs()
        self.reader["reader_devices"][0]["password"] = "must-not-be-exported"
        self.write_reader()
        with self.assertRaises(ValueError): self.check_reader()
        self.reader["reader_devices"][0].pop("password")
        self.inventory["tables"]["profiles"].append({"id": MISSING, "role": "reader"})
        self.inventory["tables"]["bookmarks"][0]["profile_id"] = MISSING
        self.reader["reader_entities"][0]["legacy_id"] = MARK
        self.write_reader()
        with self.assertRaises(ValueError): self.check_reader()

    def test_reader_catalogue_zero_baseline_is_allowed_but_reading_zero_is_not(self):
        self.reader_inputs()
        row = {"profile_id": PROFILE, "entity_type": "catalog", "entity_id": backup.READER_CATALOG_ID, "revision": 0, "deleted": False, "payload": {"catalogs": []}, "legacy_id": None, "updated_at": STAMP}
        self.reader["reader_entities"].append(row)
        self.write_reader(); self.assertEqual(self.check_reader()["readerEntitiesChecked"], 2)
        row.update({"entity_type": "reading", "entity_id": BOOK, "payload": {"publicationId": BOOK, "publicationRevision": 1, "locator": {"type": "legacy", "chapter": 0, "position": 0}, "shelf": "reading"}})
        self.write_reader()
        with self.assertRaises(ValueError): self.check_reader()

    def test_reader_rich_locator_checks_publication_block_and_unicode_offset(self):
        payload = {"publicationId": BOOK, "publicationRevision": 1, "locator": {"publicationId": BOOK, "publicationRevision": 1, "chapterId": "c-0", "blockId": "c-0-b-1", "offset": 1, "progression": 0.1}, "shelf": "reading"}
        books = {BOOK: self.inventory["tables"]["books"][0]}
        backup.validate_reader_payload("reading", BOOK, payload, self.snapshot / "books", books, {})
        for key, value in (("publicationId", MISSING), ("blockId", "missing"), ("offset", 100000)):
            modified = copy.deepcopy(payload); modified["locator"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): backup.validate_reader_payload("reading", BOOK, modified, self.snapshot / "books", books, {})
        self.content["chapters"][0]["blocks"][1]["text"] = "😀Текст"
        write(self.snapshot / "books" / BOOK / "book.json", self.content)
        with self.assertRaises(ValueError): backup.validate_reader_payload("reading", BOOK, payload, self.snapshot / "books", books, {})

    def test_reader_quote_matches_immutable_text_and_context(self):
        books = {BOOK: self.inventory["tables"]["books"][0]}
        payload = {"publicationId": BOOK, "publicationRevision": 1, "locator": {"publicationId": BOOK, "publicationRevision": 1, "chapterId": "c-0", "blockId": "c-0-b-1", "offset": 0, "quote": {"exact": "Текст", "suffix": " с заметкой."}}, "note": "Личное"}
        backup.validate_reader_payload("bookmark", MARK, payload, self.snapshot / "books", books, {})
        payload["locator"]["quote"]["suffix"] = "другой текст"
        with self.assertRaises(ValueError): backup.validate_reader_payload("bookmark", MARK, payload, self.snapshot / "books", books, {})

    def test_complete_snapshot_preserves_unicode_notes_and_isolated_copy(self):
        result = self.finalize()
        self.assertEqual(result["library"]["chaptersOpened"], 1)
        self.assertEqual(result["library"]["readingAndBookmarksChecked"], 2)
        self.assertEqual(result["library"]["catalogItemsChecked"], 1)
        restored = self.root / "restored"
        shutil.copytree(self.snapshot, restored)
        inventory = copy.deepcopy(self.inventory); inventory["sessionRows"] = 0
        write(restored / "db-inventory.json", inventory)
        report = backup.compare_restore(self.snapshot, restored, restored / "books")
        self.assertEqual(report["status"], "validated")
        self.assertEqual(json.loads((self.snapshot / "manifest.json").read_text(encoding="utf-8"))["restoreVerified"], False)

    def test_missing_dump_never_publishes_ready_marker(self):
        (self.snapshot / "database.dump").unlink()
        with self.assertRaises(ValueError): self.finalize()
        self.assertEqual(json.loads((self.snapshot / "manifest.json").read_text())["status"], "building")

    def test_handler_restoration_failure_forbids_ready(self):
        write(self.snapshot / "snapshot-metadata.json", {"handlersRestored": False, "snapshotProtocol": "pg-exported-repeatable-read"})
        with self.assertRaises(ValueError): self.finalize()

    def test_file_corruption_and_unlisted_file_fail_preflight(self):
        self.finalize()
        path = self.snapshot / "books" / BOOK / "book.json"
        original = path.read_bytes(); path.write_bytes(original + b" ")
        with self.assertRaises(ValueError): backup.preflight(self.snapshot)
        path.write_bytes(original); (self.snapshot / "unlisted.txt").write_text("unexpected")
        with self.assertRaises(ValueError): backup.preflight(self.snapshot)

    def test_path_traversal_absolute_ads_duplicate_and_casefold_rejected(self):
        self.finalize(); manifest = json.loads((self.snapshot / "manifest.json").read_text())
        for path in ("../outside", "/etc/passwd", "C:/secret", "books/a:stream", "books/./a", "books/a."):
            with self.subTest(path=path), self.assertRaises(ValueError):
                changed = copy.deepcopy(manifest); changed["files"][0]["path"] = path
                backup.preflight(self.snapshot, changed)
        for suffix in ("", "case"):
            changed = copy.deepcopy(manifest); item = copy.deepcopy(changed["files"][0])
            if suffix: item["path"] = item["path"].upper()
            changed["files"].append(item)
            with self.assertRaises(ValueError): backup.preflight(self.snapshot, changed)

    def test_images_and_future_published_artifact_hashes_checked(self):
        raw = backup.PNG + b"test-only-not-a-decoded-image"
        self.content["assets"] = {"image-1.png": base64.b64encode(raw).decode()}
        self.content["chapters"][0]["blocks"].append({"type": "image", "asset": "image-1.png", "text": "Карта"})
        write(self.snapshot / "books" / BOOK / "book.json", self.content)
        (self.snapshot / "books" / BOOK / "image-1.png").write_bytes(raw)
        folder = self.snapshot / "books" / BOOK
        entries = []
        for name in ("book.json", "image-1.png"):
            item = backup.file_record(folder / name); item["path"] = name; entries.append(item)
        row = self.inventory["tables"]["books"][0]
        row.update({"content_sha256": entries[0]["sha256"], "content_bytes": entries[0]["bytes"], "artifact_manifest": {"schemaVersion": 1, "files": entries}})
        self.assertEqual(backup.validate_library(self.snapshot / "books", self.inventory)["assetsChecked"], 1)
        (folder / "image-1.png").write_bytes(raw + b"changed")
        with self.assertRaises(ValueError): backup.validate_library(self.snapshot / "books", self.inventory)

    def test_unreadable_text_and_bad_relationship_fail(self):
        self.content["chapters"][0]["blocks"][1]["text"] = {"unreadable": True}
        write(self.snapshot / "books" / BOOK / "book.json", self.content)
        with self.assertRaises(ValueError): backup.validate_library(self.snapshot / "books", self.inventory)
        self.content["chapters"][0]["blocks"][1]["text"] = "Readable"
        write(self.snapshot / "books" / BOOK / "book.json", self.content)
        self.inventory["tables"]["reading"][0]["book_id"] = MISSING
        with self.assertRaises(ValueError): backup.validate_library(self.snapshot / "books", self.inventory)

    def test_historical_import_link_is_reported_without_repair(self):
        self.inventory["tables"]["imports"][0]["book_id"] = MISSING
        result = backup.validate_library(self.snapshot / "books", self.inventory)
        self.assertEqual(result["historicalImportBookReferences"], 1)
        self.assertEqual(self.inventory["tables"]["imports"][0]["book_id"], MISSING)

    def test_missing_catalogue_placeholder_allowed_but_cycle_rejected(self):
        catalog = self.inventory["tables"]["profile_catalogs"][0]["catalogs"][0]
        catalog["items"][0]["id"] = MISSING
        self.assertEqual(backup.validate_library(self.snapshot / "books", self.inventory)["unavailableCatalogReferences"], 1)
        catalog["parent"] = CATALOG
        with self.assertRaises(ValueError): backup.validate_library(self.snapshot / "books", self.inventory)

    def test_restore_detects_note_or_table_data_changes(self):
        self.finalize(); restored = self.root / "restored"; shutil.copytree(self.snapshot, restored)
        value = copy.deepcopy(self.inventory); value["sessionRows"] = 0; value["tables"]["bookmarks"][0]["note"] = "lost"
        write(restored / "db-inventory.json", value)
        with self.assertRaises(ValueError): backup.compare_restore(self.snapshot, restored, restored / "books")
        value["tables"] = self.inventory["tables"]; write(restored / "db-inventory.json", value)
        path = restored / "db-table-fingerprints.jsonl"; path.write_text(path.read_text().replace('"count": 1', '"count": 2', 1))
        with self.assertRaises(ValueError): backup.compare_restore(self.snapshot, restored, restored / "books")

    def test_legacy_manifest_accepts_old_size_field_and_unlisted_readme(self):
        files = []
        for name, path in backup.files_under(self.snapshot).items():
            if name == "manifest.json": continue
            record = backup.file_record(path); files.append({"path": name.replace("/", "\\"), "size": record["bytes"], "sha256": record["sha256"].upper()})
        write(self.snapshot / "manifest.json", {"version": 1, "files": files})
        (self.snapshot / "README.md").write_text("Old script added README after manifest")
        result = backup.preflight(self.snapshot)
        self.assertTrue(result["legacyBaselineUnavailable"])

    def test_source_archive_excludes_runtime_build_signing_and_embedded_assets(self):
        project = self.root / "project"
        for name in ("compose.yaml", "package.json", "server/db.mjs", "src/app.jsx", "android/app/src/main/assets/index.js", "android/app/build/app.apk", "android/key.properties", ".env", "ops/.env.local", "desktop/private.key", "scripts/signing.ps1"):
            path = project / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text("fixture", encoding="utf-8")
        destination = self.root / "source.tar.gz"; backup.source_archive(project, destination)
        with tarfile.open(destination) as bundle: names = set(bundle.getnames())
        self.assertEqual(names, {"compose.yaml", "package.json", "server/db.mjs", "src/app.jsx"})
        self.assertFalse(backup.source_allowed("android/app/src/main/assets/sub/data.json"))

    def test_source_archive_rejects_private_key_or_symlink_member(self):
        source = self.root / "bad.tar.gz"
        with tarfile.open(source, "w:gz") as bundle:
            item = tarfile.TarInfo("server/link"); item.type = tarfile.SYMTYPE; item.linkname = "../../outside"; bundle.addfile(item)
        with self.assertRaises(ValueError): backup.check_source_archive(source)
        project = self.root / "project"
        for name in ("compose.yaml", "package.json", "server/db.mjs"):
            path = project / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text("fixture")
        (project / "server/db.mjs").write_text("-----" + "BEGIN PRIVATE KEY-----\nfixture\n")
        with self.assertRaises(ValueError): backup.source_archive(project, self.root / "keys.tar.gz")

    def test_snapshot_sql_holds_same_exported_snapshot_and_checks_shell_status(self):
        sql = backup.inventory_sql("/tmp/gargantua-snapshot-" + "a" * 32, True)
        self.assertLess(sql.index("pg_export_snapshot()"), sql.index("pg_dump"))
        self.assertLess(sql.index("pg_dump"), sql.index("db-inventory.json"))
        self.assertLess(sql.index("db-table-fingerprints.jsonl"), sql.rindex("COMMIT;"))
        self.assertIn('--snapshot="$GARGANTUA_SNAPSHOT"', sql)
        self.assertIn("--exclude-table-data=public.sessions", sql)
        self.assertIn("\\if :SHELL_ERROR\nSELECT 1/0;", sql)
        self.assertIn("tablename<>'sessions'", sql)
        self.assertIn("AS has_reader", sql)
        self.assertIn("reader-metadata.jsonl", sql)
        self.assertIn("max(octet_length(line)+1),0)<=131072", sql)
        self.assertIn("sum(octet_length(line)+1),0)<=134217728", sql)
        self.assertIn("count(*)<=500000", sql)
        self.assertIn("ORDER BY profile_id,device_id,counter", sql)
        self.assertIn("'readerMetadataFormat','source-jsonl-v1'", sql)
        self.assertIn("'public.gargantua_table_fingerprint_v2(regclass)'", sql)
        self.assertIn("public.gargantua_table_fingerprint_v2(%L::regclass)", sql)
        for remote in ("/tmp/../library", "/tmp/gargantua-snapshot-" + "a" * 32 + ";touch /tmp/x"):
            with self.assertRaises(ValueError): backup.inventory_sql(remote, True)

    def test_cleanup_requires_matching_owner_and_rejects_reparse_points(self):
        target = self.root / "restore"; target.mkdir(); token = "b" * 32
        write(target / "restore-owner.json", {"root": str(target.resolve()), "token": token})
        self.assertTrue(backup.cleanup_check(target, token)["cleanupAllowed"])
        with self.assertRaises(ValueError): backup.cleanup_check(target, "a" * 32)
        with mock.patch.object(backup, "linked", side_effect=lambda path: Path(path).name == "restore-owner.json"):
            with self.assertRaises(ValueError): backup.cleanup_check(target, token)

    def test_generated_psql_file_has_lf_not_windows_crlf(self):
        output = self.root / "query.sql"
        with mock.patch.object(backup.sys, "argv", ["backup-artifacts.py", "inventory-sql", "--remote", "/tmp/gargantua-snapshot-" + "a" * 32, "--snapshot", "--output", str(output)]):
            backup.main()
        raw = output.read_bytes()
        self.assertNotIn(b"\r", raw)
        self.assertIn(b"/database.dump\n", raw)


if __name__ == "__main__":
    unittest.main()
