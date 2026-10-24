"""Inspect MMS's actual local text preprocessing without loading voice weights.

This can prove that characters are absent from model input tokens. It cannot
prove what an audio listener hears or quantify pronunciation/naturalness.
"""
from __future__ import annotations
import argparse
import hashlib
import inspect
import json
import os
import pathlib
import re

os.environ.update({"HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1",
                   "HF_HUB_DISABLE_TELEMETRY":"1","DO_NOT_TRACK":"1"})


def digest(path):
    with path.open("rb") as source: return hashlib.file_digest(source,"sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-root",type=pathlib.Path,required=True)
    parser.add_argument("--output",type=pathlib.Path,required=True)
    args = parser.parse_args()
    source = pathlib.Path(__file__).resolve().parent
    lock = json.loads((source/"models.lock.json").read_text(encoding="utf-8"))
    prepared = json.loads((args.models_root/"prepared.json").read_text(encoding="utf-8"))
    if prepared["manifestSha256"] != digest(source/"models.lock.json"):
        raise ValueError("staged manifest mismatch")
    model = next(item for item in lock["models"] if item["id"]=="mms-rus-fp32")
    entry = next(item for item in prepared["models"] if item["id"]==model["id"])
    for spec in entry["files"]:
        if not spec["path"].endswith(".json"): continue
        path = args.models_root/spec["path"]
        if path.stat().st_size!=spec["bytes"] or digest(path)!=spec["sha256"]:
            raise ValueError("tokenizer data changed")
    from transformers import VitsTokenizer
    import transformers
    tokenizer=VitsTokenizer.from_pretrained(args.models_root/model["id"]/model["directory"],
                                           local_files_only=True,trust_remote_code=False)
    corpus=json.loads((source/"corpus.json").read_text(encoding="utf-8"))
    rows=[]
    for sample in corpus["samples"]:
        if sample["id"] not in {"numbers-raw","numbers-normalized","mixed-script"}: continue
        ids=tokenizer(sample["text"],truncation=False)["input_ids"]
        tokens=tokenizer.convert_ids_to_tokens(ids)
        can_remove_blanks=(bool(getattr(tokenizer,"add_blank",False)) and all(value==tokenizer.pad_token_id for value in ids[::2]))
        reconstructed="".join(tokens[1::2] if can_remove_blanks else tokens)
        rows.append({"sample":sample["id"],"sourceText":sample["text"],"tokenIds":ids,"tokens":tokens,
            "insertedBlankTokensRemovedInReconstruction":can_remove_blanks,
            "reconstructedModelCharacters":reconstructed,
            "sourceAsciiDigits":sorted(set(re.findall(r"[0-9]",sample["text"]))),
            "encodedAsciiDigits":sorted(set(re.findall(r"[0-9]",reconstructed))),
            "sourceLatinWords":re.findall(r"[A-Za-z]+",sample["text"]),
            "encodedLatinCharacters":sorted(set(re.findall(r"[a-zA-Z]",reconstructed))),
            "scope":"Exact tokenizer IDs before model; not transcription of generated speech."})
    report={"schemaVersion":1,"model":model["id"],"weightsLoaded":False,
        "manifestSha256":digest(source/"models.lock.json"),"corpusSha256":digest(source/"corpus.json"),
        "transformersVersion":transformers.__version__,
        "tokenizerModuleSha256":digest(pathlib.Path(inspect.getfile(VitsTokenizer))),
        "addBlank":getattr(tokenizer,"add_blank",None),"padToken":tokenizer.pad_token,
        "samples":rows,"auditoryReview":"NOT_LISTENED"}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open("x",encoding="utf-8") as output:
        json.dump(report,output,ensure_ascii=False,indent=2)
    print(json.dumps({"model":model["id"],"weightsLoaded":False,"samples":[
        {key:row[key] for key in ("sample","sourceAsciiDigits","encodedAsciiDigits","sourceLatinWords","encodedLatinCharacters")}
        for row in rows]},ensure_ascii=False))


if __name__=="__main__": main()
