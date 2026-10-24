"""Download only the separately approved fifth candidate, never execute it.

Uses the reviewed bounded base transport in its own process/state. No CLI URL,
login, pickle, projection model, or arbitrary extra repository is accepted.
"""
from __future__ import annotations
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
LOCK = HERE / "models.lock.json"
LOCK_SHA = "efb5dc9626f357d4a2cf829053afbd800c4376a8ca21b6507bde159d65e33f51"
REPO = "lmstudio-community/Qwen3.5-4B-GGUF"
REVISION = "f9f88ac3e234be915e23811a6d28ea287bdb927e"
MODEL_ID = "qwen35-4b-q4"
APPROVED_FILES = {
    "Qwen3.5-4B-Q4_K_M.gguf": (2707513696, "25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c"),
    "README.md": (2100, "e1b3ca9c804ec81f9d0f8e51eab46d4e0e1b18521e7436bcb95736fb3d0414ae"),
}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_owned_path(path):
    """Refuse preexisting symlink/junction/hardlink redirection before transport."""
    relative = path.relative_to(ROOT)
    current = ROOT
    for component in relative.parts:
        current = current / component
        if current.is_symlink() or current.is_junction():
            raise ValueError("Download/state path redirects outside owned storage")
        if current.exists() and current.is_file() and current.stat().st_nlink != 1:
            raise ValueError("Download/state path has linked file identity")
    if not path.resolve().is_relative_to(ROOT):
        raise ValueError("Download/state path escapes workspace")


def main():
    if digest(LOCK) != LOCK_SHA:
        raise ValueError("Separately reviewed manifest changed; do not infer new approval")
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    if len(lock["models"]) != 1:
        raise ValueError("Only one extra candidate approved")
    model = lock["models"][0]
    if (model["id"], model["repository"], model["revision"], model["license"], model["provider"]) != (MODEL_ID, REPO, REVISION, "apache-2.0", "llama-http"):
        raise ValueError("Extra candidate identity differs")
    if {r["path"] for r in model["files"]} != set(APPROVED_FILES) or len(model["files"]) != 2:
        raise ValueError("Extra artifact allowlist differs")
    spec = importlib.util.spec_from_file_location("s5_extra_download_transport", HERE.parent / "download-models.py")
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    transport.REPORT = ROOT / ".local/s5-pilot/download-extra-state.json"
    transport.ALLOWED_REPOS = set(transport.ALLOWED_REPOS) | {REPO}
    original_report = ROOT / ".local/s5-pilot/download-state.json"
    original_hash = digest(original_report) if original_report.exists() else None
    tasks = []
    for entry in model["files"]:
        filename = entry["path"]
        size, sha = APPROVED_FILES[filename]
        expected_url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{filename}"
        if (entry["bytes"], entry["sha256"], entry["url"]) != (size, sha, expected_url):
            raise ValueError("Extra artifact approved origin/hash/size differs")
        transport.safe_url(entry["url"], origin=True)
        task = {**entry, "relative": MODEL_ID + "/" + filename, "model": MODEL_ID}
        target = transport.DEST / task["relative"]
        safe_owned_path(target)
        safe_owned_path(target.with_name(target.name + ".part"))
        tasks.append(task)
    if sum(t["bytes"] for t in transport.plan()) + sum(t["bytes"] for t in tasks) > 16 * 1024 ** 3:
        raise ValueError("Combined pilot artifact quota exceeds 16GiB")
    safe_owned_path(transport.REPORT)
    safe_owned_path(transport.REPORT.with_suffix(".tmp"))
    transport.DEST.mkdir(parents=True, exist_ok=True)
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        pending = {pool.submit(transport.fetch, task): task for task in tasks}
        while pending:
            done, _ = concurrent.futures.wait(pending, timeout=20, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                task = pending.pop(future)
                try:
                    future.result()
                except Exception as exc:
                    transport.update(task, status="failed", error=type(exc).__name__)
                    errors.append(task["relative"])
            transport.snapshot(tasks)
    if (digest(original_report) if original_report.exists() else None) != original_hash:
        raise ValueError("Original download report changed during extra download; investigate ownership")
    state = json.loads(transport.REPORT.read_text(encoding="utf-8"))
    state.update({"manifestSha256": LOCK_SHA, "originalDownloadReportUnchanged": True, "originalDownloadReportSha256": original_hash, "modelExecuted": False, "scope": "separate fifth experimental model; no original comparison artifact overwritten"})
    tmp = transport.REPORT.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    tmp.replace(transport.REPORT)
    if errors:
        raise RuntimeError("Extra artifacts not admitted: " + ", ".join(errors))


if __name__ == "__main__":
    main()
