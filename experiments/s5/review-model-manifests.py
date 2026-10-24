"""Independent format/provenance consistency check of the two pilot locks.

Does not download, infer, approve output quality, or claim malware clearance.
Original source/license assertions are retained in the original locked manifests.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("model_policy", ROOT / "model-policy.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def classify(path):
    if path.endswith((".safetensors", ".gguf", ".onnx")):
        return "weights"
    if path.endswith(".tar.bz2"):
        return "archive"
    if path.lower().endswith(".md") or path.rsplit("/", 1)[-1] in {"LICENSE", "COPYING", "MODEL_CARD"}:
        return "license"
    if any(token in path.lower() for token in ("token", "vocab", "spm", "sentencepiece", "merges")):
        return "tokenizer"
    return "config"


def main():
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "model-admission-review.json"
    unified = {"schemaVersion": 1, "models": []}
    evidence = []
    for family in ("translation", "tts"):
        source_path = ROOT / family / "models.lock.json"
        raw = source_path.read_bytes()
        original = policy.strict_json(raw.decode("utf-8-sig"))
        evidence.append({"path": f"{family}/models.lock.json", "sha256": hashlib.sha256(raw).hexdigest(),
                         "models": len(original["models"])})
        for model in original["models"]:
            archive = model.get("archive")
            revision = model.get("revision", model.get("upstreamRevision"))
            if archive:
                repo = "k2-fsa/sherpa-onnx"
                source_revision = "tts-models"
                source_publisher = "k2-fsa"
                review_status = "verified-official"
                files = [archive]
            else:
                files = model["files"]
                repo = model.get("repository") or "/".join(files[0]["url"].split("/")[3:5])
                source_revision = revision
                source_publisher = repo.split("/")[0]
                review_status = "reviewed-conversion" if "unmerged" in model.get("provenance", "").lower() else "verified-official"
            if family == "translation":
                license_id = model["license"]
                license_url = f"https://huggingface.co/{repo}/blob/{revision}/README.md"
                scope = "model-weights"
            else:
                license_record = model["license"]
                license_id = "; ".join(f"{key}: {value}" for key, value in license_record.items() if key != "notes")
                license_url = model["modelCard"]
                scope = "voice-weights"
            artifacts = []
            for entry in files:
                if family == "translation":
                    relative = model["id"] + "/" + entry["path"]
                else:
                    relative = entry["path"] if archive else model["directory"] + "/" + entry["path"]
                artifacts.append({"path": relative, "url": entry["url"], "size": entry["bytes"],
                                  "sha256": entry["sha256"], "kind": classify(entry["path"])})
            unified["models"].append({"id": model["id"], "role": family if family != "tts" else "tts",
                "license": {"id": license_id, "sourceUrl": license_url, "scope": scope},
                "source": {"publisher": source_publisher, "repo": repo, "revision": source_revision,
                           "reviewStatus": review_status}, "artifacts": artifacts})
    policy.validate_manifest(unified)
    lock_bytes = (json.dumps(unified, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    lock_path = ROOT / "model-admission.lock.json"
    lock_path.write_bytes(lock_bytes)
    report = {"schemaVersion": 1, "status": "manifest-format-and-origin-consistency-checked",
              "limitations": ["License identifiers are provenance assertions from original reviewed locks, not a legal conclusion.",
                              "Official unmerged safetensors conversion commits stay explicitly reviewed-conversion.",
                              "Sherpa release tag origin can change; exact publisher archive SHA-256, not tag alone, fixes artifact identity.",
                              "No model loaded, no archive extracted, no malware clearance or translation/voice quality accepted."],
              "models": len(unified["models"]), "artifacts": sum(len(m["artifacts"]) for m in unified["models"]),
              "inputLocks": evidence, "policySha256": hashlib.sha256((ROOT / "model-policy.py").read_bytes()).hexdigest(),
              "admissionLockSha256": hashlib.sha256(lock_bytes).hexdigest()}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
