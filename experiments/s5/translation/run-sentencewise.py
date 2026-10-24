"""Windows Docker-only coordinator for the separate OPUS segmentation diagnostic.

The root coordinator must serialize this with every other heavy pilot task.
Never loads models or installs packages on the Windows host.
"""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

import bench
import sentence_bench
import sentence_catalog

ROOT = Path(__file__).resolve().parents[3]
PILOT = ROOT / ".local/s5-pilot"
CODE = Path(__file__).resolve().parent
MODEL = PILOT / "downloads/opus-en-ru"
RUNTIME_TAG = "gargantua-s5-cpu:pilot"
_spec = importlib.util.spec_from_file_location("s5_sentence_container_coordinator", ROOT / "experiments/s5/run-container.py")
COMMON = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(COMMON)


def process_options():
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def checked_case(value):
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Use a new relative case below .local/s5-pilot")
    case = (ROOT / relative).resolve()
    if PILOT.resolve() not in case.parents or case.exists():
        raise ValueError("Case must be new and strictly inside pilot workspace")
    if case == MODEL.resolve() or MODEL.resolve() in case.parents or case in MODEL.resolve().parents:
        raise ValueError("Model and writable result directories must not overlap")
    return case


def checked_mount(path):
    value = str(path)
    if "," in value or any(ord(char) < 32 for char in value):
        raise ValueError("Docker mount path contains a comma/control character")
    return value


