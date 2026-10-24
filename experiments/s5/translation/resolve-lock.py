"""Read only official Hugging Face metadata/small data files; never download weights.

Only called deliberately during pilot preparation, never by offline inference.
"""
import datetime
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request

MODELS = [
    ("opus-en-ru", "Helsinki-NLP/opus-mt-en-ru", "3ff4dbd98515ba253f08f183e0de0b7ccf189ee3", "apache-2.0", "transformers-marian", "HF SFconvertbot unmerged PR7; upstream main has pickle; download safetensors only", ["README.md", "config.json", "generation_config.json", "model.safetensors", "source.spm", "target.spm", "tokenizer_config.json", "vocab.json"]),
    ("m2m100-418m", "facebook/m2m100_418M", "ae6407352f7f86e328c0f0678d466fc4246e78b3", "mit", "transformers-m2m100", "HF SFconvertbot unmerged PR27; upstream main has pickle; download safetensors only", ["README.md", "config.json", "generation_config.json", "model.safetensors", "sentencepiece.bpe.model", "special_tokens_map.json", "tokenizer_config.json", "vocab.json"]),
    ("qwen3-1.7b-q8", "Qwen/Qwen3-1.7B-GGUF", "90862c4b9d2787eaed51d12237eafdfe7c5f6077", "apache-2.0", "llama-http", "Official Qwen GGUF repository", ["LICENSE", "README.md", "Qwen3-1.7B-Q8_0.gguf"]),
    ("qwen3-4b-q4", "Qwen/Qwen3-4B-GGUF", "bc640142c66e1fdd12af0bd68f40445458f3869b", "apache-2.0", "llama-http", "Official Qwen GGUF repository", ["LICENSE", "README.md", "Qwen3-4B-Q4_K_M.gguf"]),
]


def get(url, limit):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "GargantuaS5Metadata/1.0"}), timeout=45) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Upstream metadata exceeded bounded read")
        return data


def main():
    models = []
    for identifier, repo, commit, license_name, provider, provenance, allowlist in MODELS:
        metadata_url = f"https://huggingface.co/api/models/{repo}/revision/{commit}?blobs=true"
        metadata = json.loads(get(metadata_url, 2 * 1024 * 1024))
        if metadata["sha"] != commit:
            raise ValueError("Upstream revision mismatch")
        siblings = {row["rfilename"]: row for row in metadata["siblings"]}
        files = []
        for name in allowlist:
            entry = siblings[name]
            url = f"https://huggingface.co/{repo}/resolve/{commit}/{urllib.parse.quote(name)}"
            size = entry["size"]
            if entry.get("lfs"):
                digest = entry["lfs"]["sha256"]
                digest_source = "upstream LFS SHA256 metadata"
            else:
                data = get(url, 8 * 1024 * 1024)
                if len(data) != size:
                    raise ValueError("Metadata size mismatch")
                digest = hashlib.sha256(data).hexdigest()
                digest_source = "SHA256 of bounded official pinned file bytes"
            files.append({"path": name, "url": url, "bytes": size, "sha256": digest, "digestSource": digest_source})
        models.append({"id": identifier, "repository": repo, "revision": commit, "license": license_name, "provider": provider, "provenance": provenance, "metadataUrl": metadata_url, "modelCard": f"https://huggingface.co/{repo}", "files": files, "downloadBytes": sum(row["bytes"] for row in files)})
    out = {"schemaVersion": 1, "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "security": {"allowedModelFormats": ["safetensors", "gguf"], "allowRemoteCode": False, "allowPickle": False, "inferenceNetwork": "none (loopback HTTP to in-container llama-server only)", "unmergedBotConversions": "Explicitly identified; not claimed accepted by model authors. Pin and hash every file."}, "models": models}
    path = Path(__file__).with_name("models.lock.json")
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"path": str(path), "models": len(models), "bytes": sum(m["downloadBytes"] for m in models)}))


if __name__ == "__main__":
    main()
