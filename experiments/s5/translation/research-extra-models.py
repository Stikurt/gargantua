"""Bounded public metadata research only: no weights, login, or remote code."""
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / ".local/s5-pilot/extra-model-research"
LLAMA_COMMIT = "c7fc5094179bf8a9c73c18593db714f8da41a402"
QUERIES = {
    "qwen35-official-4b": "https://huggingface.co/api/models/Qwen/Qwen3.5-4B?blobs=true",
    "qwen35-official-2b": "https://huggingface.co/api/models/Qwen/Qwen3.5-2B?blobs=true",
    "qwen35-official-4b-gguf": "https://huggingface.co/api/models/Qwen/Qwen3.5-4B-GGUF?blobs=true",
    "qwen35-official-2b-gguf": "https://huggingface.co/api/models/Qwen/Qwen3.5-2B-GGUF?blobs=true",
    "qwen35-official-catalog": "https://huggingface.co/api/models?author=Qwen&search=Qwen3.5&limit=100",
    "qwen35-lmstudio-4b": "https://huggingface.co/api/models/lmstudio-community/Qwen3.5-4B-GGUF?blobs=true",
    "qwen35-lmstudio-2b": "https://huggingface.co/api/models/lmstudio-community/Qwen3.5-2B-GGUF?blobs=true",
    "translategemma-official-4b": "https://huggingface.co/api/models/google/translategemma-4b-it?blobs=true",
    "nllb-official-600m": "https://huggingface.co/api/models/facebook/nllb-200-distilled-600M?blobs=true",
    "nllb-official-refs": "https://huggingface.co/api/models/facebook/nllb-200-distilled-600M/refs",
    "nllb-official-discussions": "https://huggingface.co/api/models/facebook/nllb-200-distilled-600M/discussions",
    "llama-exact-tree": f"https://api.github.com/repos/ggml-org/llama.cpp/git/trees/{LLAMA_COMMIT}?recursive=1",
}


def fetch(item):
    name, url = item
    req = urllib.request.Request(url, headers={"User-Agent": "GargantuaS5MetadataReview/1.0", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError("metadata-size-limit")
            parsed = json.loads(data)
            target = DEST / f"{name}.json"
            target.write_bytes(data)
            return {"name": name, "url": url, "status": response.status, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "path": str(target.relative_to(ROOT)), "value": parsed}
    except urllib.error.HTTPError as exc:
        return {"name": name, "url": url, "status": exc.code, "error": "http-error-no-body-retained"}
    except Exception as exc:
        return {"name": name, "url": url, "errorType": type(exc).__name__}


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(fetch, QUERIES.items()))
    summary = []
    for row in rows:
        data = row.pop("value", None)
        out = dict(row)
        if isinstance(data, dict) and "siblings" in data:
            out.update({"repository": data.get("id"), "revision": data.get("sha"), "gated": data.get("gated"), "license": data.get("cardData", {}).get("license"), "pipeline": data.get("pipeline_tag"), "files": data["siblings"]})
        elif row["name"] == "llama-exact-tree" and isinstance(data, dict):
            out["architectureFiles"] = [r["path"] for r in data.get("tree", []) if any(s in r["path"].lower() for s in ("qwen35", "qwen3.5", "gemma3", "llama-arch"))]
            out["truncated"] = data.get("truncated")
        elif row["name"] == "qwen35-official-catalog" and isinstance(data, list):
            out["repositories"] = [r.get("id") for r in data]
        elif isinstance(data, dict):
            out["value"] = data
        summary.append(out)
    report = {"schemaVersion": 1, "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "purpose": "ADDITIONAL_CANDIDATE_RESEARCH_ONLY_NO_WEIGHTS_DOWNLOADED", "rows": summary}
    path = DEST / "summary.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(path), "results": [{"name": r["name"], "status": r.get("status"), "revision": r.get("revision"), "gated": r.get("gated"), "license": r.get("license"), "files": len(r.get("files", [])), "errorType": r.get("errorType")} for r in summary]}))


if __name__ == "__main__":
    main()
