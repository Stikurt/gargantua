"""Original long-chapter TTS reliability pilot with verified resumable PCM cache.

Experimental filesystem protocol only: no production DB/API, publication,
authorization, book download, malware-free claim or listening acceptance.
"""
from __future__ import annotations
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import re
import time
from soak_cache import PcmCache,atomic_json,canonical,digest,load_json
from runner import build_engine,proc_rss,signal_metrics,verify_staged


def load_source(corpus_path,lock_path):
    corpus=load_json(corpus_path); lock=load_json(lock_path)
    if lock["sourceSha256"]!=digest(corpus_path): raise ValueError("frozen source changed")
    paragraphs=corpus["paragraphs"]
    if not 16<=len(paragraphs)<=20 or len({p["id"] for p in paragraphs})!=len(paragraphs):
        raise ValueError("long-chapter paragraph budget/order")
    observed=[]
    for item in paragraphs:
        if not 1<=len(item["text"])<=1600: raise ValueError("paragraph text budget")
        observed.append({"id":item["id"],"textSha256":hashlib.sha256(item["text"].encode()).hexdigest(),"characters":len(item["text"])})
    if observed!=lock["paragraphs"]: raise ValueError("source paragraph/order differs from frozen reference")
    return corpus,observed


def main():
    source=pathlib.Path(__file__).resolve().parent
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-root",type=pathlib.Path,required=True)
    parser.add_argument("--output",type=pathlib.Path,required=True)
    parser.add_argument("--image-id",required=True)
    parser.add_argument("--resume",action="store_true")
    parser.add_argument("--stop-after",type=int,default=0)
    args=parser.parse_args()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}",args.image_id) or not 0<=args.stop_after<=20:
        raise ValueError("image/controlled pause argument invalid")
    for key in ("OMP_NUM_THREADS","OPENBLAS_NUM_THREADS","MKL_NUM_THREADS","NUMEXPR_NUM_THREADS"):
        os.environ[key]="2"
    started=time.perf_counter()
    corpus,ordered=load_source(source/"soak-corpus.json",source/"soak-corpus.lock.json")
    lock=json.loads((source/"models.lock.json").read_text(encoding="utf-8"))
    model=next(item for item in lock["models"] if item["id"]=="piper-denis-fp32")
    verify_staged(args.models_root,source/"models.lock.json",model)
    prepared=load_json(args.models_root/"prepared.json")
    entry=next(item for item in prepared["models"] if item["id"]==model["id"])
    recipe={"schemaVersion":1,"policy":"original-chapter-pcm-cache-v1","model":model["id"],
        "modelManifestSha256":digest(source/"models.lock.json"),
        "preparedModelEntrySha256":hashlib.sha256(canonical(entry)).hexdigest(),"runtimeImageId":args.image_id,
        "sourceSha256":digest(source/"soak-corpus.json"),"sourceReferenceSha256":digest(source/"soak-corpus.lock.json"),
        "driverSha256":{name:digest(source/name) for name in ("soak.py","soak_cache.py","runner.py","formats.py")},
        "paragraphs":ordered,"sampleRate":22050,"channels":1,"sampleWidthBytes":2,"voice":0,"speed":1.0,"threads":2,
        "normalization":{"version":"original-display-text-direct-v1","actualSpokenInput":"Exact paragraph text passed to the fixed Piper/espeak frontend; character/word alignment was not measured."},
        "joinPolicy":"Exact ordered PCM payload concatenation without added/dropped/repeated frames","seedControlled":False}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    owner=args.output.parent/(args.output.name+".owner.lock")
    descriptor=os.open(owner,os.O_RDWR|os.O_CREAT|getattr(os,"O_NOFOLLOW",0),0o600)
    try:
        fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        cache=PcmCache(args.output,recipe,resume=args.resume); cache.reconcile_partials()
        # Validate every cached item before loading the inference engine, so
        # later corruption cannot be silently accepted after spending compute.
        cached={item["id"]:cache.load(item["id"],item["textSha256"]) for item in ordered}
        generated=0; reused=0; engine=None; model_load=0; runtime=None
        for paragraph,binding in zip(corpus["paragraphs"],ordered,strict=True):
            if cached[paragraph["id"]] is not None:
                reused+=1; continue
            if engine is None:
                loading=time.perf_counter()
                engine,runtime=build_engine(model,args.models_root/model["id"]/model["directory"],2)
                model_load=time.perf_counter()-loading
            segment_start=time.perf_counter(); cpu_start=time.process_time()
            samples,rate,coverage=engine(paragraph["text"],70123+generated)
            elapsed=time.perf_counter()-segment_start; cpu_seconds=time.process_time()-cpu_start
            if rate!=recipe["sampleRate"]: raise ValueError("voice changed sample rate")
            metrics=signal_metrics(samples,rate)
            if not metrics["integrityPassed"]: raise ValueError("generated segment failed signal checks")
            import numpy as np
            payload=(np.clip(np.asarray(samples,dtype=np.float32).reshape(-1),-1,1)*32767).astype("<i2").tobytes()
            cache.save(paragraph["id"],binding["textSha256"],payload,
                {"wallSeconds":elapsed,"cpuSeconds":cpu_seconds,"signal":metrics,"coverage":coverage,"peakProcessRssBytes":proc_rss()})
            generated+=1
            print(json.dumps({"segmentCommitted":paragraph["id"],"generatedThisRun":generated,"audioSeconds":metrics["durationSeconds"]}),flush=True)
            if args.stop_after and generated>=args.stop_after:
                result={"schemaVersion":1,"status":"paused-at-verified-checkpoint","recipeSha256":cache.recipe_sha,
                    "generatedSegments":generated,"reusedSegments":reused,"chapterReady":False,
                    "wallSeconds":time.perf_counter()-started,"peakProcessRssBytes":proc_rss(),"modelLoadSeconds":model_load,
                    "committedSegments":[{"id":item["id"],"sha256":cache.load(item["id"],item["textSha256"])["pcm"]["sha256"]}
                        for item in ordered if cached[item["id"]] is not None or (cache.checkpoints/(item["id"]+".json")).exists()]}
                atomic_json(args.output/"last-run.json",result); print(json.dumps(result)); return
        chapter=cache.join(ordered,minimum_seconds=600,maximum_seconds=1200)
        segments=[cache.load(item["id"],item["textSha256"]) for item in ordered]
        synthesis=sum(item["generation"]["wallSeconds"] for item in segments)
        report={"schemaVersion":1,"status":"completed","model":model["id"],"recipeSha256":cache.recipe_sha,
            "generatedSegments":generated,"reusedSegments":reused,"totalSegments":len(segments),
            "sourceWords":sum(len(re.findall(r"\w+",p["text"])) for p in corpus["paragraphs"]),
            "chapter":chapter,"chapterReady":True,"totalAudioSeconds":chapter["pcm"]["durationSeconds"],
            "totalSynthesisSeconds":synthesis,"aggregateRealTimeFactor":synthesis/chapter["pcm"]["durationSeconds"],
            "wallSeconds":time.perf_counter()-started,"peakProcessRssBytes":proc_rss(),"modelLoadSeconds":model_load,
            "runtime":runtime,"orphansQuarantinedThisRun":cache.orphans,"directoryFsyncSupported":cache.directory_fsync,
            "auditoryReview":"NOT_LISTENED","forcedAlignment":"NOT_PERFORMED","productionAcceptance":False,
            "limits":["One original synthetic chapter, not a complete book or days-long server endurance test.",
                      "Exact PCM frame/order continuity is verified; spoken word completeness, prosody, seams and listener fatigue were not heard.",
                      "Filesystem pilot without database jobs, authorization or production provider publication."]}
        atomic_json(args.output/"report.json",report); atomic_json(args.output/"last-run.json",report)
        print(json.dumps({key:report[key] for key in ("status","generatedSegments","reusedSegments","totalAudioSeconds","aggregateRealTimeFactor","peakProcessRssBytes")}))
    finally:
        os.close(descriptor)


if __name__=="__main__": main()
