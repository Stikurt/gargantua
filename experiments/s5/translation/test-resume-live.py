"""Controlled real OPUS interruption/resume pilot; stdlib host orchestration only.

Run only after the external coordinator grants the exclusive model-work slot.
No production mounts, model downloads or changes to the frozen bench runner.
"""
from __future__ import annotations
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

import bench

ROOT = Path(__file__).resolve().parents[3]
PILOT = ROOT / ".local/s5-pilot"
CODE = Path(__file__).resolve().parent
MODEL = PILOT / "downloads/opus-en-ru"
ADMISSION = PILOT / "admission/opus-en-ru.json"
CORPUS = CODE.parent / "holdout-inputs.json"
CPU_IMAGE = "sha256:6497e15e1c13eeaad00355a64bb98da52046bb458dba97b9df580fc3940eb37a"
WRAPPER = CODE.parent / "run-container.py"
SPEC = importlib.util.spec_from_file_location("s5_resume_common_container", WRAPPER)
common = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(common)


def command(argv, timeout=20, check=True):
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    result = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, **options)
    if check and result.returncode:
        raise RuntimeError("Owned pilot command failed: " + " ".join(argv[:3]) + ": " + result.stderr[-1000:])
    return result


def checked_mount(path):
    value = str(path)
    if "," in value or any(ord(c) < 32 for c in value):
        raise ValueError("Unsafe mount path")
    return value


def checked_case(path):
    case = (ROOT / path).resolve()
    if case.parent != PILOT.resolve() or not re.fullmatch(r"mt-resume-[a-z0-9-]{1,50}", case.name) or case.exists():
        raise ValueError("Use a fresh direct pilot child named mt-resume-...")
    checked_mount(case)
    return case


def owned(name):
    if not re.fullmatch(r"gargantua-s5-opus-resume-[a-f0-9]{12}", name):
        raise ValueError("Refusing operation outside the exact owned resume-test namespace")
    return name


def docker_args(name, results, resume=False):
    owned(name)
    argv = ["run", "--rm", "--pull", "never", "--name", name, "--network", "none", "--read-only",
        "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "2g",
        "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "128", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
        "--env", "HOME=/tmp", "--env", "HF_HOME=/tmp/hf", "--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1",
        "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "OMP_NUM_THREADS=2", "--env", "MKL_NUM_THREADS=2", "--env", "OPENBLAS_NUM_THREADS=2",
        "--mount", f"type=bind,source={checked_mount(CODE)},target=/pilot/translation,readonly",
        "--mount", f"type=bind,source={checked_mount(MODEL)},target=/models,readonly",
        "--mount", f"type=bind,source={checked_mount(CORPUS)},target=/pilot/holdout-inputs.json,readonly",
        "--mount", f"type=bind,source={checked_mount(results)},target=/out",
        CPU_IMAGE, "python", "/pilot/translation/bench.py", "--model-id", "opus-en-ru", "--model-dir", "/models",
        "--lock", "/pilot/translation/models.lock.json", "--corpus", "/pilot/holdout-inputs.json", "--output", "/out/translation.json",
        "--device", "cpu", "--threads", "2", "--max-input-tokens", "384", "--max-output-tokens", "384",
        "--languages", "en", "--repeat", "1", "--no-warmup"]
    if resume:
        argv.append("--resume")
    return argv


def read_checkpoint(path):
    if not path.is_file() or path.stat().st_size > 16 * 1024**2:
        raise ValueError("Missing or oversized pilot checkpoint")
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("checkpointSha256") != bench.canonical_digest({k: v for k, v in report.items() if k != "checkpointSha256"}):
        raise ValueError("Checkpoint checksum differs")
    return report


def prefix_snapshot(report, expected_ids):
    rows = report.get("segments", [])
    if report.get("status") != "running" or not 2 <= len(rows) < len(expected_ids):
        raise ValueError("Controlled stop did not capture an incomplete prefix of at least two outputs")
    if [x.get("id") for x in rows] != expected_ids[:len(rows)] or any(x.get("repeatIndex") != 1 or x.get("status") != "generated" for x in rows):
        raise ValueError("Interrupted checkpoint is not the expected generated source prefix")
    return [{"id": x["id"], "rowSha256": bench.canonical_digest(x), "outputSha256": x["outputSha256"]} for x in rows]


