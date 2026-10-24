"""Verify explicitly admitted artifacts and stage data-only models offline.

Large model artifacts may not have been fully scanned by antivirus. Admission
uses pinned provenance, exact bytes/hashes, data-only format inspection, and OS
isolation. The admission receipt must state antivirus limits truthfully. This
command is not an antivirus scan. No inference or archive supplied code runs.
"""
from __future__ import annotations
import argparse
import json
import pathlib
import shutil
from safety import digest, extract_bounded
from formats import inspect_model, strict_object


def verify(path, spec):
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"missing/linked artifact: {spec['path']}")
    if path.stat().st_size != spec["bytes"] or digest(path) != spec["sha256"]:
        raise ValueError(f"artifact hash/size mismatch: {spec['path']}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-root", type=pathlib.Path, required=True,
                        help="Download root: archives and mms-tts-rus/ files")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--allow-empty-output", action="store_true",
                        help="Permit an existing empty Docker bind-mount root; never overwrite staged content")
    parser.add_argument("--admission-receipt", type=pathlib.Path, required=True)
    parser.add_argument("--lock", type=pathlib.Path, default=pathlib.Path(__file__).with_name("models.lock.json"))
    args = parser.parse_args()
    if args.output.exists():
        if not args.allow_empty_output or not args.output.is_dir() or args.output.is_symlink() or any(args.output.iterdir()):
            raise ValueError("staging output already exists/nonempty; never overwrite it")
    lock = json.loads(args.lock.read_text(encoding="utf-8"))
    admission = json.loads(args.admission_receipt.read_text(encoding="utf-8"))
    if (admission.get("schemaVersion") != 1
        or admission.get("status") != "verified-pinned-artifacts"
        or admission.get("manifestSha256") != digest(args.lock)
        or admission.get("antivirus", {}).get("status") not in {"NOT_FULLY_SCANNED", "FULLY_SCANNED"}):
        raise ValueError("explicit bounded model admission receipt is missing/incompatible")
    args.output.mkdir(parents=True, exist_ok=args.allow_empty_output)
    entries = []
    for model in lock["models"]:
        item = {"id": model["id"], "files": []}
        target = args.output / model["id"]
        if "archive" in model:
            source = args.models_root / model["archive"]["path"]
            verify(source, model["archive"])
            item["archive"] = model["archive"]["sha256"]
            item["extraction"] = extract_bounded(source, target)
        else:
            directory = target / model["directory"]
            directory.mkdir(parents=True)
            for spec in model["files"]:
                source = args.models_root / model["directory"] / spec["path"]
                verify(source, spec)
                if spec["path"].endswith(".json"):
                    configuration = json.loads(source.read_text(encoding="utf-8"), object_pairs_hook=strict_object)
                    if not isinstance(configuration, dict):
                        raise ValueError("model configuration must be an object")
                    if "auto_map" in configuration or "custom_pipelines" in configuration:
                        raise ValueError("model-supplied code mapping is forbidden")
                shutil.copyfile(source, directory / spec["path"])
        directory = target / model["directory"]
        if not directory.is_dir():
            raise ValueError(f"unexpected archive top directory: {model['id']}")
        expected = (model.get("modelFilename") or "model.safetensors")
        if not (directory / expected).is_file():
            actual = sorted(p.name for p in directory.glob("*.onnx"))
            raise ValueError(f"model filename mismatch {model['id']}: expected {expected}, observed {actual}")
        item["modelFormatInspection"] = inspect_model(directory / expected, canonicalize_legacy_metadata=True)
        for path in sorted(target.rglob("*")):
            if path.is_symlink():
                raise ValueError("linked staged file")
            if path.is_file():
                item["files"].append({"path": str(path.relative_to(args.output)).replace("\\", "/"),
                                      "bytes": path.stat().st_size, "sha256": digest(path)})
        entries.append(item)
    report = {"schemaVersion": 1, "status": "hash-verified-staged",
              "antivirus": admission["antivirus"],
              "admissionReceiptSha256": digest(args.admission_receipt),
              "admissionPolicy": "Pinned publisher/provenance + exact bytes/SHA256 + bounded data-only format inspection + offline OS isolation; not a promise of absence of threats.",
              "manifestSha256": digest(args.lock), "models": entries}
    (args.output / "prepared.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"status": report["status"], "models": len(entries),
                      "expandedBytes": sum(f["bytes"] for m in entries for f in m["files"])}))


if __name__ == "__main__": main()
