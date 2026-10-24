"""Windows coordinator for one resource-limited offline TTS pilot case.

No model is loaded in the Windows process. All format/inference execution uses
the separately built pinned Linux image. The caller/root coordinator owns the
shared heavy-work reservation; this launcher does not implement production
scheduling and must not be run concurrently with another heavy pilot job.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import uuid


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    code_root = pathlib.Path(__file__).resolve().parent
    workspace = code_root.parents[2]
    pilot_root = workspace / ".local" / "s5-pilot"
    manifest_file = code_root / "models.lock.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, choices=[m["id"] for m in manifest["models"]])
    parser.add_argument("--output", type=pathlib.Path, required=True,
                        help="New case directory below workspace .local/s5-pilot/")
    parser.add_argument("--models-root", type=pathlib.Path, default=pilot_root / "tts-models")
    parser.add_argument("--repeat", type=int, default=2, choices=[1, 2, 3])
    parser.add_argument("--sample", action="append", default=[])
    parser.add_argument("--timeout", type=int, default=1200)
    args = parser.parse_args()
    if not 60 <= args.timeout <= 3600:
        raise ValueError("timeout outside 60..3600 seconds")
    if sys.platform != "win32":
        raise ValueError("This telemetry coordinator is intended for the Windows host; use runner.py inside Linux")
    case = args.output if args.output.is_absolute() else workspace / args.output
    case = case.resolve()
    models_root = args.models_root.resolve()
    pilot_root = pilot_root.resolve()
    if case == pilot_root or not case.is_relative_to(pilot_root) or case.exists():
        raise ValueError("output must be a fresh case directory strictly below this pilot workspace")
    if models_root == pilot_root or not models_root.is_relative_to(pilot_root):
        raise ValueError("only explicitly staged pilot models may be mounted")
    if case.is_relative_to(models_root) or models_root.is_relative_to(case):
        raise ValueError("model and writable output mounts must not overlap")
    if any("," in str(p) or any(ord(c) < 32 for c in str(p)) for p in (code_root, models_root, case)):
        raise ValueError("Docker mount paths must not contain commas/control characters")
    prepared = json.loads((models_root / "prepared.json").read_text(encoding="utf-8"))
    if prepared.get("status") != "hash-verified-staged" or prepared.get("manifestSha256") != file_hash(manifest_file):
        raise ValueError("staging receipt is missing or belongs to another manifest")
    if not any(m.get("id") == args.model for m in prepared.get("models", [])):
        raise ValueError("selected model was not staged")
    corpus = json.loads((code_root / "corpus.json").read_text(encoding="utf-8"))
    known_samples = {s["id"] for s in corpus["samples"]}
    if len(args.sample) != len(set(args.sample)) or any(s not in known_samples for s in args.sample):
        raise ValueError("unknown/repeated sample")
    inspected = subprocess.run(["docker", "image", "inspect", "gargantua-s5-cpu:pilot", "--format", "{{.Id}}"],
                               check=True, capture_output=True, text=True, encoding="utf-8")
    image_id = inspected.stdout.strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ValueError("runtime image did not resolve to an immutable image ID")
    case.mkdir(parents=True)
    # The inference process sees only this audio parent as writable. Host
    # telemetry lives in a separate sibling and cannot be rewritten by it.
    results = case / "results"; results.mkdir()
    name = f"gargantua-s5-tts-{args.model}-{uuid.uuid4().hex[:8]}"
    docker_args = ["run", "--rm", "--name", name, "--network", "none", "--read-only",
        "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "128",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
        "--env", "HOME=/tmp", "--env", "HF_HOME=/tmp/hf", "--env", "XDG_CACHE_HOME=/tmp/cache",
        "--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1",
        "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "OMP_NUM_THREADS=2",
        "--env", "OPENBLAS_NUM_THREADS=2", "--env", "MKL_NUM_THREADS=2",
        "--mount", f"type=bind,source={code_root},target=/experiment,readonly",
        "--mount", f"type=bind,source={models_root},target=/models,readonly",
        "--mount", f"type=bind,source={results},target=/results",
        "--workdir", "/experiment", image_id,
        "python", "/experiment/runner.py", "--models-root", "/models", "--output", "/results/audio",
        "--model", args.model, "--threads", "2", "--repeat", str(args.repeat)]
    for sample in args.sample: docker_args.extend(["--sample", sample])
    receipt = {"schemaVersion":1,"model":args.model,"imageId":image_id,"containerName":name,
        "isolation":{"network":"none","readOnlyRoot":True,"user":"1000:1000","capabilities":"dropped-all",
                     "memoryBytes":2*1024**3,"memorySwapBytes":2*1024**3,"cpus":2,"pids":128,
                     "ports":[],"productionMounts":False,"dockerSocketMount":False},
        "manifestSha256":file_hash(manifest_file),"preparedReceiptSha256":file_hash(models_root/"prepared.json"),
        "codeHashes":{p.name:file_hash(p) for p in sorted(code_root.glob("*.py"))},
        "repeat":args.repeat,"samples":args.sample or "all-original-corpus-passages",
        "results":"results/audio/report.json","telemetry":"telemetry/telemetry-summary.json",
        "coldSemantics":"New process/container; host/OS page cache is not flushed.",
        "reservation":"External root pilot coordinator must serialize all heavy parser/MT/TTS experiments."}
    (case / "launch.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    command = [sys.executable, str(code_root.parent / "run-container.py"), "--name", name,
               "--timeout", str(args.timeout), "--output", str(case / "telemetry"), "--", *docker_args]
    result = subprocess.run(command, check=False)
    if result.returncode:
        raise SystemExit(result.returncode)
    report_path = case / "results" / "audio" / "report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("status") != "completed" or report.get("model") != args.model or not report.get("allSignalIntegrityPassed"):
        raise ValueError("audio experiment did not satisfy technical completion")
    print(json.dumps({"status":"completed","model":args.model,"case":str(case),
                      "report":str(report_path),"imageId":image_id,
                      "aggregateRealTimeFactor":report["aggregateRealTimeFactor"],
                      "auditoryReview":"NOT_LISTENED"}))


if __name__ == "__main__": main()