def verify_resumed(before, after, expected_ids):
    prefix = prefix_snapshot(before, expected_ids)
    if after.get("status") != "completed" or after.get("identity") != before.get("identity"):
        raise ValueError("Resumed model/corpus/settings/runtime identity differs")
    rows = after.get("segments", [])
    if len(rows) != len(expected_ids) or [x.get("id") for x in rows] != expected_ids:
        raise ValueError("Resumed result is not the exact complete ordered workload")
    if rows[:len(prefix)] != before["segments"]:
        raise ValueError("Resume changed a previously committed complete row")
    if (after.get("resumeCount") != 1 or len(after.get("invocations", [])) != 2
        or after["invocations"][-1].get("resumedAtCompletedInvocations") != len(prefix)):
        raise ValueError("Resume did not start after the committed prefix")
    if any(x.get("repeatIndex") != 1 or x.get("status") != "generated" for x in rows):
        raise ValueError("Final rows contain unsupported or repeated invocations")
    if any(bench.canonical_digest(x) != p["rowSha256"]
           for x, p in zip(rows, prefix)):
        raise ValueError("Committed row hashes differ")
    for row in rows:
        if row.get("outputSha256") != hashlib.sha256(row["text"].encode()).hexdigest():
            raise ValueError("Output text hash differs")
    return {"prefixRows": len(prefix), "remainingRowsGenerated": len(rows) - len(prefix), "finalRows": len(rows),
        "prefix": prefix, "prefixUnchanged": True, "exactOrder": True, "noDuplicateOutputRows": len(set(expected_ids)) == len(rows)}


