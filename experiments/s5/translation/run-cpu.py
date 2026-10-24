"""Windows coordinator for one offline CPU MT comparison; no model loads here."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid


def sha(path):
    with path.open("rb") as stream: return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    code = Path(__file__).resolve().parent
    workspace = code.parents[2]
    pilot = workspace / ".local/s5-pilot"
    p = argparse.ArgumentParser()
    p.add_argument("--model", choices=("opus-en-ru", "m2m100-418m"), required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--repeat", type=int, choices=(1, 2, 3), default=2)
    p.add_argument("--holdout", action="store_true")
    p.add_argument("--timeout", type=int, default=1800)
    args = p.parse_args()
    case = (workspace / args.output).resolve()
    if not case.is_relative_to(pilot.resolve()) or case == pilot.resolve() or case.exists():
        raise ValueError("Expected a new case below the pilot directory")
    models = pilot / "downloads" / args.model
    if models.is_symlink() or models.is_junction() or not models.resolve().is_relative_to((pilot / "downloads").resolve()):
        raise ValueError("Model directory escaped the fixed download root")
    admission_file = pilot / "admission" / (args.model + ".json")
    admission = json.loads(admission_file.read_text(encoding="utf-8"))
    if admission.get("status") != "verified-pinned-artifacts" or admission.get("manifestSha256") != sha(code / "models.lock.json"):
        raise ValueError("Missing or stale model admission")
    image = subprocess.check_output(["docker", "image", "inspect", "gargantua-s5-cpu:pilot", "--format", "{{.Id}}"], text=True).strip()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image): raise ValueError("Runtime image identity missing")
    case.mkdir(parents=True)
    results = case / "results"
    results.mkdir()
    name = "gargantua-s5-mt-" + uuid.uuid4().hex[:10]
    command = ["run", "--rm", "--pull", "never", "--name", name, "--network", "none", "--read-only",
               "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
               "--memory", "5g", "--memory-swap", "5g", "--cpus", "6", "--pids-limit", "128",
               "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
               "--env", "HOME=/tmp", "--env", "HF_HOME=/tmp/hf", "--env", "PYTHONDONTWRITEBYTECODE=1",
               "--env", "OMP_NUM_THREADS=6", "--env", "MKL_NUM_THREADS=6", "--env", "OPENBLAS_NUM_THREADS=6",
               "--mount", f"type=bind,source={code},target=/pilot,readonly",
               "--mount", f"type=bind,source={models},target=/models,readonly",
               "--mount", f"type=bind,source={results},target=/results"]
    if args.holdout:
        command += ["--mount", f"type=bind,source={code.parent / 'holdout-inputs.json'},target=/holdout-inputs.json,readonly"]
    command += [image, "python", "/pilot/bench.py", "--model-id", args.model, "--model-dir", "/models", "--output", "/results/translation.json",
                "--device", "cpu", "--threads", "6", "--repeat", str(args.repeat)]
    if args.holdout: command += ["--corpus", "/holdout-inputs.json"]
    receipt = {"schemaVersion":1,"model":args.model,"runtimeImageId":image,"runnerSha256":sha(code / "bench.py"),
               "admissionSha256":sha(admission_file),"isolation":{"network":"none","memoryGiB":5,"cpuThreads":6,"readOnlyRoot":True,"user":"1000:1000","ports":[],"productionMounts":False},
               "repeat":args.repeat,"holdout":args.holdout,"results":"results/translation.json","telemetry":"telemetry/telemetry-summary.json"}
    (case / "launch.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    completed = subprocess.run([sys.executable, str(code.parent / "run-container.py"), "--name", name,
                                "--output", str(case / "telemetry"), "--timeout", str(args.timeout), "--", *command])
    if completed.returncode: raise SystemExit(completed.returncode)
    report = json.loads((results / "translation.json").read_text(encoding="utf-8"))
    corpus_file = code.parent / "holdout-inputs.json" if args.holdout else code / "corpus.json"
    if report.get("status") != "completed" or report.get("model", {}).get("id") != args.model or report.get("corpus", {}).get("sha256") != sha(corpus_file):
        raise ValueError("Translation comparison incomplete or has a mismatched identity")
    print(json.dumps({"model":args.model,"status":"completed","summary":report["summary"]}))


if __name__ == "__main__": main()
