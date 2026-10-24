"""One explicitly reviewed recovery of the interrupted S5 QA chapter case.

No new model recipe is admitted. Run only after the central coordinator grants
the GPU lease. Original case.json and the failed checkpoint snapshot are never
mounted writable in an inference container. A new thermal abort stays failed.
"""
from __future__ import annotations
import argparse
import datetime
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import time
from types import SimpleNamespace
import uuid

_spec = importlib.util.spec_from_file_location("s5_frozen_gpu_launcher", Path(__file__).with_name("run-gpu.py"))
gpu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gpu)
bench = gpu.bench
policy = gpu.qa_policy
CASE_RELATIVE = ".local/s5-pilot/qwen35-gpu-qa-chapter"
CASE_SHA256 = "8fa44f7227392a0f4e87cefdc2e60d9cc4016ed304219c6a66f4279732fa9141"
INTERRUPTED_SHA256 = "2f7b22b8b3facbac357167b0d4ba97d432471f7e30ae6133baa61dcda8388ea6"
FROZEN_FILES = {
    "experiments/s5/translation/run-gpu.py": "3e162264cd9bd51cf37a3189f63c92305baf37472ad5244cb2925dd759e6f578",
    "experiments/s5/translation/bench.py": "11372026d4ea0581cddef7e38ad8a0ee545b88bed63f7c8c3a43b1d82de62aea",
    "experiments/s5/translation/qa_launcher_policy.py": "6a995fc49f57f04fbaf419649ddf5956fdd33d9d8cdaea662c7165287dfc24e6",
    "experiments/s5/translation-extra/qa_bench.py": "40dc4042f47ba6c04107a4850c7a8d69c968745fae744f542d5f83dad5db6b61",
    "experiments/s5/translation-extra/models.lock.json": "efb5dc9626f357d4a2cf829053afbd800c4376a8ca21b6507bde159d65e33f51",
    "experiments/s5/chapter-inputs.json": "57ab2e85a4f49014e6061af9503fa06a81d6c872d3447c461cc7d0dfda4624db",
    "experiments/s5/run-container.py": "06488bbcf142067a701691830dda8665fb05ddf5f6320f9e890c022984d3b484",
    ".local/s5-pilot/qa-runner-receipt.json": "c0e5cc0be0a43dec6995d78def386312f7c42f4c5f3c6e9e50146ba7ea21b247",
}


def load_json(path):
    if path.is_symlink() or path.stat().st_size > 16 * 1024**2:
        raise ValueError("Recovery evidence is a symlink or exceeds its bound")
    return json.loads(path.read_text(encoding="utf-8"))


def case_directory(relative):
    gpu.checked_mount(relative)
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != CASE_RELATIVE:
        raise ValueError("Recovery is restricted to the one explicitly reviewed failed case")
    target = gpu.ROOT / path
    if target.resolve() != target.absolute() or gpu.PILOT.resolve() not in target.resolve().parents:
        raise ValueError("Recovery case escaped the fixed pilot workspace")
    for child in (target / "results", target / "results/result.json", target / "case.json"):
        if child.resolve() != child.absolute() or child.is_symlink():
            raise ValueError("Recovery evidence/output must not traverse a symlink")
    return target


def validate_checkpoint(report):
    expected = bench.canonical_digest({key: value for key, value in report.items() if key != "checkpointSha256"})
    if report.get("checkpointSha256") != expected:
        raise ValueError("Checkpoint integrity mismatch")
    if report.get("identitySha256") != bench.canonical_digest(report.get("identity")):
        raise ValueError("Checkpoint identity checksum mismatch")


def validate_original(case, checkpoint):
    expected_settings = {"holdout": False, "chapter": True, "context": True, "glossary": True,
                         "repeat": 2, "backend": "cuda", "boundedCache": True, "qa": True}
    names = case.get("containers", {})
    cleanup = case.get("cleanup", {})
    rows = cleanup.get("containers", [])
    if (case.get("status") != "failed" or case.get("case") != gpu.EXTRA_CASE
            or case.get("settings") != expected_settings or case.get("serverLimits", {}).get("ctxTokens") != 4096
            or cleanup.get("allVerifiedStopped") is not True or len(names) != 3
            or set(names) != {"server", "client", "health"} or len(set(names.values())) != 3
            or not all(gpu.owned_name(name) for name in names.values())
            or len(rows) != 3 or {row.get("name") for row in rows} != set(names.values())
            or not all(row.get("verifiedStopped") is True for row in rows)):
        raise ValueError("Original failure, exact recipe, or three-container cleanup proof differs")
    validate_checkpoint(checkpoint)
    if (checkpoint.get("status") != "failed" or len(checkpoint.get("segments", [])) != 4
            or checkpoint.get("pendingDraft", {}).get("id") != "chapter-bridge-1"
            or checkpoint["pendingDraft"].get("repeatIndex") != 2):
        raise ValueError("Recovery requires the reviewed four-row interrupted checkpoint and pending draft")
    identity = checkpoint["identity"]
    if (identity["runtime"]["modelServerImageId"] != case["serverImage"]["id"]
            or identity["runtime"]["pythonImageId"] != case["clientImage"]["id"]
            or identity["settings"]["serverRecipeSha256"] != case["qaServerRecipeSha256"]):
        raise ValueError("Checkpoint runtime/recipe does not bind the failed case")


