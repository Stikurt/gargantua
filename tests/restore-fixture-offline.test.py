"""Offline synthetic-fixture assertions only; no PostgreSQL/Docker runtime claim."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
import uuid

PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("restore_fixture", PROJECT / "tests/fixtures/restore-fixture.py")
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)


class RestoreFixtureOffline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = PROJECT / ".local/test-results" / ("restore-fixture-offline-" + uuid.uuid4().hex)
        cls.seed = cls.root / "seed"
        cls.seed.mkdir(parents=True, exist_ok=False)
        FIXTURE.write_json(cls.root / "test-owner.json", {"token": cls.root.name, "synthetic": True})
        FIXTURE.build(cls.seed)
        cls.expected = FIXTURE.read_json(cls.seed / "expected.json")
        e = cls.expected
        cls.before = {"sessionRows": 3, "tables": {
            "profiles": [{k: v for k, v in row.items() if k != "password"} for row in e["profiles"]],
            "imports": e["imports"], "books": e["books"], "reading": e["reading"], "bookmarks": e["bookmarks"],
            "profile_catalogs": e["catalogs"], "import_attempts": e["attempts"],
            "discovery_requests": e["discoveryRequests"], "discovery_attempts": e["discoveryAttempts"], "discovery_idempotency": e["discoveryIdempotency"],
            "settings": [{"id": 1, "imports_paused": False, "serving_paused": False}],
        }}
        cls.before["tables"].update(e["ranobeTables"])
        cls.after = copy.deepcopy(cls.before)
        cls.after["sessionRows"] = 0
        cls.after["tables"]["settings"][0].update(imports_paused=True, serving_paused=True)
        for row in cls.after["tables"]["imports"]:
            row.update(attempt_token=None, lease_expires_at=None)
            if row["status"] in ("uploading", "queued", "processing"):
                row.update(status="error", security_state="error", stage="Recovery hold", error="Recovery hold")
        for row in cls.after["tables"]["import_attempts"]:
            if row["state"] in ("running", "prepared", "placed"):
                row.update(state="interrupted", ended_at="2026-01-01T00:00:00+00:00", error="Recovery hold")
        for row in cls.after["tables"]["discovery_requests"]:
            row.update(attempt_token=None, lease_expires_at=None)
            if row["status"] in ("pending-approval", "queued", "processing", "needs-review", "selected", "acquiring"):
                row.update(status="pending-approval", revision=row["revision"] + 1, approved_by=None, decision_reason=None, error="Recovery hold")
        for row in cls.after["tables"]["discovery_attempts"]:
            if row["state"] == "running":
                row.update(state="interrupted", ended_at="2026-01-01T00:00:00+00:00", error="Recovery hold")
        for row in cls.after["tables"]["ranobe_feeds"]:
            row.update(auto_update=False, active_import_id=None, revision=row["revision"] + 1, updated_at="2026-01-01T00:00:00+00:00")
        for row in cls.after["tables"]["ranobe_runs"]:
            if row["status"] == "building": row["status"] = "abandoned"
        cls.after["tables"]["ranobe_scratch"] = []
        cls.snapshot = cls.root / "snapshot"
        cls.snapshot.mkdir()
        # This is a synthetic assertion input, not a database snapshot or SQL proof.
        fps = [{"table": name, "count": count, "fingerprint": "0" * 32} for name, count in e["tableCounts"].items()]
        cls.fingerprint_text = "".join(json.dumps(row) + "\n" for row in fps)
        (cls.snapshot / "db-table-fingerprints.jsonl").write_text(cls.fingerprint_text, encoding="utf-8")
        FIXTURE.write_json(cls.root / "source-state.json", cls.before)

    def assert_state(self, state):
        target = self.root / self._testMethodName
        target.mkdir(exist_ok=False)
        FIXTURE.write_json(target / "state.json", state)
        (target / "db-table-fingerprints.jsonl").write_text(self.fingerprint_text, encoding="utf-8")
        return FIXTURE.assert_after(self.seed, self.snapshot, target, self.root / "source-state.json", target / "state.json")

    def test_seed_cross_references_and_claims(self):
        requests = {row["id"]: row for row in self.expected["discoveryRequests"]}
        imports = {row["id"]: row for row in self.expected["imports"]}
        attempts = {row["token"]: row for row in self.expected["discoveryAttempts"]}
        self.assertEqual(len(requests), 9)
        self.assertEqual(len(attempts), 6)
        counts = {}
        for row in requests.values():
            if row["status"] == "processing":
                self.assertTrue(row["attempt_token"] and row["lease_expires_at"] and row["phase"])
            if row["attempt_token"]:
                self.assertEqual(attempts[row["attempt_token"]]["request_id"], row["id"])
            if row["plan"]:
                self.assertGreater(row["plan_revision"], 0)
                if row["selected_candidate_id"]:
                    self.assertIn(row["selected_candidate_id"], {c["id"] for c in row["plan"]["candidates"]})
            else:
                self.assertEqual((row["plan_revision"], row["selected_candidate_id"]), (0, None))
            if row["import_id"]:
                linked = imports[row["import_id"]]
                self.assertEqual(linked["requested_by"], row["requested_by"])
                self.assertEqual(linked["options"]["discovery"]["requestId"], row["id"])
            if row["status"] not in ("book-ready", "cancelled", "error"):
                counts[row["requested_by"]] = counts.get(row["requested_by"], 0) + 1
        self.assertEqual(sum(counts.values()), 6)
        self.assertLessEqual(max(counts.values()), 5)
        for key in self.expected["discoveryIdempotency"]:
            row = requests[key["request_id"]]
            self.assertEqual((key["profile_id"], key["body_hash"]), (row["requested_by"], row["body_hash"]))
        sql = (self.seed / "seed-after-books.sql").read_text(encoding="utf-8")
        self.assertLess(sql.index("INSERT INTO discovery_requests"), sql.index("INSERT INTO discovery_attempts"))
        self.assertLess(sql.index("INSERT INTO discovery_attempts"), sql.index("UPDATE discovery_requests SET status='processing'"))

    def test_expected_hold_is_accepted(self):
        report = self.assert_state(copy.deepcopy(self.after))
        self.assertEqual((report["discoveryRequestsHeld"], report["discoveryAttemptsInterrupted"], report["discoveryIdempotencyRowsPreserved"]), (6, 2, 9))

    def test_retained_claim_is_rejected(self):
        state = copy.deepcopy(self.after)
        state["tables"]["discovery_requests"][2]["attempt_token"] = self.expected["discoveryRequests"][2]["attempt_token"]
        with self.assertRaisesRegex(ValueError, "retained a discovery claim"):
            self.assert_state(state)

    def test_changed_plan_is_rejected(self):
        state = copy.deepcopy(self.after)
        state["tables"]["discovery_requests"][5]["plan"] = None
        with self.assertRaisesRegex(ValueError, "plan/input/output/provenance/import links"):
            self.assert_state(state)

    def test_changed_import_link_is_rejected(self):
        state = copy.deepcopy(self.after)
        state["tables"]["discovery_requests"][5]["import_id"] = None
        with self.assertRaisesRegex(ValueError, "plan/input/output/provenance/import links"):
            self.assert_state(state)

    def test_changed_terminal_outcome_is_rejected(self):
        state = copy.deepcopy(self.after)
        state["tables"]["discovery_requests"][6]["status"] = "pending-approval"
        with self.assertRaisesRegex(ValueError, "terminal discovery outcome"):
            self.assert_state(state)

    def test_changed_idempotency_is_rejected(self):
        state = copy.deepcopy(self.after)
        state["tables"]["discovery_idempotency"][0]["body_hash"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "idempotency/provenance"):
            self.assert_state(state)

    def test_retained_running_attempt_is_rejected(self):
        state = copy.deepcopy(self.after)
        state["tables"]["discovery_attempts"][0]["state"] = "running"
        with self.assertRaisesRegex(ValueError, "active discovery attempt"):
            self.assert_state(state)

    def test_changed_terminal_attempt_history_is_rejected(self):
        state = copy.deepcopy(self.after)
        state["tables"]["discovery_attempts"][1]["error"] = "unexpected mutation"
        with self.assertRaisesRegex(ValueError, "terminal discovery attempt history"):
            self.assert_state(state)

    def test_ranobe_previous_head_change_is_rejected(self):
        state = copy.deepcopy(self.after)
        state["tables"]["ranobe_feeds"][0]["head_run_id"] = state["tables"]["ranobe_runs"][1]["id"]
        with self.assertRaisesRegex(ValueError, "previous head/branch/provenance"):
            self.assert_state(state)

    def test_ranobe_building_run_cannot_auto_resume(self):
        state = copy.deepcopy(self.after)
        state["tables"]["ranobe_runs"][1]["status"] = "building"
        with self.assertRaisesRegex(ValueError, "retained a building run"):
            self.assert_state(state)

    def test_ranobe_safe_checkpoint_change_is_rejected(self):
        state = copy.deepcopy(self.after)
        state["tables"]["ranobe_chapters"][3]["prepared_book"]["title"] = "Changed"
        with self.assertRaisesRegex(ValueError, "safe Ranobe checkpoints"):
            self.assert_state(state)

    def test_ranobe_raw_tracker_cannot_survive_restore(self):
        state = copy.deepcopy(self.after)
        state["tables"]["ranobe_scratch"] = copy.deepcopy(self.before["tables"]["ranobe_scratch"])
        with self.assertRaisesRegex(ValueError, "excluded raw quarantine"):
            self.assert_state(state)

    def test_no_change_result_and_initiator_are_preserved_by_hold(self):
        request = self.after["tables"]["ranobe_feed_requests"][-1]
        runs = {row["id"]: row for row in self.after["tables"]["ranobe_runs"]}
        imports = {row["id"]: row for row in self.after["tables"]["imports"]}
        self.assertNotEqual(request["import_id"], runs[request["result_run_id"]]["import_id"])
        self.assertEqual(imports[request["import_id"]]["status"], "completed")
        report = self.assert_state(copy.deepcopy(self.after))
        self.assertEqual(report["ranobeNoChangeResultsPreserved"], 1)

    def test_changed_no_change_result_is_rejected(self):
        state = copy.deepcopy(self.after)
        state["tables"]["ranobe_feed_requests"][-1]["result_run_id"] = None
        with self.assertRaisesRegex(ValueError, "safe Ranobe checkpoints/parts/request history"):
            self.assert_state(state)


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RestoreFixtureOffline))
    if hasattr(RestoreFixtureOffline, "root"):
        FIXTURE.write_json(RestoreFixtureOffline.root / "report.json", {
            "status": "PASS" if result.wasSuccessful() else "FAIL", "scope": "offline fixture generation/assertion checks only",
            "tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
            "dockerCommands": False, "postgresExecuted": False, "runtimeAccepted": False,
        })
        print("Offline fixture assertion report:", RestoreFixtureOffline.root / "report.json")
    raise SystemExit(0 if result.wasSuccessful() else 1)
