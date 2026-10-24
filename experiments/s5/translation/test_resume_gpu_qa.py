import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("resume_gpu_qa", Path(__file__).with_name("resume-gpu-qa.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoverySafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = recovery.gpu.ROOT / recovery.CASE_RELATIVE
        cls.case = recovery.load_json(cls.directory / "case.json")
        # The snapshot remains available after the real recovery updates result.json.
        source = cls.directory / "interrupted-result.json"
        cls.previous = recovery.load_json(source if source.exists() else cls.directory / "results/result.json")

    def completed_fixture(self):
        current = copy.deepcopy(self.previous)
        pending = self.previous["pendingDraft"]
        for number in range(1, 5):
            row = copy.deepcopy(self.previous["segments"][number-1])
            row["repeatIndex"] = 2
            if number == 1:
                row["draft"] = copy.deepcopy(pending["result"])
                row["draftTextSha256"] = pending["draftTextSha256"]
            current["segments"].append(row)
        current.update(status="completed", pendingDraft=None, resumeCount=self.previous.get("resumeCount", 0)+1)
        current["invocations"].append({"resumedAtCompletedSegments": 4, "reusedPendingDraft": True})
        self.checksum(current)
        return current

    @staticmethod
    def checksum(report):
        report["checkpointSha256"] = recovery.bench.canonical_digest({k: v for k, v in report.items() if k != "checkpointSha256"})

    def test_exact_failed_case_and_checkpoint_are_bound(self):
        self.assertEqual(recovery.bench.sha256(self.directory / "case.json"), recovery.CASE_SHA256)
        recovery.validate_original(self.case, self.previous)
        for relative, expected in recovery.FROZEN_FILES.items():
            with self.subTest(relative=relative):
                if relative.endswith("/run-gpu.py"):
                    # The reviewed post-recovery late-abort fix creates a new
                    # launcher revision; original case/recovery history stays pinned.
                    self.assertEqual(self.case["runnerSha256"], expected)
                else:
                    self.assertEqual(recovery.bench.sha256(recovery.gpu.ROOT / relative), expected)

    def test_original_cleanup_and_image_mismatch_are_rejected(self):
        for mutation in ("unknown", "missing-name", "different-image"):
            case = copy.deepcopy(self.case)
            if mutation == "unknown":
                case["cleanup"]["containers"][0]["verifiedStopped"] = False
            elif mutation == "missing-name":
                case["containers"].pop("health")
            else:
                case["clientImage"]["id"] = "sha256:" + "f"*64
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                recovery.validate_original(case, self.previous)

    def test_case_directory_rejects_alternate_and_escaping_paths(self):
        for path in ("../elsewhere", ".local/s5-pilot/other", recovery.CASE_RELATIVE + ",bad", str(recovery.gpu.ROOT)):
            with self.subTest(path=path), self.assertRaises(ValueError):
                recovery.case_directory(path)
        self.assertEqual(recovery.case_directory(recovery.CASE_RELATIVE), self.directory)

    def test_daemon_failure_never_proves_stopped(self):
        for output in (subprocess.CompletedProcess([], 1, "", "daemon unavailable"),
                       subprocess.CompletedProcess([], 0, "abc running\n", ""),
                       subprocess.CompletedProcess([], 0, "abc restarting\n", ""),
                       subprocess.CompletedProcess([], 0, "unexpected\n", "")):
            with self.subTest(output=output), mock.patch.object(recovery.gpu, "command", return_value=output), self.assertRaises(RuntimeError):
                recovery.query_stopped(self.case["containers"]["server"])
        for text, state in (("", "absent"), ("abc exited\n", "exited"), ("abc dead\n", "dead")):
            with mock.patch.object(recovery.gpu, "command", return_value=subprocess.CompletedProcess([], 0, text, "")):
                self.assertEqual(recovery.query_stopped(self.case["containers"]["server"])["state"], state)

    def test_active_pilot_or_unknown_daemon_refuses_lease(self):
        for code, text in ((1, ""), (0, "gargantua-s5-other-server\n")):
            with mock.patch.object(recovery.gpu, "command", return_value=subprocess.CompletedProcess([], code, text, "")), self.assertRaises(RuntimeError):
                recovery.idle_pilot()

    def test_hot_missing_and_non_numeric_temperature_refused(self):
        for code, text in ((0, "66\n"), (0, "87\n"), (0, "N/A\n"), (1, ""), (0, ""), (0, "60\n70\n"), (0, "-1\n")):
            with self.subTest(text=text), mock.patch.object(recovery.gpu, "command", return_value=subprocess.CompletedProcess([], code, text, "")), self.assertRaises(RuntimeError):
                recovery.temperature_admission()
        with mock.patch.object(recovery.gpu, "command", return_value=subprocess.CompletedProcess([], 0, "65\n", "")):
            self.assertEqual(recovery.temperature_admission()["runtimeThermalAbortCelsius"], 87)

    def test_argv_preserves_recipe_and_separates_writable_evidence(self):
        names = {role: "gargantua-s5-test-recovery-" + role for role in ("server", "client", "health")}
        server, client = recovery.resumed_arguments(self.case, names, recovery.gpu.MODEL_ROOT / recovery.gpu.EXTRA_CASE, self.directory / "results")
        self.assertEqual(recovery.policy.recipe_sha256(server), self.case["qaServerRecipeSha256"])
        self.assertIn("--no-context-shift", server)
        self.assertEqual(server[server.index("--ctx-size")+1], "4096")
        self.assertEqual(client[-1], "--resume")
        mounts = [client[i+1] for i, arg in enumerate(client) if arg == "--mount"]
        self.assertEqual([m for m in mounts if not m.endswith(",readonly")],
            ["type=bind,source=" + str(self.directory / "results") + ",target=/out"])
        self.assertFalse(any("resume-02" in mount or "interrupted-result" in mount or "reference.private" in mount for mount in mounts))
        changed = copy.deepcopy(self.case)
        changed["qaServerRecipeSha256"] = "0"*64
        with self.assertRaises(ValueError):
            recovery.resumed_arguments(changed, names, recovery.gpu.MODEL_ROOT / recovery.gpu.EXTRA_CASE, self.directory / "results")

    def test_completion_proves_prior_rows_and_pending_draft_reuse(self):
        result = recovery.verify_completion(self.previous, self.completed_fixture())
        self.assertTrue(result["priorRowsUnchanged"])
        self.assertTrue(result["reusedPendingDraft"])
        self.assertEqual(result["newCompletedRows"], 4)

    def test_late_server_thermal_abort_cannot_be_accepted_after_client_success(self):
        clean = {"abort": None, "cleanupVerified": True, "cleanup": [{"verifiedStopped": True}]}
        recovery.validate_telemetry({"server": clean, "client": clean})
        for kind in ("thermal-abort", "unknown-cleanup", "missing-abort", "missing-server"):
            summaries = {"server": copy.deepcopy(clean), "client": copy.deepcopy(clean)}
            if kind == "thermal-abort":
                summaries["server"]["abort"] = "GPU temperature reached 87 C"
            elif kind == "unknown-cleanup":
                summaries["server"]["cleanupVerified"] = False
            elif kind == "missing-abort":
                summaries["server"].pop("abort")
            else:
                summaries.pop("server")
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                recovery.validate_telemetry(summaries)

    def test_recomputed_checksums_cannot_hide_mutation_or_regenerated_draft(self):
        for field in ("prior-row", "draft", "pending-proof", "plan", "identity", "partial"):
            current = self.completed_fixture()
            if field == "prior-row":
                current["segments"][0]["text"] += " changed"
            elif field == "draft":
                current["segments"][4]["draft"]["wallSeconds"] += 1
            elif field == "pending-proof":
                current["invocations"][-1]["reusedPendingDraft"] = False
            elif field == "plan":
                current["segments"][-1]["id"] = "chapter-bridge-1"
            elif field == "identity":
                current["identity"]["settings"]["maxInputTokens"] = 2000
            else:
                current["segments"].pop()
            self.checksum(current)
            with self.subTest(field=field), self.assertRaises(ValueError):
                recovery.verify_completion(self.previous, current)


if __name__ == "__main__":
    unittest.main()