def query_stopped(name):
    if not gpu.owned_name(name):
        raise ValueError("Refusing state query outside the owned pilot namespace")
    result = gpu.command(["docker", "ps", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.ID}} {{.State}}"], check=False)
    if result.returncode:
        raise RuntimeError("Docker state is unknown; absence cannot be inferred")
    lines = result.stdout.strip().splitlines()
    if not lines:
        return {"name": name, "state": "absent", "verifiedStopped": True}
    fields = lines[0].split()
    if len(lines) != 1 or len(fields) != 2 or fields[1] not in ("exited", "dead"):
        raise RuntimeError("Original owned container remains active or has an unknown state")
    return {"name": name, "state": fields[1], "verifiedStopped": True}


def idle_pilot():
    result = gpu.command(["docker", "ps", "--filter", "name=^/gargantua-s5-", "--format", "{{.Names}}"], check=False)
    if result.returncode or result.stdout.strip():
        raise RuntimeError("Pilot GPU lease is unavailable or Docker state is unknown")


def temperature_admission():
    result = gpu.command(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"], check=False)
    lines = result.stdout.strip().splitlines()
    if result.returncode or not lines or any(not re.fullmatch(r"\d{1,3}", line.strip()) for line in lines):
        raise RuntimeError("GPU temperature is unavailable; recovery admission refused")
    readings = [int(line.strip()) for line in lines]
    if any(not 0 <= value <= 65 for value in readings):
        raise RuntimeError("GPU must cool to at most 65 C before QA recovery")
    return {"temperaturesCelsius": readings, "maximumAdmissionCelsius": 65,
            "runtimeThermalAbortCelsius": 87, "observedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat()}


def resumed_arguments(case, names, model_dir, results):
    server = gpu.server_args(names["server"], model_dir, case["serverImage"]["id"],
        gpu.server_binary(case["serverImage"]), gpu.EXTRA_WEIGHT["path"], "cuda", True, True, 4096)
    if policy.recipe_sha256(server) != case["qaServerRecipeSha256"]:
        raise ValueError("Recovery server recipe differs from the original immutable recipe")
    args = SimpleNamespace(case=gpu.EXTRA_CASE, extra=True, qa=True, chapter=True, holdout=False,
        context=True, glossary=True, repeat=2, backend="cuda", qa_server_image_id=case["serverImage"]["id"], qa_server_args=server)
    client = gpu.client_args(names["client"], names["server"], model_dir, results, case["clientImage"]["id"], args) + ["--resume"]
    return server, client


def verify_completion(previous, current):
    validate_checkpoint(current)
    count = len(previous["segments"])
    if (current.get("status") != "completed" or current.get("identity") != previous["identity"]
            or len(current.get("segments", [])) != 8 or current["segments"][:count] != previous["segments"]
            or current.get("pendingDraft") is not None):
        raise ValueError("Recovered checkpoint changed completed work, identity, or did not complete")
    expected_order = [("chapter-bridge-" + str(number), repeat) for repeat in (1, 2) for number in range(1, 5)]
    if any((row.get("id"), row.get("repeatIndex")) != expected or row.get("status") != "generated"
           for row, expected in zip(current["segments"], expected_order)):
        raise ValueError("Recovered rows do not match the complete fixed ordered plan")
    pending, next_row = previous["pendingDraft"], current["segments"][count]
    if (next_row.get("id") != pending["id"] or next_row.get("repeatIndex") != pending["repeatIndex"]
            or next_row.get("sourceTextSha256") != pending["sourceTextSha256"]
            or next_row.get("draftTextSha256") != pending["draftTextSha256"] or next_row.get("draft") != pending["result"]):
        raise ValueError("Recovered row did not reuse the exact saved pending draft")
    invocations = current.get("invocations", [])
    if (len(invocations) != len(previous.get("invocations", [])) + 1
            or invocations[:-1] != previous.get("invocations", [])
            or invocations[-1].get("resumedAtCompletedSegments") != count
            or invocations[-1].get("reusedPendingDraft") is not True
            or current.get("resumeCount") != previous.get("resumeCount", 0) + 1):
        raise ValueError("Recovery invocation does not prove prefix and pending-draft reuse")
    return {"previousCompletedRows": count, "newCompletedRows": len(current["segments"])-count,
            "priorRowsUnchanged": True, "priorRowsSha256": bench.canonical_digest(previous["segments"]),
            "reusedPendingDraft": True, "pendingDraftSha256": bench.canonical_digest(pending),
            "identitySha256": current["identitySha256"]}


def validate_telemetry(summaries):
    if set(summaries) != {"server", "client"}:
        raise ValueError("Both coordinator summaries are required before recovery acceptance")
    for role, summary in summaries.items():
        if ("abort" not in summary or summary["abort"] is not None
                or summary.get("cleanupVerified") is not True
                or not isinstance(summary.get("cleanup"), list) or not summary["cleanup"]
                or not all(row.get("verifiedStopped") is True for row in summary["cleanup"])):
            raise ValueError(role + " telemetry reports an abort or lacks verified cleanup")


def preflight(directory):
    case_path, result_path = directory / "case.json", directory / "results/result.json"
    if bench.sha256(case_path) != CASE_SHA256 or bench.sha256(result_path) != INTERRUPTED_SHA256:
        raise ValueError("Original failed case/checkpoint differs from the explicitly reviewed interruption")
    for relative, expected in FROZEN_FILES.items():
        if bench.sha256(gpu.ROOT / relative) != expected:
            raise ValueError("Frozen recovery dependency changed: " + relative)
    case, previous = load_json(case_path), load_json(result_path)
    validate_original(case, previous)
    original_states = [query_stopped(name) for name in case["containers"].values()]
    idle_pilot()
    thermal = temperature_admission()
    for key in ("serverImage", "clientImage"):
        actual = gpu.image_info(case[key]["id"])
        if actual["id"] != case[key]["id"] or (key == "serverImage" and actual["entrypoint"] != case[key]["entrypoint"]):
            raise ValueError("Exact original runtime image is unavailable or differs")
    model_dir = gpu.MODEL_ROOT / gpu.EXTRA_CASE
    if model_dir.resolve() != model_dir.absolute():
        raise ValueError("Model path traverses an unreviewed symlink")
    lock = load_json(gpu.ROOT / "experiments/s5/translation-extra/models.lock.json")
    gpu.validate_extra_policy(lock, SimpleNamespace(case=gpu.EXTRA_CASE, extra=True))
    _, checked = bench.verify_model(lock, gpu.EXTRA_CASE, model_dir)
    if checked != case["artifactsVerified"]:
        raise ValueError("Recovered model artifacts differ from the original case")
    return case, previous, {"originalStates": original_states, "thermal": thermal, "artifactsVerified": checked}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-directory", default=CASE_RELATIVE)
    parser.add_argument("--check-only", action="store_true", help="Read-only admission and artifact verification; no model is loaded")
    args = parser.parse_args()
    directory = case_directory(args.case_directory)
    case, previous, admission = preflight(directory)
    if args.check_only:
        print(json.dumps({"status": "admitted-read-only", "admission": admission}))
        return
    attempt, receipt = directory / "resume-02", directory / "recovery.json"
    snapshot = directory / "interrupted-result.json"
    if attempt.exists() or receipt.exists() or snapshot.exists():
        raise ValueError("Recovery evidence already exists; never overwrite an earlier attempt")
    nonce = uuid.uuid4().hex
    names = {role: "gargantua-s5-" + nonce + "-" + role for role in ("server", "client", "health")}
    server_argv, client_argv = resumed_arguments(case, names, gpu.MODEL_ROOT / gpu.EXTRA_CASE, directory / "results")
    raw = (directory / "results/result.json").read_bytes()
    if bench.sha256(directory / "results/result.json") != INTERRUPTED_SHA256:
        raise ValueError("Checkpoint changed during admission")
    with snapshot.open("xb") as stream:
        stream.write(raw)
    if bench.sha256(snapshot) != INTERRUPTED_SHA256:
        raise ValueError("Interrupted checkpoint snapshot differs")
    attempt.mkdir()
    report = {"schemaVersion": 1, "status": "running", "attempt": "resume-02", "sourceCase": CASE_RELATIVE,
        "sourceCaseSha256": CASE_SHA256, "sourceCaseRemainsFailed": True,
        "interruptedResultSha256": INTERRUPTED_SHA256, "snapshot": str(snapshot.relative_to(gpu.ROOT)),
        "recoveryRunnerSha256": bench.sha256(Path(__file__)), "frozenDependencies": FROZEN_FILES,
        "startedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "admission": admission,
        "serverImageId": case["serverImage"]["id"], "clientImageId": case["clientImage"]["id"],
        "serverArguments": server_argv, "clientArguments": client_argv,
        "serverRecipeSha256": policy.recipe_sha256(server_argv), "containers": names,
        "writableInferenceMount": str((directory / "results").relative_to(gpu.ROOT)),
        "evidenceMountWritable": False, "cleanup": {}}
    bench.atomic_json(receipt, report)
    wrapper, start, server_proc = gpu.ROOT / "experiments/s5/run-container.py", time.monotonic(), None
    try:
        # Recheck after model hashing, immediately before consuming the granted slot.
        idle_pilot()
        report["admission"]["immediateThermal"] = temperature_admission()
        bench.atomic_json(receipt, report)
        with (attempt / "server-coordinator.log").open("w", encoding="utf-8") as server_log:
            argv = [sys.executable, str(wrapper), "--name", names["server"], "--timeout", "1800", "--output", str(attempt / "server-telemetry"), "--", *server_argv]
            server_proc = subprocess.Popen(argv, stdout=server_log, stderr=subprocess.STDOUT, **gpu.process_options())
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if server_proc.poll() is not None:
                    raise RuntimeError("Recovery server coordinator exited before readiness")
                state = gpu.command(["docker", "inspect", "--format", "{{.State.Running}}", names["server"]], timeout=5, check=False)
                if state.returncode == 0 and state.stdout.strip() == "true":
                    break
                time.sleep(.5)
            else:
                raise RuntimeError("Recovery server did not start within 30 seconds")
            health = gpu.command(["docker", *gpu.health_args(names["health"], names["server"], case["clientImage"]["id"])], timeout=200, check=False)
            (attempt / "health-console.log").write_text(health.stdout + health.stderr, encoding="utf-8")
            if health.returncode:
                raise RuntimeError("Recovery model failed health readiness")
            report["health"] = json.loads(health.stdout.splitlines()[-1])
            report["backendEvidence"] = gpu.backend_evidence("cuda", (attempt / "server-telemetry/console.log").read_text(encoding="utf-8", errors="replace"))
            report["coldStartupObservedSeconds"] = time.monotonic() - start
            bench.atomic_json(receipt, report)
            argv = [sys.executable, str(wrapper), "--name", names["client"], "--monitor", names["server"], "--timeout", "1800", "--output", str(attempt / "client-telemetry"), "--", *client_argv]
            with (attempt / "client-coordinator.log").open("w", encoding="utf-8") as client_log:
                outcome = subprocess.run(argv, stdout=client_log, stderr=subprocess.STDOUT, timeout=1860, **gpu.process_options())
            report["clientCoordinatorExitCode"] = outcome.returncode
            if outcome.returncode:
                raise RuntimeError("Recovery inference/resource guard aborted; checkpoint remains resumable")
            current = load_json(directory / "results/result.json")
            report["reuseEvidence"] = verify_completion(previous, current)
            report["resultSha256"] = bench.sha256(directory / "results/result.json")
            report["summary"] = current["summary"]
            report["status"] = "completed"
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
    finally:
        report["cleanup"]["containers"] = gpu.cleanup_owned([names["health"], names["client"], names["server"]])
        report["cleanup"]["allVerifiedStopped"] = all(row["verifiedStopped"] for row in report["cleanup"]["containers"])
        if not report["cleanup"]["allVerifiedStopped"]:
            report["status"] = "failed"
            report["cleanup"]["retainResourceLease"] = True
        if server_proc is not None:
            try:
                report["serverCoordinatorExitCodeAfterOwnedStop"] = server_proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                server_proc.kill()
                server_proc.wait(timeout=10)
                report["cleanup"]["serverCoordinatorKilled"] = True
        # The model can finish its last row just before a thermal guard fires.
        # Client exit 0 alone must never turn that late abort into an accepted run.
        summaries = {}
        for role in ("server", "client"):
            summary_path = attempt / (role + "-telemetry") / "telemetry-summary.json"
            if summary_path.exists():
                summaries[role] = load_json(summary_path)
        report["coordinatorTelemetry"] = summaries
        try:
            validate_telemetry(summaries)
            report["resourceAcceptance"] = True
        except ValueError as exc:
            report["resourceAcceptance"] = False
            report["resourceAcceptanceError"] = str(exc)
            report["status"] = "failed"
        report["sourceCaseUnchanged"] = bench.sha256(directory / "case.json") == CASE_SHA256
        report["snapshotUnchanged"] = bench.sha256(snapshot) == INTERRUPTED_SHA256
        if not report["sourceCaseUnchanged"] or not report["snapshotUnchanged"]:
            report["status"] = "failed"
        report["finishedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        report["wallSeconds"] = time.monotonic() - start
        bench.atomic_json(receipt, report)
    print(json.dumps({"status": report["status"], "receipt": str(receipt)}))
    if report["status"] != "completed":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
