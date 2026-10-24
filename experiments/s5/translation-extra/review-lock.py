"""Independently normalize the extra lock without touching frozen base locks."""
import hashlib
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def main():
    spec = importlib.util.spec_from_file_location("s5_extra_model_policy", HERE.parent / "model-policy.py")
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    lock_path = HERE / "models.lock.json"
    raw = lock_path.read_bytes()
    original = policy.strict_json(raw.decode("utf-8"))
    if len(original["models"]) != 1:
        raise ValueError("One specifically reviewed extra conversion required")
    model = original["models"][0]
    if (model["id"], model["repository"], model["revision"]) != ("qwen35-4b-q4", "lmstudio-community/Qwen3.5-4B-GGUF", "f9f88ac3e234be915e23811a6d28ea287bdb927e"):
        raise ValueError("Extra conversion differs from explicit review")
    upstream_license = model["licenseEvidence"]
    license_path = ROOT / upstream_license["localEvidence"]
    data = license_path.read_bytes()
    if len(data) != upstream_license["bytes"] or hashlib.sha256(data).hexdigest() != upstream_license["sha256"]:
        raise ValueError("Upstream license evidence changed")
    normalized = {"schemaVersion": 1, "models": [{
        "id": model["id"], "role": "translation",
        "license": {"id": "apache-2.0", "sourceUrl": upstream_license["url"], "scope": "model-weights"},
        "source": {"publisher": "lmstudio-community", "repo": model["repository"], "revision": model["revision"], "reviewStatus": "reviewed-conversion"},
        "artifacts": [{"path": model["id"] + "/" + f["path"], "url": f["url"], "size": f["bytes"], "sha256": f["sha256"], "kind": "weights" if f["path"].endswith(".gguf") else "license"} for f in model["files"]],
    }]}
    policy.validate_manifest(normalized)
    destination = HERE / "model-admission.lock.json"
    normalized_bytes = (json.dumps(normalized, ensure_ascii=False, indent=2) + "\n").encode()
    destination.write_bytes(normalized_bytes)
    report = {"schemaVersion": 1, "status": "manifest-format-origin-and-license-evidence-consistency-checked",
        "model": model["id"], "artifacts": len(model["files"]), "inputManifestSha256": hashlib.sha256(raw).hexdigest(),
        "admissionLockSha256": hashlib.sha256(normalized_bytes).hexdigest(), "policySha256": hashlib.sha256((HERE.parent / "model-policy.py").read_bytes()).hexdigest(),
        "sourceReview": "Explicitly reviewed conversion, not Qwen-published GGUF. Converter card identifies base model and llama.cpp b8185 but not upstream source commit; numerical equivalence is not independently established.",
        "originalComparisonModified": False, "modelExecuted": False, "formatCheckScope": "Manifest only. Whole downloaded digest and GGUF header/native load checks are separate required gates.",
        "antivirus": "NOT_FULLY_SCANNED", "qualityAccepted": False, "memoryFitMeasured": False}
    (HERE / "model-admission-review.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
