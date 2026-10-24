"""Serialize the four admitted TTS comparisons inside one externally held slot.

This coordinator never launches multiple inference cases concurrently. Per-case
failures are retained and the other profiles still run. A completed waveform
benchmark is explicitly distinct from listening or production acceptance.
"""
from __future__ import annotations
import argparse
import datetime
import hashlib
import json
import pathlib
import subprocess
import sys
import time


def sha(path):
    with path.open("rb") as stream: return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    source = pathlib.Path(__file__).resolve().parent
    workspace = source.parents[2]
    pilot = (workspace / ".local" / "s5-pilot").resolve()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--models-root", type=pathlib.Path, default=pilot / "tts-models")
    parser.add_argument("--repeat", type=int, default=2, choices=[1, 2, 3])
    args = parser.parse_args()
    directory = (args.output if args.output.is_absolute() else workspace / args.output).resolve()
    if directory == pilot or not directory.is_relative_to(pilot) or directory.exists():
        raise ValueError("batch output must be a fresh pilot subdirectory")
    directory.mkdir(parents=True)
    lock = json.loads((source / "models.lock.json").read_text(encoding="utf-8"))
    frozen = {"manifestSha256":sha(source / "models.lock.json"), "corpusSha256":sha(source / "corpus.json")}
    result = {"schemaVersion":1,"status":"running","startedAtUtc":datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "repeat":args.repeat,"frozen":frozen,"cases":[],"listening":"NOT_LISTENED",
              "productionAcceptance":False,"reservation":"Externally granted exclusive root pilot slot; sequential cases only."}

    def save():
        (directory / "batch.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    save()
    for model in lock["models"]:
        case = directory / model["id"]
        start = time.perf_counter()
        command = [sys.executable,str(source / "run-cpu.py"),"--model",model["id"],"--output",str(case),
                   "--models-root",str(args.models_root),"--repeat",str(args.repeat)]
        completed = subprocess.run(command, check=False)
        row = {"model":model["id"],"exitCode":completed.returncode,"wallSeconds":time.perf_counter()-start,
               "status":"failed","case":model["id"],"report":f"{model['id']}/results/audio/report.json"}
        if completed.returncode == 0:
            report = json.loads((case / "results/audio/report.json").read_text(encoding="utf-8"))
            if any(report.get(key) != value for key,value in frozen.items()):
                row["reason"] = "inputs changed across cases; do not compare as one frozen benchmark"
            else:
                row.update({"status":"technical-pass","aggregateRealTimeFactor":report["aggregateRealTimeFactor"],
                    "peakProcessRssBytes":report["peakProcessRssBytes"],"modelLoadSeconds":report["modelLoadSeconds"],
                    "sampleCount":report["sampleCount"],"totalAudioSeconds":report["totalAudioSeconds"],
                    "narrativeAudio":f"{model['id']}/results/audio/narrative-1.wav",
                    "normalizationPair":[f"{model['id']}/results/audio/numbers-raw-1.wav",f"{model['id']}/results/audio/numbers-normalized-1.wav"],
                    "listening":"NOT_LISTENED","semanticIntelligibility":"not measured"})
        result["cases"].append(row); save()
        print(json.dumps({"caseFinished":row}, ensure_ascii=False), flush=True)
    result["status"] = "completed" if all(c["status"] == "technical-pass" for c in result["cases"]) else "completed-with-failures"
    result["finishedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
    print(json.dumps({"batchFinished":True,"status":result["status"],"cases":len(result["cases"]),"result":str(directory/"batch.json")}))
    if result["status"] != "completed": raise SystemExit(2)


if __name__ == "__main__": main()
