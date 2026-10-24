"""Resolve extra research candidates from bounded pinned metadata, never weights.

The original four-model comparison lock is deliberately untouched.
"""
import datetime
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / ".local/s5-pilot/extra-model-research"
LLAMA_COMMIT = "c7fc5094179bf8a9c73c18593db714f8da41a402"
SMALL = {
    "lmstudio-4b-card.md": "https://huggingface.co/lmstudio-community/Qwen3.5-4B-GGUF/resolve/f9f88ac3e234be915e23811a6d28ea287bdb927e/README.md",
    "lmstudio-2b-card.md": "https://huggingface.co/lmstudio-community/Qwen3.5-2B-GGUF/resolve/bb84e11355a036e28f080c7793fa6d22b7c4e344/README.md",
    "qwen35-4b-config.json": "https://huggingface.co/Qwen/Qwen3.5-4B/resolve/851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a/config.json",
    "qwen35-4b-card.md": "https://huggingface.co/Qwen/Qwen3.5-4B/resolve/851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a/README.md",
    "qwen35-4b-LICENSE": "https://huggingface.co/Qwen/Qwen3.5-4B/resolve/851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a/LICENSE",
    "qwen35-2b-config.json": "https://huggingface.co/Qwen/Qwen3.5-2B/resolve/15852e8c16360a2fea060d615a32b45270f8a8fc/config.json",
    "nllb-pr45.json": "https://huggingface.co/api/models/facebook/nllb-200-distilled-600M/revision/refs%2Fpr%2F45?blobs=true",
    "nllb-pr45-discussion.json": "https://huggingface.co/api/models/facebook/nllb-200-distilled-600M/discussions/45",
    "nllb-card.md": "https://huggingface.co/facebook/nllb-200-distilled-600M/resolve/f8d333a098d19b4fd9a8b18f94170487ad3f821d/README.md",
    "llama-qwen35.cpp": f"https://raw.githubusercontent.com/ggml-org/llama.cpp/{LLAMA_COMMIT}/src/models/qwen35.cpp",
    "llama-arch.cpp": f"https://raw.githubusercontent.com/ggml-org/llama.cpp/{LLAMA_COMMIT}/src/llama-arch.cpp",
    "llama-qwen35-template.jinja": f"https://raw.githubusercontent.com/ggml-org/llama.cpp/{LLAMA_COMMIT}/models/templates/Qwen3.5-4B.jinja",
    "llama-convert.py.txt": f"https://raw.githubusercontent.com/ggml-org/llama.cpp/{LLAMA_COMMIT}/convert_hf_to_gguf.py",
}


def get(url, limit=2 * 1024 * 1024):
    req = urllib.request.Request(url, headers={"User-Agent": "GargantuaS5MetadataReview/1.0"})
    with urllib.request.urlopen(req, timeout=45) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError("bounded metadata limit")
        return data


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    evidence = []
    for filename, url in SMALL.items():
        data = get(url)
        (DEST / filename).write_bytes(data)
        evidence.append({"url": url, "path": str((DEST / filename).relative_to(ROOT)), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    (DEST / "small-evidence.json").write_text(json.dumps({"createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "files": evidence}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"files": len(evidence), "bytes": sum(r["bytes"] for r in evidence)}))


if __name__ == "__main__":
    main()
