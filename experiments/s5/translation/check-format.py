"""Pinned MT/GGUF admission checks, to run inside the offline pilot sandbox.

GGUF header checks are deliberately not described as a full format audit.
Native parsers/inference remain inside the same restricted boundary.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tts"))
from formats import inspect_safetensors, strict_object


def reject_constant(value): raise ValueError("Non-finite JSON constant")


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""): h.update(chunk)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--lock", type=Path, default=Path(__file__).with_name("models.lock.json"))
    args = p.parse_args()
    lock = json.loads(args.lock.read_text(encoding="utf-8"))
    model = next(m for m in lock["models"] if m["id"] == args.id)
    expected_type = {"opus-en-ru":"marian", "m2m100-418m":"m2m_100"}
    checked = []
    directory = args.root / args.id
    allowed = {f["path"] for f in model["files"]}
    if any(x.is_symlink() or x.is_file() and x.relative_to(directory).as_posix() not in allowed for x in directory.rglob("*")):
        raise ValueError("Unexpected or linked model file")
    for spec in model["files"]:
        path = directory / spec["path"]
        if not path.is_file() or path.stat().st_size != spec["bytes"] or sha(path) != spec["sha256"]:
            raise ValueError("Artifact identity mismatch")
        item = {"path": spec["path"], "bytes": spec["bytes"], "sha256": spec["sha256"]}
        if path.suffix == ".json":
            if path.stat().st_size > 8 * 1024 * 1024: raise ValueError("JSON budget")
            data = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=strict_object, parse_constant=reject_constant)
            if isinstance(data, dict) and ("auto_map" in data or "custom_pipelines" in data):
                raise ValueError("Model-supplied code mapping is not admitted")
            if path.name == "config.json" and data.get("model_type") != expected_type.get(args.id):
                raise ValueError("Unexpected model architecture")
            item["inspection"] = "strict data-only JSON"
        elif path.suffix == ".safetensors": item["inspection"] = inspect_safetensors(path)
        elif path.suffix == ".gguf":
            with path.open("rb") as stream: header = stream.read(24)
            if len(header) != 24: raise ValueError("Truncated GGUF header")
            magic, version, tensors, metadata = struct.unpack("<4sIQQ", header)
            if magic != b"GGUF" or version != 3 or not 1 <= tensors <= 10000 or not 1 <= metadata <= 10000:
                raise ValueError("Unexpected GGUF header")
            item["inspection"] = {"format":"GGUF", "version":version, "tensors":tensors, "metadataEntries":metadata,
                                  "scope":"Header only; full native parser is contained in the offline llama-server sandbox"}
        else: item["inspection"] = "Pinned data/tokenizer/card artifact; no execution"
        checked.append(item)
    report = {"schemaVersion":1, "status":"verified-pinned-artifacts", "model":args.id,
              "manifestSha256":sha(args.lock), "artifacts":checked,
              "antivirus":{"status":"NOT_FULLY_SCANNED", "reason":"Production book scanner has bounded small-file limits. Model admission uses reviewed pinned provenance, data-only formats, structural checks, no remote code/pickle, offline least-privilege OS containment. This is not a malware-free guarantee."}}
    if args.output.exists(): raise ValueError("Do not overwrite an admission report")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status":report["status"], "model":args.id, "files":len(checked)}))


if __name__ == "__main__": main()
