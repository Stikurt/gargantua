"""Fetch only the reviewed S5 manifest artifacts; never load model code.

Download staging is quarantine, not a malware clearance. SHA256 establishes
artifact identity, not absence of vulnerabilities. Inference is offline in a
separate restricted container. No arbitrary source URL or pickle is admitted.
"""
from __future__ import annotations
import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / ".local/s5-pilot/downloads"
REPORT = ROOT / ".local/s5-pilot/download-state.json"
ALLOWED_REPOS = {"Helsinki-NLP/opus-mt-en-ru", "facebook/m2m100_418M",
                 "Qwen/Qwen3-1.7B-GGUF", "Qwen/Qwen3-4B-GGUF", "facebook/mms-tts-rus"}
MUTEX = threading.Lock()
STATES = {}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""): h.update(chunk)
    return h.hexdigest()


def safe_url(url, origin=False):
    p = urllib.parse.urlsplit(url)
    if p.scheme != "https" or p.username or p.password or p.port not in (None, 443):
        raise ValueError("Only credential-free HTTPS is admitted")
    host = (p.hostname or "").lower()
    if origin:
        if host == "huggingface.co":
            match = re.fullmatch(r"/([^/]+/[^/]+)/resolve/([0-9a-f]{40})/(.+)", p.path)
            if not match or match[1] not in ALLOWED_REPOS: raise ValueError("Unpinned model origin")
        elif host == "github.com":
            if not re.fullmatch(r"/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-(denis-medium(?:-int8)?|ruslan-medium)\.tar\.bz2", p.path):
                raise ValueError("Unknown release artifact")
        else: raise ValueError("Unknown origin")
    elif not (host in {"huggingface.co", "github.com", "release-assets.githubusercontent.com"}
              or host.endswith(".hf.co") or host.endswith(".huggingface.co")):
        raise ValueError("Redirect outside publisher delivery domains")
    return url


class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def plan():
    tasks = []
    for family in ("translation", "tts"):
        lock = json.loads((ROOT / f"experiments/s5/{family}/models.lock.json").read_text(encoding="utf-8"))
        for model in lock["models"]:
            files = [model["archive"]] if "archive" in model else model["files"]
            for f in files:
                relative = (model["id"] + "/" + f["path"]) if family == "translation" else (f["path"] if "archive" in model else model["directory"] + "/" + f["path"])
                path = PurePosixPath(relative)
                if path.is_absolute() or ".." in path.parts or "\\" in relative or ":" in relative:
                    raise ValueError("Invalid artifact path")
                if not re.fullmatch(r"[0-9a-f]{64}", f["sha256"]) or type(f["bytes"]) is not int or not 0 < f["bytes"] < 3 * 1024**3:
                    raise ValueError("Invalid artifact identity")
                if path.suffix.lower() in {".bin", ".pt", ".pth", ".pkl", ".py", ".dll", ".exe", ".so"}:
                    raise ValueError("Executable/pickle format forbidden")
                safe_url(f["url"], origin=True)
                tasks.append({**f, "relative": relative, "model": model["id"]})
    if len({t["relative"].casefold() for t in tasks}) != len(tasks): raise ValueError("Case collision")
    if sum(t["bytes"] for t in tasks) > 16 * 1024**3: raise ValueError("Pilot quota exceeded")
    return tasks


def update(task, **values):
    with MUTEX:
        STATES.setdefault(task["relative"], {"bytesExpected": task["bytes"], "sha256": task["sha256"]}).update(values)


def fetch(task):
    target = DEST.joinpath(*PurePosixPath(task["relative"]).parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if target.is_symlink() or target.stat().st_size != task["bytes"] or digest(target) != task["sha256"]:
            raise ValueError("Previously admitted artifact changed: " + task["relative"])
        update(task, status="verified", bytes=task["bytes"], reused=True)
        return
    partial = target.with_name(target.name + ".part")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirects(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    for attempt in range(1, 5):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            if offset > task["bytes"]: raise ValueError("Partial artifact exceeds bound")
            if offset < task["bytes"]:
                headers = {"User-Agent": "GargantuaPersonalLibrary-LocalPilot/1.0", "Accept-Encoding": "identity"}
                if offset: headers["Range"] = f"bytes={offset}-"
                # Avoid stale signed CDN redirects cached by intermediary proxies.
                url = task["url"] + "?download=true&pilot=" + str(int(time.time()))
                with opener.open(urllib.request.Request(url, headers=headers), timeout=60) as response:
                    safe_url(response.geturl())
                    if offset and response.status != 206: offset = 0
                    if response.status == 206:
                        cr = response.headers.get("Content-Range", "")
                        if not cr.startswith(f"bytes {offset}-") or not cr.endswith("/" + str(task["bytes"])):
                            raise ValueError("Invalid range identity")
                    update(task, status="downloading", bytes=offset, attempt=attempt)
                    with partial.open("ab" if offset else "wb") as out:
                        while True:
                            chunk = response.read(min(4 * 1024 * 1024, task["bytes"] - offset + 1))
                            if not chunk: break
                            offset += len(chunk)
                            if offset > task["bytes"]: raise ValueError("Artifact exceeds declared size")
                            out.write(chunk)
                            update(task, bytes=offset)
                        out.flush()
                        os.fsync(out.fileno())
            update(task, status="hashing")
            if partial.stat().st_size != task["bytes"] or digest(partial) != task["sha256"]:
                raise ValueError("Artifact hash or size mismatch")
            partial.replace(target)
            update(task, status="verified", bytes=task["bytes"])
            return
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # Do not persist signed CDN URLs or raw HTTP exception bodies.
            update(task, status="retry", error=type(exc).__name__, attempt=attempt)
            if attempt == 4: raise RuntimeError("Download retries exhausted: " + task["relative"]) from None
            time.sleep(attempt * 2)
    raise RuntimeError("Download did not complete")


def snapshot(tasks):
    with MUTEX:
        state = {"schemaVersion": 1, "updatedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                 "status": "verified" if len(STATES) == len(tasks) and all(v.get("status") == "verified" for v in STATES.values()) else "in-progress",
                 "malwareClaim": "Not scanned. Origin, size and SHA256 only; format checks and offline sandbox required before loading.",
                 "totalBytes": sum(t["bytes"] for t in tasks), "artifacts": dict(STATES)}
        tmp = REPORT.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        tmp.replace(REPORT)
        print(json.dumps({"verified": sum(v.get("status") == "verified" for v in STATES.values()), "total": len(tasks),
                          "receivedMiB": round(sum(v.get("bytes", 0) for v in STATES.values()) / 1024**2),
                          "expectedMiB": round(state["totalBytes"] / 1024**2)}), flush=True)


def main():
    tasks = plan()
    DEST.mkdir(parents=True, exist_ok=True)
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        pending = {pool.submit(fetch, task): task for task in tasks}
        while pending:
            done, _ = concurrent.futures.wait(pending, timeout=20, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                task = pending.pop(future)
                try: future.result()
                except Exception as exc:
                    update(task, status="failed", error=type(exc).__name__)
                    errors.append(task["relative"])
            snapshot(tasks)
    if errors: raise RuntimeError("Failed artifact identities: " + ", ".join(errors))


if __name__ == "__main__": main()
