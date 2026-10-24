"""Windows launcher for the explicitly granted long-chapter TTS pilot slot."""
from __future__ import annotations
import argparse
import json
import pathlib
import re
import subprocess
import sys
import uuid


def main():
    source=pathlib.Path(__file__).resolve().parent; workspace=source.parents[2]
    pilot=(workspace/".local/s5-pilot").resolve()
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=pathlib.Path,required=True)
    parser.add_argument("--resume",action="store_true")
    parser.add_argument("--stop-after",type=int,default=0)
    args=parser.parse_args()
    case=(args.output if args.output.is_absolute() else workspace/args.output).resolve()
    models=(pilot/"tts-models").resolve()
    if (case==pilot or not case.is_relative_to(pilot) or case.is_relative_to(models) or models.is_relative_to(case)
        or not 0<=args.stop_after<=20): raise ValueError("case/controlled pause outside pilot bounds")
    if args.resume:
        if not (case/"results/audio/recipe.json").is_file(): raise ValueError("resume requires an initialized case recipe")
    elif case.exists(): raise ValueError("new case already exists")
    if any("," in str(p) or any(ord(c)<32 for c in str(p)) for p in (source,case,models)):
        raise ValueError("unsafe Docker mount path")
    image=subprocess.run(["docker","image","inspect","gargantua-s5-cpu:pilot","--format","{{.Id}}"],check=True,capture_output=True,text=True).stdout.strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}",image): raise ValueError("runtime image is not immutable")
    case.mkdir(parents=True,exist_ok=args.resume); results=case/"results"; results.mkdir(exist_ok=args.resume)
    attempt=1
    while (case/f"telemetry-{attempt:02}").exists():
        attempt+=1
        if attempt>10: raise ValueError("pilot attempt budget")
    name=f"gargantua-s5-tts-soak-{uuid.uuid4().hex[:8]}"
    docker=["run","--rm","--name",name,"--network","none","--read-only","--user","1000:1000",
        "--cap-drop","ALL","--security-opt","no-new-privileges","--memory","2g","--memory-swap","2g","--cpus","2","--pids-limit","128",
        "--tmpfs","/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
        "--env","HOME=/tmp","--env","HF_HOME=/tmp/hf","--env","PYTHONDONTWRITEBYTECODE=1",
        "--env","HF_HUB_OFFLINE=1","--env","TRANSFORMERS_OFFLINE=1","--env","OMP_NUM_THREADS=2","--env","OPENBLAS_NUM_THREADS=2",
        "--mount",f"type=bind,source={source},target=/experiment,readonly",
        "--mount",f"type=bind,source={models},target=/models,readonly",
        "--mount",f"type=bind,source={results},target=/results","--workdir","/experiment",image,
        "python","/experiment/soak.py","--models-root","/models","--output","/results/audio","--image-id",image,
        "--stop-after",str(args.stop_after)]
    if args.resume: docker.append("--resume")
    launch={"schemaVersion":1,"imageId":image,"containerName":name,"attempt":attempt,"resume":args.resume,"stopAfter":args.stop_after,
        "isolation":{"network":"none","root":"read-only","user":"1000:1000","cpus":2,"memoryBytes":2*1024**3,"noProductionMounts":True},
        "reservation":"External root coordinator must grant exclusive heavy slot; no concurrent MT/TTS/parser."}
    (case/f"launch-{attempt:02}.json").write_text(json.dumps(launch,indent=2),encoding="utf-8")
    command=[sys.executable,str(source.parent/"run-container.py"),"--name",name,"--timeout","1200","--output",str(case/f"telemetry-{attempt:02}"),"--",*docker]
    completed=subprocess.run(command,check=False)
    if completed.returncode: raise SystemExit(completed.returncode)
    status=json.loads((results/"audio/last-run.json").read_text(encoding="utf-8"))
    telemetry=json.loads((case/f"telemetry-{attempt:02}/telemetry-summary.json").read_text(encoding="utf-8"))
    if not telemetry.get("cleanupVerified"): raise ValueError("owned container cleanup not verified")
    (case/f"attempt-{attempt:02}.json").write_text(json.dumps(status,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"attempt":attempt,"status":status["status"],"generatedSegments":status["generatedSegments"],
        "reusedSegments":status["reusedSegments"],"chapterReady":status["chapterReady"],"cleanupVerified":True}))


if __name__=="__main__": main()
