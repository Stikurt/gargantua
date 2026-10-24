"""Coordinator failure tests: mocked Docker, no container/model/book is run."""
import argparse
from contextlib import ExitStack, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("run_container", Path(__file__).with_name("run-container.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
NAME = "gargantua-s5-unit-owned"
MONITOR = "gargantua-s5-unit-monitor"


class CleanupProofTests(unittest.TestCase):
    def check(self, replies):
        with mock.patch.object(runner, "command", side_effect=replies) as commands:
            result = runner.ensure_stopped(NAME)
        return result, [call.args[0] for call in commands.call_args_list]

    def test_successful_empty_query_proves_absence_without_stopping(self):
        result, commands = self.check([(0, "")])
        self.assertTrue(result["verifiedStopped"])
        self.assertEqual(result["observations"], ["absent"])
        self.assertEqual(len(commands), 1)
        self.assertIn("name=^/" + NAME + "$", commands[0])

    def test_cleanup_rejects_unowned_names_without_docker_access(self):
        with mock.patch.object(runner, "command") as commands:
            for name in ("cotology-worker", "gargantua-s5-../", "gargantua-s5-x;stop", "gargantua-s5-x y", ""):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    runner.ensure_stopped(name)
            commands.assert_not_called()

    def test_successful_exited_or_dead_query_proves_stopped(self):
        for state in ("exited", "dead"):
            with self.subTest(state=state):
                result, commands = self.check([(0, "abc123 " + state)])
                self.assertTrue(result["verifiedStopped"])
                self.assertEqual(len(commands), 1)

    def test_daemon_error_never_proves_absence(self):
        result, _ = self.check([(1, "")])
        self.assertFalse(result["verifiedStopped"])
        self.assertEqual(result["observations"], ["unknown"])

    def test_query_timeout_never_proves_absence(self):
        result, _ = self.check([(-1, "")])
        self.assertFalse(result["verifiedStopped"])

    def test_successful_stop_requires_new_successful_state_proof(self):
        result, commands = self.check([(0, "abc running"), (0, NAME), (1, "")])
        self.assertFalse(result["verifiedStopped"])
        self.assertEqual(result["observations"], ["running", "unknown"])
        self.assertEqual(commands[1][:2], ["docker", "stop"])

    def test_failed_stop_can_be_followed_by_kill_and_proven_exit(self):
        result, commands = self.check([(0, "abc running"), (1, ""), (0, "abc running"),
                                       (0, NAME), (0, "abc exited")])
        self.assertTrue(result["verifiedStopped"])
        self.assertEqual(result["observations"], ["running", "running", "exited"])
        self.assertEqual(commands[3], ["docker", "kill", NAME])

    def test_failed_kill_or_failed_final_query_retains_uncertainty(self):
        for final in ((0, "abc running"), (1, ""), (-1, "")):
            with self.subTest(final=final):
                result, _ = self.check([(0, "abc running"), (1, ""), (0, "abc running"),
                                        (1, ""), final])
                self.assertFalse(result["verifiedStopped"])

    def test_stop_error_does_not_override_independent_stopped_proof(self):
        result, commands = self.check([(0, "abc running"), (1, ""), (0, "")])
        self.assertTrue(result["verifiedStopped"])
        self.assertEqual(len(commands), 3)

    def test_paused_created_restarting_containers_require_cleanup(self):
        for state in ("paused", "created", "restarting"):
            with self.subTest(state=state):
                result, commands = self.check([(0, "abc " + state), (0, NAME), (0, "abc exited")])
                self.assertTrue(result["verifiedStopped"])
                self.assertEqual(commands[1][:2], ["docker", "stop"])

    def test_multiple_or_unrecognized_rows_are_not_a_stopped_proof(self):
        for raw in ("abc exited\ndef running", "abc removing", "abc mystery", "malformed"):
            with self.subTest(raw=raw):
                result, _ = self.check([(0, raw)])
                self.assertFalse(result["verifiedStopped"])


class FakeProcess:
    def __init__(self, polls=(None, 0)):
        self.polls = iter(polls)
        self.returncode = None

    def poll(self):
        try:
            self.returncode = next(self.polls)
        except StopIteration:
            pass
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return 0

    def kill(self):
        self.returncode = -9


class WrapperTelemetryTests(unittest.TestCase):
    def run_case(self, *, gpu=(1, ""), memory=None, polls=(None, 0), ps=(0, ""), monitors=(), extra=()):
        # All OS/process access is mocked. Temporary files contain JSON only.
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "case"
            argv = ["run-container.py", "--name", NAME, "--output", str(output), "--timeout", "30"]
            for monitor in monitors:
                argv.extend(["--monitor", monitor])
            argv.extend(["--", "run", "--name", NAME, *extra, "fixture-image"])
            commands = []

            def response(args, timeout=8):
                commands.append(args)
                if args[0] == "nvidia-smi":
                    return gpu
                if args[:2] == ["docker", "exec"]:
                    return (1, "")
                if args[:2] == ["docker", "ps"]:
                    return ps
                raise AssertionError("unexpected command: " + repr(args))

            error = None
            with ExitStack() as stack:
                stack.enter_context(mock.patch.object(sys, "argv", argv))
                stack.enter_context(mock.patch.object(runner.sys, "platform", "win32"))
                memory_mock = mock.Mock(return_value=4 * 1024**3) if memory is None else mock.Mock(side_effect=memory)
                stack.enter_context(mock.patch.object(runner, "free_memory", memory_mock))
                stack.enter_context(mock.patch.object(runner, "command", side_effect=response))
                launched = stack.enter_context(mock.patch.object(runner.subprocess, "Popen", return_value=FakeProcess(polls)))
                stack.enter_context(mock.patch.object(runner.time, "sleep", return_value=None))
                stack.enter_context(redirect_stdout(io.StringIO()))
                try:
                    runner.main()
                except (SystemExit, RuntimeError, ValueError) as exc:
                    error = exc
            summary_file = output / "telemetry-summary.json"
            summary = json.loads(summary_file.read_text()) if summary_file.exists() else None
            return error, summary, commands, launched.call_count

    def test_missing_gpu_is_null_not_measured_zero(self):
        error, summary, _, launches = self.run_case()
        self.assertIsNone(error)
        self.assertEqual(launches, 1)
        self.assertIsNone(summary["peaks"]["gpuUsedMiB"])
        self.assertIsNone(summary["peaks"]["gpuTemperatureC"])
        self.assertEqual(summary["measurementAvailability"]["gpuSamples"], 0)
        self.assertEqual(summary["measurementAvailability"]["gpuMissedSamples"], 1)
        self.assertEqual(summary["measurementAvailability"]["cgroupMissedSamples"][NAME], 1)
        self.assertIn("Variable interval", summary["sampling"])

    def test_driver_na_values_are_not_zero_measurements(self):
        error, summary, _, _ = self.run_case(gpu=(0, "N/A, N/A, N/A, N/A, N/A"))
        self.assertIsNone(error)
        self.assertIsNone(summary["peaks"]["gpuUsedMiB"])
        self.assertIsNone(summary["peaks"]["gpuTemperatureC"])

    def test_real_whole_device_values_are_recorded_with_attribution_caveat(self):
        error, summary, _, _ = self.run_case(gpu=(0, "128, 3900, 44, 10, 12.5"))
        self.assertIsNone(error)
        self.assertEqual(summary["peaks"]["gpuUsedMiB"], 128)
        self.assertEqual(summary["peaks"]["gpuTemperatureC"], 44)
        self.assertIn("whole-device", summary["scope"])

    def test_unknown_windows_memory_refuses_before_launch(self):
        error, summary, _, launches = self.run_case(memory=[None])
        self.assertIsInstance(error, RuntimeError)
        self.assertIsNone(summary)
        self.assertEqual(launches, 0)

    def test_already_low_host_memory_refuses_before_launch(self):
        error, summary, _, launches = self.run_case(memory=[512 * 1024**2])
        self.assertIsInstance(error, RuntimeError)
        self.assertIn("below 1 GiB", str(error))
        self.assertIsNone(summary)
        self.assertEqual(launches, 0)

    def test_missing_memory_on_two_samples_aborts_with_preserved_reason(self):
        error, summary, _, _ = self.run_case(memory=[4 * 1024**3, None, None], polls=(None, None, 0))
        self.assertIsInstance(error, SystemExit)
        self.assertEqual(error.code, 2)
        self.assertIn("Host memory telemetry unavailable", summary["abort"])
        self.assertTrue(summary["cleanupVerified"])

    def test_unverified_cleanup_is_nonzero_and_never_false_success(self):
        error, summary, _, _ = self.run_case(ps=(1, ""))
        self.assertIsInstance(error, SystemExit)
        self.assertEqual(error.code, 3)
        self.assertFalse(summary["cleanupVerified"])
        self.assertFalse(summary["cleanup"][0]["verifiedStopped"])

    def test_normal_exit_does_not_stop_or_inspect_monitored_server(self):
        error, summary, commands, _ = self.run_case(monitors=(MONITOR,))
        self.assertIsNone(error)
        ps = [row for row in commands if row[:2] == ["docker", "ps"]]
        self.assertEqual(len(ps), 1)
        self.assertIn("name=^/" + NAME + "$", ps[0])
        self.assertEqual([row["name"] for row in summary["cleanup"]], [NAME])

    def test_detached_launch_is_refused_before_popen(self):
        error, _, _, launches = self.run_case(extra=("--detach",))
        self.assertIsInstance(error, ValueError)
        self.assertEqual(launches, 0)

    def test_numeric_na_nan_infinity_do_not_become_zero(self):
        for value in ("N/A", "nan", "inf", "-Infinity", "", "[Not Supported]"):
            with self.subTest(value=value):
                self.assertIsNone(runner.numeric(value))
        self.assertEqual(runner.numeric(" 0 "), 0)
        self.assertEqual(runner.numeric("12.5"), 12.5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if args.report:
        report = {"schemaVersion": 1, "suite": "s5-mocked-coordinator-cleanup-and-telemetry",
                  "tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                  "skipped": len(result.skipped), "success": result.wasSuccessful(),
                  "scope": "Mocked Docker and synthetic JSON only; no model, real process, book or production state.",
                  "sourceHashes": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                   for name in ("run-container.py", "test_run_container.py")}}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)