def run_stage(case, stage, results, expected_ids, timeout, interrupt=False):
    name = "gargantua-s5-opus-resume-" + uuid.uuid4().hex[:12]
    argv = docker_args(name, results, resume=stage != "interrupt")
    telemetry = case / (stage + "-telemetry")
    wrapper_argv = [sys.executable, str(WRAPPER), "--name", name, "--timeout", str(timeout), "--output", str(telemetry), "--", *argv]
    bench.atomic_json(case / (stage + "-launch.json"), {"schemaVersion": 1, "container": name, "arguments": argv,
        "sameFrozenImage": CPU_IMAGE, "resume": stage != "interrupt", "controlledInterruption": interrupt})
    process = None
    stop_observed = False
    captured = None
    cleanup = None
    with (case / (stage + "-coordinator.log")).open("w", encoding="utf-8") as log:
        try:
            options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
            process = subprocess.Popen(wrapper_argv, stdout=log, stderr=subprocess.STDOUT, **options)
            if interrupt:
                deadline = time.monotonic() + timeout + 30
                while process.poll() is None and time.monotonic() < deadline:
                    checkpoint = results / "translation.json"
                    if checkpoint.exists():
                        observed = read_checkpoint(checkpoint)
                        if len(observed.get("segments", [])) >= 2:
                            # Freeze only this owned Python process before copying a stable prefix;
                            # SIGKILL then simulates abrupt interruption rather than a clean shutdown.
                            prefix_snapshot(observed, expected_ids)
                            command(["docker", "kill", "--signal=STOP", owned(name)])
                            captured = read_checkpoint(checkpoint)
                            prefix_snapshot(captured, expected_ids)
                            (case / "interrupted-checkpoint.json").write_bytes(checkpoint.read_bytes())
                            command(["docker", "kill", "--signal=KILL", owned(name)])
                            stop_observed = True
                            break
                    time.sleep(.05)
                if not stop_observed:
                    raise RuntimeError("Failed to stop after two committed outputs before workload completion")
            code = process.wait(timeout=timeout + 60)
        finally:
            cleanup = common.ensure_stopped(owned(name))
            if process is not None and process.poll() is None:
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
            bench.atomic_json(case / (stage + "-owned-cleanup.json"), cleanup)
    summary_path = telemetry / "telemetry-summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    if not cleanup["verifiedStopped"] or not summary.get("cleanupVerified") or summary.get("abort") is not None:
        raise RuntimeError("Cleanup unknown or resource guard aborted; retain the central resource lease")
    if interrupt and code not in (137, 143):
        raise RuntimeError("Controlled interruption did not produce the expected killed-process exit")
    if stage == "resume" and code != 0:
        raise RuntimeError("Matching checkpoint resume failed")
    if stage == "completed-refusal" and code == 0:
        raise RuntimeError("Completed checkpoint was incorrectly accepted")
    return {"exitCode": code, "cleanupVerified": True, "telemetry": str(summary_path.relative_to(case)),
        "capturedPrefixRows": len(captured["segments"]) if captured else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".local/s5-pilot/mt-resume-01"))
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    if not 60 <= args.timeout <= 1800:
        raise ValueError("Resume pilot timeout outside approved bounds")
    case = checked_case(args.output)
    if MODEL.is_symlink() or MODEL.is_junction() or MODEL.resolve().parent != (PILOT / "downloads").resolve():
        raise ValueError("Model escaped the fixed admitted download directory")
    admission = json.loads(ADMISSION.read_text(encoding="utf-8"))
    if admission.get("status") != "verified-pinned-artifacts" or admission.get("manifestSha256") != bench.sha256(CODE / "models.lock.json"):
        raise ValueError("Model admission missing or stale")
    observed_image = command(["docker", "image", "inspect", "gargantua-s5-cpu:pilot", "--format", "{{.Id}}"] ).stdout.strip()
    if observed_image != CPU_IMAGE:
        raise ValueError("CPU image differs from the reviewed immutable runtime")
    model, artifacts = bench.verify_model(json.loads((CODE / "models.lock.json").read_text(encoding="utf-8")), "opus-en-ru", MODEL)
    corpus, corpus_sha = bench.load_corpus(CORPUS)
    expected_ids = [x["id"] for x in corpus["segments"] if x["language"] == "en"]
    if len(expected_ids) != 8:
        raise ValueError("Use only the fixed eight-output English holdout")
    case.mkdir(parents=True)
    results = case / "results"
    results.mkdir()
    report = {"schemaVersion": 1, "status": "running", "kind": "actual-opus-interruption-resume-proof",
        "startedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "imageId": CPU_IMAGE,
        "artifactsVerified": artifacts, "admissionSha256": bench.sha256(ADMISSION), "corpusSha256": corpus_sha,
        "model": model["id"], "codeSha256": {p.name: bench.sha256(p) for p in (Path(__file__), CODE / "bench.py", WRAPPER)},
        "resourceReservation": "External exclusive model-work slot required; this program does not acquire the production scheduler lease.",
        "isolation": {"network": "none", "productionMounted": False, "ports": [], "cpus": 2, "memoryBytes": 2 * 1024**3},
        "qualityReview": "NOT_REVIEWED", "powerLossDurability": "NOT_ESTABLISHED", "stages": []}
    frozen_paths = {path: bench.sha256(path) for path in (Path(__file__), CODE / "bench.py", WRAPPER,
        CODE / "models.lock.json", ADMISSION, CORPUS)}
    report["frozenInputs"] = [{"path": str(path.relative_to(ROOT)), "sha256": digest} for path, digest in frozen_paths.items()]
    def require_frozen():
        if any(bench.sha256(path) != digest for path, digest in frozen_paths.items()):
            raise ValueError("A runner, corpus, admission or manifest changed during the controlled test")
    proof = case / "proof.json"
    bench.atomic_json(proof, report)
    try:
        require_frozen()
        report["stages"].append(run_stage(case, "interrupt", results, expected_ids, args.timeout, interrupt=True))
        interrupted = read_checkpoint(case / "interrupted-checkpoint.json")
        if read_checkpoint(results / "translation.json") != interrupted:
            raise ValueError("Killed process changed the frozen interrupted checkpoint")
        require_frozen()
        report["stages"].append(run_stage(case, "resume", results, expected_ids, args.timeout))
        completed = read_checkpoint(results / "translation.json")
        report["resumeProof"] = verify_resumed(interrupted, completed, expected_ids)
        completed_bytes = (results / "translation.json").read_bytes()
        (case / "completed-checkpoint.json").write_bytes(completed_bytes)
        require_frozen()
        report["stages"].append(run_stage(case, "completed-refusal", results, expected_ids, args.timeout))
        require_frozen()
        if (results / "translation.json").read_bytes() != completed_bytes:
            raise ValueError("Completed-checkpoint refusal rewrote the accepted result")
        refusal = (case / "completed-refusal-telemetry/console.log").read_text(encoding="utf-8", errors="replace")
        if "Completed results are immutable" not in refusal:
            raise ValueError("Third process failed for a reason other than immutable completion")
        report["completedRefusal"] = {"nonzeroExit": True, "checkpointBytesUnchanged": True,
            "failureStage": "bench.prepare_checkpoint before inference engine construction in the frozen runner"}
        report["status"] = "verified"
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
        raise
    finally:
        report["finishedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        bench.atomic_json(proof, report)
    print(json.dumps({"status": report["status"], "proof": str(proof), "resume": report["resumeProof"]}))


if __name__ == "__main__":
    main()