def docker_args(name, image_id, results, corpus, threads, selected_ids):
    if not re.fullmatch(r"gargantua-s5-[a-z0-9-]+", name) or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ValueError("Invalid owned name or immutable image ID")
    if threads not in (2, 6) or corpus not in ("baseline", "chapter"):
        raise ValueError("Unexpected resource or corpus profile")
    argv = ["run", "--rm", "--name", name, "--network", "none", "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "2g", "--memory-swap", "2g", "--cpus", str(threads), "--pids-limit", "128", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777", "--env", "HOME=/tmp", "--env", "HF_HOME=/tmp/hf", "--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1", "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "OMP_NUM_THREADS="+str(threads), "--env", "OPENBLAS_NUM_THREADS="+str(threads), "--env", "MKL_NUM_THREADS="+str(threads), "--mount", f"type=bind,source={checked_mount(CODE)},target=/pilot/translation,readonly", "--mount", f"type=bind,source={checked_mount(MODEL)},target=/models,readonly", "--mount", f"type=bind,source={checked_mount(results)},target=/out"]
    if corpus == "chapter":
        argv += ["--mount", f"type=bind,source={checked_mount(ROOT / 'experiments/s5/chapter-inputs.json')},target=/pilot/chapter-inputs.json,readonly"]
    argv += ["--entrypoint", "python", image_id, "/pilot/translation/sentence_bench.py", "--model-dir", "/models", "--corpus", corpus, "--output", "/out/translation.json", "--threads", str(threads)]
    if corpus == "chapter":
        argv += ["--corpus-file", "/pilot/chapter-inputs.json"]
    for segment_id in selected_ids:
        if not re.fullmatch(r"[a-z0-9-]{1,80}", segment_id):
            raise ValueError("Invalid segment selector")
        argv += ["--segment-id", segment_id]
    return argv


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", choices=("baseline", "chapter"), default="baseline")
    parser.add_argument("--threads", type=int, choices=(2, 6), default=2)
    parser.add_argument("--segment-id", action="append", default=[])
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout", type=int, default=1200)
    args = parser.parse_args()
    if not 60 <= args.timeout <= 3600:
        raise ValueError("Pilot timeout outside 60..3600 seconds")
    case = checked_case(args.output)
    if MODEL.is_symlink() or PILOT.resolve() not in MODEL.resolve().parents:
        raise ValueError("Model directory escaped pilot workspace")
    model, checked = bench.verify_model(json.loads((CODE / "models.lock.json").read_text(encoding="utf-8")), "opus-en-ru", MODEL)
    corpus_path = CODE / "corpus.json" if args.corpus == "baseline" else ROOT / "experiments/s5/chapter-inputs.json"
    relative_path = "experiments/s5/translation/corpus.json" if args.corpus == "baseline" else "experiments/s5/chapter-inputs.json"
    corpus_raw = corpus_path.read_bytes()
    catalogue_path = CODE / "sentence-catalog.lock.json"
    catalogue = json.loads(catalogue_path.read_text(encoding="utf-8"))
    entries = sentence_bench.verify_catalog(catalogue, corpus_raw, relative_path, sentence_catalog.source_segments(json.loads(corpus_raw)))
    if len(args.segment_id) != len(set(args.segment_id)) or set(args.segment_id)-{row["id"] for row in entries}:
        raise ValueError("Unknown, repeated or non-English segment selection")
    image = subprocess.run(["docker", "image", "inspect", RUNTIME_TAG, "--format", "{{.Id}}"], capture_output=True, text=True, encoding="utf-8", timeout=20, check=True, **process_options()).stdout.strip()
    runtime_receipt = json.loads((PILOT / "cpu-runtime.json").read_text(encoding="utf-8"))
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image) or image != runtime_receipt.get("imageId") or runtime_receipt.get("status") != "built-and-offline-smoke-passed":
        raise ValueError("CPU runtime no longer matches the admitted immutable image")
    case.mkdir(parents=True)
    results = case / "results"
    results.mkdir()
    name = "gargantua-s5-opus-sentence-" + uuid.uuid4().hex
    launch = {"schemaVersion": 1, "status": "running", "startedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "variant": catalogue["variant"], "model": model["id"], "artifactsVerified": checked, "imageId": image, "corpus": args.corpus, "corpusSha256": sentence_catalog.digest_bytes(corpus_raw), "catalogueSha256": bench.sha256(catalogue_path), "codeHashes": {filename: bench.sha256(CODE / filename) for filename in ("bench.py", "sentence_bench.py", "sentence_catalog.py", "run-sentencewise.py")}, "coordinatorSha256": bench.sha256(ROOT / "experiments/s5/run-container.py"), "containerName": name, "limits": {"memoryBytes": 2*1024**3, "memoryAndSwapBytes": 2*1024**3, "cpus": args.threads, "threads": args.threads, "pids": 128, "network": "none", "readOnlyRoot": True, "user": "1000:1000", "ports": [], "productionMounted": False}, "writeMount": "results only; launch report and telemetry are outside inference write access", "comparisonScope": "Separate sentencewise variant, one pass. Two-thread default must not be presented as a same-thread speed comparison with the six-thread paragraph baseline.", "resourceReservation": "External root pilot coordinator must serialize all heavy jobs; unknown cleanup requires retaining its lease", "qualityReview": "NOT_REVIEWED"}
    manifest = case / "launch.json"
    bench.atomic_json(manifest, launch)
    argv = docker_args(name, image, results, args.corpus, args.threads, args.segment_id)
    command = [sys.executable, str(ROOT / "experiments/s5/run-container.py"), "--name", name, "--timeout", str(args.timeout), "--output", str(case / "telemetry"), "--", *argv]
    try:
        with (case / "coordinator.log").open("w", encoding="utf-8") as stream:
            outcome = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, timeout=args.timeout+60, **process_options())
        launch["coordinatorExitCode"] = outcome.returncode
        if outcome.returncode:
            raise RuntimeError("Sentencewise case failed or resource guard stopped it; inspect telemetry")
        raw_result = results / "translation.json"
        result = json.loads(raw_result.read_text(encoding="utf-8"))
        if result.get("status") != "completed" or result.get("variant") != catalogue["variant"] or result.get("corpusSha256") != launch["corpusSha256"] or result.get("catalogueSha256") != launch["catalogueSha256"]:
            raise ValueError("Result does not match completed requested variant/source coverage")
        launch["resultSha256"] = bench.sha256(raw_result)
        launch["summary"] = result["summary"]
        launch["status"] = "completed"
    except BaseException as exc:
        launch["status"] = "failed"
        launch["error"] = {"type": type(exc).__name__, "message": str(exc)[:1500]}
        raise
    finally:
        try:
            launch["cleanup"] = COMMON.ensure_stopped(name)
        except Exception as exc:
            launch["cleanup"] = {"name": name, "verifiedStopped": False, "observations": ["unknown"], "error": str(exc)[:500]}
        if not launch["cleanup"]["verifiedStopped"]:
            launch["status"] = "failed"
            launch["cleanupLease"] = "RETAIN: owned container state not confirmed stopped"
        launch["finishedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        bench.atomic_json(manifest, launch)
    print(json.dumps({"status": launch["status"], "output": str(case), "variant": catalogue["variant"]}))
    if launch["status"] != "completed":
        raise SystemExit(3)


if __name__ == "__main__":
    main()
