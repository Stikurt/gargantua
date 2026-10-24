import importlib.util
import copy
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("run_gpu", Path(__file__).with_name("run-gpu.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherSafetyTests(unittest.TestCase):
    def test_finalized_telemetry_rejects_late_abort_unknown_or_missing_cleanup(self):
        clean = {"abort": None, "exitCode": 0, "cleanupVerified": True, "cleanup": [{"verifiedStopped": True}]}
        launcher.validate_coordinator_telemetry({"server": clean, "client": clean})
        for change in ("thermal", "missing-server", "unknown", "empty-cleanup", "missing-abort"):
            summaries = {"server": copy.deepcopy(clean), "client": copy.deepcopy(clean)}
            if change == "thermal":
                summaries["server"]["abort"] = "GPU temperature reached 87 C"
            elif change == "missing-server":
                summaries.pop("server")
            elif change == "unknown":
                summaries["server"]["cleanupVerified"] = False
            elif change == "empty-cleanup":
                summaries["client"]["cleanup"] = []
            else:
                summaries["server"].pop("abort")
            with self.subTest(change=change), self.assertRaises(ValueError):
                launcher.validate_coordinator_telemetry(summaries)

    def test_successful_client_cannot_hide_server_oom_or_unknown_exit(self):
        clean = {"abort": None, "exitCode": 0, "cleanupVerified": True, "cleanup": [{"verifiedStopped": True}]}
        terminated = {**clean, "exitCode": 143}
        launcher.validate_coordinator_telemetry({"server": terminated, "client": clean})
        for role, exit_code in (("server", 137), ("server", None), ("server", "0"), ("server", False), ("client", 143), ("client", 1)):
            summaries = {"server": copy.deepcopy(clean), "client": copy.deepcopy(clean)}
            summaries[role]["exitCode"] = exit_code
            with self.subTest(role=role, exit_code=exit_code), self.assertRaises(ValueError):
                launcher.validate_coordinator_telemetry(summaries)
        summaries = {"server": copy.deepcopy(clean), "client": copy.deepcopy(clean)}
        summaries["server"].pop("exitCode")
        with self.assertRaises(ValueError):
            launcher.validate_coordinator_telemetry(summaries)

    def test_output_rejects_workspace_escape_and_existing_locations(self):
        for path in ("../elsewhere", str(launcher.ROOT), ".local/s5-pilot", "README.md", ".local/s5-pilot/downloads/qwen3-4b-q4/new-case", ".local/s5-pilot/new,bad-case"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                launcher.checked_output(path)

    def test_mount_commas_and_control_characters_refused(self):
        for value in ("C:/bad,source=/other", "C:/bad\npath"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                launcher.model_mount(value)

    def test_extra_case_requires_explicit_separate_manifest_and_pinned_policy(self):
        args = SimpleNamespace(case=launcher.EXTRA_CASE, extra=False)
        with self.assertRaises(ValueError):
            launcher.selected_manifest(args)
        args.extra = True
        path, target = launcher.selected_manifest(args)
        self.assertTrue(str(path).endswith("translation-extra\\models.lock.json") or str(path).endswith("translation-extra/models.lock.json"))
        self.assertEqual(target, "/pilot/extra-models.lock.json")
        lock = {"models": [{"id": launcher.EXTRA_CASE, "repository": launcher.EXTRA_REPOSITORY, "revision": launcher.EXTRA_REVISION, "provider": "llama-http", "license": "apache-2.0", "files": [dict(launcher.EXTRA_WEIGHT), {"path": "README.md"}]}]}
        launcher.validate_extra_policy(lock, args)
        for field in ("revision", "repository"):
            changed = copy.deepcopy(lock)
            changed["models"][0][field] = "unreviewed"
            with self.assertRaises(ValueError):
                launcher.validate_extra_policy(changed, args)
        changed = copy.deepcopy(lock)
        changed["models"][0]["files"][0]["sha256"] = "0"*64
        with self.assertRaises(ValueError):
            launcher.validate_extra_policy(changed, args)
        args.case = "qwen3-4b-q4"
        with self.assertRaises(ValueError):
            launcher.selected_manifest(args)

    def test_extra_client_mounts_only_manifest_file_and_binds_actual_lock(self):
        args = SimpleNamespace(case=launcher.EXTRA_CASE, extra=True, holdout=False, chapter=False, context=False, glossary=False, repeat=2, backend="cuda")
        argv = launcher.client_args("gargantua-s5-fixture-client", "gargantua-s5-fixture-server", Path("C:/model"), Path("C:/case/results"), "sha256:"+"b"*64, args)
        self.assertEqual(argv[argv.index("--lock")+1], "/pilot/extra-models.lock.json")
        mounts = [argv[index+1] for index, value in enumerate(argv) if value == "--mount"]
        extra = [value for value in mounts if "translation-extra" in value]
        self.assertEqual(len(extra), 1)
        self.assertIn("models.lock.json,target=/pilot/extra-models.lock.json,readonly", extra[0])
        self.assertFalse(any("mmproj" in value.lower() or "mtp" in value.lower() for value in argv))

    def test_actual_extra_manifest_matches_frozen_review_and_exact_weight(self):
        import json
        args = SimpleNamespace(case=launcher.EXTRA_CASE, extra=True)
        path, _ = launcher.selected_manifest(args)
        self.assertEqual(launcher.bench.sha256(path), launcher.EXTRA_LOCK_SHA256)
        launcher.validate_extra_policy(json.loads(path.read_text(encoding="utf-8")), args)

    def test_server_has_no_network_ports_production_or_writeable_models(self):
        argv = launcher.server_args("gargantua-s5-fixture-server", Path("C:/fixture-model"), "sha256:"+"a"*64, "/app/llama-server", "Qwen3-4B-Q4_K_M.gguf")
        self.assertEqual(argv[argv.index("--network")+1], "none")
        self.assertEqual(argv[argv.index("--memory")+1], "5g")
        self.assertEqual(argv[argv.index("--memory-swap")+1], "5g")
        self.assertEqual(argv[argv.index("--user")+1], "1000:1000")
        self.assertIn("--read-only", argv)
        self.assertIn("ALL", argv)
        self.assertIn("127.0.0.1", argv)
        self.assertIn("--gpus", argv)
        self.assertEqual(argv[argv.index("--verbosity")+1], "4")
        self.assertFalse(any(value in argv for value in ("-p", "--publish", "--privileged", "--ipc=host")))
        mounts = [argv[index+1] for index, value in enumerate(argv) if value == "--mount"]
        self.assertEqual(len(mounts), 1)
        self.assertTrue(mounts[0].endswith(",readonly"))
        self.assertNotIn("books", " ".join(argv))

    def test_explicit_cpu_uses_no_gpu_access_and_zero_gpu_layers(self):
        argv = launcher.server_args("gargantua-s5-fixture-server", Path("C:/fixture-model"), "sha256:"+"a"*64, "/app/llama-server", "Qwen3-4B-Q4_K_M.gguf", "cpu")
        self.assertNotIn("--gpus", argv)
        self.assertEqual(argv[argv.index("--n-gpu-layers")+1], "0")
        self.assertEqual(argv[argv.index("--memory")+1], "5g")
        self.assertEqual(argv[argv.index("--network")+1], "none")
        self.assertEqual(launcher.SERVER_IMAGES["cpu"], "ghcr.io/ggml-org/llama.cpp:server")
        args = SimpleNamespace(case="qwen3-4b-q4", holdout=False, context=False, glossary=False, repeat=2, backend="cpu")
        client = launcher.client_args("gargantua-s5-fixture-client", "gargantua-s5-fixture-server", Path("C:/model"), Path("C:/case/results"), "sha256:"+"b"*64, args)
        self.assertEqual(client[client.index("--device")+1], "cpu")

    def test_bounded_cache_is_explicit_extra_profile_not_silent_baseline_change(self):
        name = "gargantua-s5-fixture-server"
        args = launcher.server_args(name, Path("C:/model"), "sha256:"+"a"*64, "/app/llama-server", launcher.EXTRA_WEIGHT["path"], "cuda", True)
        self.assertEqual(args[args.index("--cache-ram")+1], "256")
        self.assertEqual(args[args.index("--ctx-checkpoints")+1], "2")
        original = launcher.server_args(name, Path("C:/model"), "sha256:"+"a"*64, "/app/llama-server", "Qwen3-4B-Q4_K_M.gguf")
        self.assertNotIn("--cache-ram", original)
        self.assertNotIn("--ctx-checkpoints", original)
        with self.assertRaises(ValueError):
            launcher.server_args(name, Path("C:/model"), "sha256:"+"a"*64, "/app/llama-server", "Qwen3-4B-Q4_K_M.gguf", "cuda", True)

    def test_qa_mount_script_runtime_context_and_manifest_are_explicit(self):
        server = launcher.server_args("gargantua-s5-fixture-server", Path("C:/model"), "sha256:"+"a"*64, "/app/llama-server", launcher.EXTRA_WEIGHT["path"], "cuda", True, True, 4096)
        self.assertIn("--no-context-shift", server)
        self.assertEqual(server[server.index("--ctx-size")+1], "4096")
        args = SimpleNamespace(case=launcher.EXTRA_CASE, extra=True, qa=True, holdout=True, chapter=False, context=True, glossary=True, repeat=2, backend="cuda", qa_server_image_id="sha256:"+"a"*64, qa_server_args=server)
        client = launcher.client_args("gargantua-s5-fixture-client", "gargantua-s5-fixture-server", Path("C:/model"), Path("C:/case/results"), "sha256:"+"b"*64, args)
        self.assertIn("/pilot/translation-extra/qa_bench.py", client)
        self.assertIn("--context-shift-disabled", client)
        self.assertEqual(client[client.index("--lock")+1], "/pilot/extra-models.lock.json")
        self.assertEqual(client[client.index("--server-context-tokens")+1], "4096")
        self.assertEqual(client[client.index("--max-input-tokens")+1], "3584")
        mounts = [client[index+1] for index, value in enumerate(client) if value == "--mount"]
        self.assertTrue(any("target=/pilot/translation-extra,readonly" in value for value in mounts))
        self.assertFalse(any("private" in value for value in mounts))
        with self.assertRaises(ValueError):
            launcher.server_args("gargantua-s5-fixture-server", Path("C:/model"), "sha256:"+"a"*64, "/app/llama-server", "Qwen3-4B-Q4_K_M.gguf", "cuda", False, True, 4096)

    def test_backend_evidence_refuses_gpu_fallback_and_cpu_mislabel(self):
        cuda = "load_tensors: offloaded 29/29 layers to GPU\n"
        cpu = "load_tensors: CPU_Mapped model buffer size = 1900 MiB\n"
        self.assertEqual(launcher.backend_evidence("cuda", cuda)["layersOffloaded"], 29)
        self.assertFalse(launcher.backend_evidence("cpu", cpu)["gpuModelOffload"])
        for backend, text in (("cuda", cpu), ("cuda", "offloaded 1/29 layers to GPU"), ("cpu", cpu+cuda), ("cpu", "unknown format")):
            with self.subTest(backend=backend, text=text), self.assertRaises(RuntimeError):
                launcher.backend_evidence(backend, text)

    def test_client_shares_only_owned_namespace_and_never_mounts_private_reference(self):
        args = SimpleNamespace(case="qwen3-4b-q4", holdout=True, context=True, glossary=False, repeat=2)
        argv = launcher.client_args("gargantua-s5-fixture-client", "gargantua-s5-fixture-server", Path("C:/model"), Path("C:/case/results"), "sha256:"+"b"*64, args)
        self.assertEqual(argv[argv.index("--network")+1], "container:gargantua-s5-fixture-server")
        self.assertIn("--context", argv)
        self.assertNotIn("--glossary", argv)
        self.assertIn("--rm", argv)
        mounts = [argv[index+1] for index, value in enumerate(argv) if value == "--mount"]
        self.assertEqual(len(mounts), 4)
        self.assertTrue(all(value.endswith(",readonly") for value in mounts if "target=/out" not in value))
        self.assertFalse(any("private" in value for value in mounts))
        self.assertFalse(any(value.endswith("target=/pilot,readonly") for value in mounts))
        writable = [value for value in mounts if not value.endswith(",readonly")]
        self.assertEqual(len(writable), 1)
        self.assertIn("case/results", writable[0].replace("\\", "/"))

    def test_chapter_fixture_has_only_fixed_input_mount_and_no_reference(self):
        args = SimpleNamespace(case="qwen3-4b-q4", holdout=False, chapter=True, context=True, glossary=True, repeat=2)
        argv = launcher.client_args("gargantua-s5-fixture-client", "gargantua-s5-fixture-server", Path("C:/model"), Path("C:/case/results"), "sha256:"+"b"*64, args)
        mounts = [argv[index+1] for index, value in enumerate(argv) if value == "--mount"]
        self.assertTrue(any("chapter-inputs.json" in value and value.endswith(",readonly") for value in mounts))
        self.assertFalse(any("private" in value or "chapter-reference" in value for value in mounts))
        self.assertEqual(argv[argv.index("--corpus")+1], "/pilot/chapter-inputs.json")
        args.holdout = True
        with self.assertRaises(ValueError):
            launcher.selected_corpus(args)

    def test_longer_chapter_is_frozen_four_connected_paragraphs_without_reference(self):
        import json
        import bench
        fixture_root = launcher.ROOT / "experiments/s5"
        corpus, _ = bench.load_corpus(fixture_root / "chapter-inputs.json")
        self.assertEqual(len(corpus["segments"]), 4)
        self.assertFalse(any("reference" in row for row in corpus["segments"]))
        for index, row in enumerate(corpus["segments"]):
            self.assertTrue(80 <= len(row["text"].split()) <= 100)
            self.assertEqual(len(row["previousSourceContext"]), index)
            self.assertEqual(row["glossary"]["Tide Ledger"], "Приливная книга")
        frozen = json.loads((fixture_root / "chapter-fixture.lock.json").read_text(encoding="utf-8"))
        self.assertFalse(frozen["modelOutputsReadBeforeAuthoring"])
        # Hash comparison only; no reference sentences are read or fed into prompts.
        for entry in frozen["files"]:
            self.assertEqual(bench.sha256(fixture_root / entry["path"]), entry["sha256"])

    def test_cleanup_daemon_error_is_unknown_and_every_owned_name_checked(self):
        names = ["gargantua-s5-fixture-" + role for role in ("health", "client", "server")]
        with mock.patch.object(launcher._wrapper, "command", return_value=(1, "daemon unavailable")) as command:
            rows = launcher.cleanup_owned(names)
        self.assertEqual(command.call_count, 3)
        self.assertEqual([row["name"] for row in rows], names)
        self.assertFalse(any(row["verifiedStopped"] for row in rows))
        self.assertTrue(all(row["observations"] == ["unknown"] for row in rows))

    def test_cleanup_uses_successful_exact_ps_and_stop_kill_rechecks(self):
        name = "gargantua-s5-fixture-server"
        replies = [(0, "abc running"), (0, name), (0, "abc running"), (0, name), (0, "abc exited")]
        with mock.patch.object(launcher._wrapper, "command", side_effect=replies) as command:
            rows = launcher.cleanup_owned([name])
        self.assertTrue(rows[0]["verifiedStopped"])
        self.assertEqual(rows[0]["observations"], ["running", "running", "exited"])
        calls = [call.args[0] for call in command.call_args_list]
        self.assertEqual([argv[1] for argv in calls], ["ps", "stop", "ps", "kill", "ps"])
        self.assertIn("name=^/"+name+"$", calls[0])

    def test_cleanup_successful_empty_ps_is_absent_not_a_query_error(self):
        with mock.patch.object(launcher._wrapper, "command", return_value=(0, "")):
            rows = launcher.cleanup_owned(["gargantua-s5-fixture-client"])
        self.assertTrue(rows[0]["verifiedStopped"])
        self.assertEqual(rows[0]["observations"], ["absent"])

    def test_no_unowned_container_names_or_unknown_artifacts(self):
        for name in ("cotology-app", "gargantua-s5-foo;rm", "gargantua-s5-../"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                launcher.restrictions(name, "1g", 1)
        with self.assertRaises(ValueError):
            launcher.server_args("gargantua-s5-valid", Path("C:/model"), "image", "/app/llama-server", "other.gguf")

    def test_unknown_entrypoint_refused_without_starting_any_model(self):
        self.assertEqual(launcher.server_binary({"entrypoint": ["/app/llama-server"]}), "/app/llama-server")
        for value in (None, ["/bin/sh", "-c"], ["/app/unknown"]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                launcher.server_binary({"entrypoint": value})


if __name__ == "__main__":
    unittest.main()
