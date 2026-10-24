"""Freeze one explicitly reviewed conversion; read metadata only, never weights."""
import datetime
import hashlib
import json
from pathlib import Path
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
RESEARCH = ROOT / ".local/s5-pilot/extra-model-research"
REPO = "lmstudio-community/Qwen3.5-4B-GGUF"
REVISION = "f9f88ac3e234be915e23811a6d28ea287bdb927e"
UPSTREAM = "Qwen/Qwen3.5-4B"
UPSTREAM_AT_REVIEW = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
MODEL_FILE = "Qwen3.5-4B-Q4_K_M.gguf"
MODEL_SIZE = 2707513696
MODEL_SHA = "25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c"


def get(url, limit):
    req = urllib.request.Request(url, headers={"User-Agent": "GargantuaS5MetadataReview/1.0"})
    with urllib.request.urlopen(req, timeout=45) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Metadata exceeds bound")
        return data


def main():
    metadata_url = f"https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true"
    metadata = json.loads(get(metadata_url, 2 * 1024 * 1024))
    if metadata["sha"] != REVISION or metadata.get("gated") is not False or metadata["cardData"]["license"] != "apache-2.0":
        raise ValueError("Conversion repository identity/license/gate changed")
    entries = {r["rfilename"]: r for r in metadata["siblings"]}
    if "LICENSE" in entries:
        raise ValueError("Unexpected license artifact; update review instead of implicit inclusion")
    if entries[MODEL_FILE]["size"] != MODEL_SIZE or entries[MODEL_FILE]["lfs"]["sha256"] != MODEL_SHA:
        raise ValueError("Explicitly approved model identity differs")
    files = []
    for filename in (MODEL_FILE, "README.md"):
        entry = entries[filename]
        url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{filename}"
        if filename == MODEL_FILE:
            digest, source = MODEL_SHA, "upstream LFS SHA256 metadata; complete download must match before admission"
        else:
            data = get(url, 128 * 1024)
            if len(data) != entry["size"]:
                raise ValueError("README byte count differs")
            digest, source = hashlib.sha256(data).hexdigest(), "SHA256 of bounded pinned converter README bytes"
        files.append({"path": filename, "url": url, "bytes": entry["size"], "sha256": digest, "digestSource": source})
    license_bytes = (RESEARCH / "qwen35-4b-LICENSE").read_bytes()
    license_sha = hashlib.sha256(license_bytes).hexdigest()
    if b"Apache License" not in license_bytes or b"Version 2.0" not in license_bytes:
        raise ValueError("Reviewed upstream license evidence missing")
    model = {
        "id": "qwen35-4b-q4", "repository": REPO, "revision": REVISION,
        "license": "apache-2.0", "provider": "llama-http",
        "provenance": "Explicitly reviewed LM Studio team conversion of Qwen/Qwen3.5-4B using llama.cpp b8185 per converter card. Not published by Qwen; converter does not pin original upstream commit and numerical equivalence is not independently proven.",
        "metadataUrl": metadata_url, "modelCard": f"https://huggingface.co/{REPO}",
        "upstream": {"repository": UPSTREAM, "revisionObservedAtReview": UPSTREAM_AT_REVIEW, "converterPinnedSourceRevision": None, "sourceEquivalenceClaim": "NOT_PROVEN"},
        "licenseEvidence": {"license": "apache-2.0", "url": f"https://huggingface.co/{UPSTREAM}/resolve/{UPSTREAM_AT_REVIEW}/LICENSE", "bytes": len(license_bytes), "sha256": license_sha, "localEvidence": str((RESEARCH / "qwen35-4b-LICENSE").relative_to(ROOT)), "conversionRepositoryLicenseFile": None, "licenseDeclaredInPinnedConverterCard": True},
        "scope": "Separate fifth experimental candidate after original Qwen3 profiles failed semantic screening; original four-model corpus, comparison lock and recipes stay frozen.",
        "inference": {"textOnly": True, "visionProjector": False, "mtpSpeculation": False, "enableThinking": False, "contextLimitForPilot": 4096, "fitStatus": "NOT_MEASURED", "architectureSupport": "qwen35 loader and hybrid graph present in installed llama.cpp source c7fc5094179bf8a9c73c18593db714f8da41a402; actual GPU load still required"},
        "files": files, "downloadBytes": sum(r["bytes"] for r in files),
    }
    out = {"schemaVersion": 1, "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "security": {"allowedModelFormats": ["gguf"], "allowRemoteCode": False, "allowPickle": False, "inferenceNetwork": "none; internal loopback to same sandbox llama-server only", "originalComparisonManifest": "experiments/s5/translation/models.lock.json", "malwareClaim": "Pinned origin/size/hash is identity only; strict format checks and offline OS sandbox are required. No whole-file antivirus clearance claimed."}, "models": [model]}
    path = HERE / "models.lock.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "models": len(out["models"]), "artifacts": len(files), "downloadBytes": model["downloadBytes"]}))


if __name__ == "__main__":
    main()
