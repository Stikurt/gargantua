"""Tactical official pinned OCI download; raw blobs only, no host extraction.

Use only after the bounded host range probe exceeded 1 MB/s. Four bounded range
workers bypass the slow Docker proxy, then every complete compressed blob is
SHA-256 verified. Token/signed URLs stay in memory. Does not stop a Docker pull,
load/run an image, mount production data, or use a Docker socket.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import io
import json
import os
from pathlib import Path
import re
import ssl
import tarfile
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener

REPO = "ggml-org/llama.cpp"
MANIFEST = "sha256:e28ed2eea6752a16e22fabb1d449c7557e0ab2494e5d80552e1b6961f1671086"
ROOT = Path(__file__).resolve().parents[3] / ".local/s5-pilot/runtime-gpu"
CHUNK = 64 * 1024**2
ALLOWED = {"ghcr.io", "pkg-containers.githubusercontent.com"}
MUTEX = threading.Lock()
STATE = {"schemaVersion": 1, "status": "starting", "verifiedChunkBytes": 0,
         "completeChunks": 0, "verifiedBlobBytes": 0, "verifiedBlobs": 0,
         "originalDockerPullTouched": False}


def safe(url):
    p = urlsplit(url)
    if p.scheme != "https" or p.hostname not in ALLOWED or p.port not in (None, 443) or p.username or p.password:
        raise ValueError("unreviewed registry redirect host")


class Redirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe(newurl)
        forwarded = super().redirect_request(req, fp, code, msg, headers, newurl)
        if forwarded and urlsplit(req.full_url).hostname != urlsplit(newurl).hostname:
            forwarded.remove_header("Authorization")
        return forwarded


def opener():
    return build_opener(ProxyHandler({}), Redirects(), HTTPSHandler(context=ssl.create_default_context()))


def token():
    with opener().open(f"https://ghcr.io/token?service=ghcr.io&scope=repository:{REPO}:pull", timeout=20) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError("registry auth metadata limit")
    return json.loads(raw)["token"]


def atomic_state(**fields):
    with MUTEX:
        STATE.update(fields)
        STATE["updatedAtUnix"] = time.time()
        temporary = ROOT / "download-state.tmp"
        temporary.write_text(json.dumps(STATE, indent=2) + "\n", encoding="utf-8")
        temporary.replace(ROOT / "download-state.json")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def valid_digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ValueError("noncanonical descriptor digest")
    return value[7:]


def chunk_path(row, start, end):
    return ROOT / "chunks" / valid_digest(row["digest"]) / f"{start}-{end}.ready"


def fetch_chunk(task):
    row, start, end = task
    target = chunk_path(row, start, end)
    length = end - start + 1
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        raise ValueError("linked download scratch")
    if target.exists() and target.stat().st_size == length:
        return task
    partial = target.with_suffix(".partial")
    for attempt in range(1, 5):
        began = time.monotonic()
        try:
            headers = {"Authorization": "Bearer " + token(), "Range": f"bytes={start}-{end}",
                       "User-Agent": "Gargantua-S5-official-OCI-cache/1", "Accept-Encoding": "identity"}
            url = f"https://ghcr.io/v2/{REPO}/blobs/{row['digest']}"
            with opener().open(Request(url, headers=headers), timeout=30) as response:
                safe(response.geturl())
                expected = f"bytes {start}-{end}/{row['size']}"
                if response.status != 206 or response.headers.get("Content-Range") != expected:
                    raise ValueError("registry ignored exact bounded range")
                with partial.open("wb") as out:
                    received = 0
                    while True:
                        if time.monotonic() - began > 240:
                            raise TimeoutError("bounded chunk deadline")
                        data = response.read(min(1024**2, length - received + 1))
                        if not data:
                            break
                        received += len(data)
                        if received > length:
                            raise ValueError("range exceeds declared bound")
                        out.write(data)
                    if received != length:
                        raise OSError("truncated bounded range")
                    out.flush()
                    os.fsync(out.fileno())
            partial.replace(target)
            with MUTEX:
                STATE["completeChunks"] += 1
                STATE["verifiedChunkBytes"] += length
            atomic_state(status="downloading")
            print(json.dumps({"chunkCompleted": row["digest"][7:19], "rangeStart": start,
                              "bytes": length, "seconds": round(time.monotonic()-began, 3)}), flush=True)
            return task
        except HTTPError as exc:
            if exc.code not in {408, 425, 429, 500, 502, 503, 504} or attempt == 4:
                raise RuntimeError("official registry HTTP transfer refused") from None
            time.sleep(attempt * 2)
        except OSError:
            if attempt == 4:
                raise RuntimeError("official registry bounded range retries exhausted") from None
            time.sleep(attempt * 2)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    probe = json.loads((ROOT / "range-probe-4m.json").read_text())
    if (probe.get("manifest") != MANIFEST or probe.get("bytesPerSecond", 0) <= 1_000_000
            or probe.get("deliveredHost") != "pkg-containers.githubusercontent.com"):
        raise ValueError("bounded official range proof above 1 MB/s required")
    manifest_bytes = (ROOT / "manifest.json").read_bytes()
    if len(manifest_bytes) > 1024**2 or "sha256:" + hashlib.sha256(manifest_bytes).hexdigest() != MANIFEST:
        raise ValueError("pinned manifest bytes differ")
    manifest = json.loads(manifest_bytes)
    if manifest.get("mediaType") != "application/vnd.oci.image.manifest.v1+json":
        raise ValueError("unexpected upstream image manifest type")
    rows = [manifest["config"], *manifest["layers"]]
    if len(rows) > 32:
        raise ValueError("unexpected descriptor count")
    unique = {}
    for row in rows:
        key = valid_digest(row["digest"])
        if (set(row) != {"mediaType", "digest", "size"} or type(row["size"]) is not int
                or not 0 < row["size"] <= 2200 * 1024**2
                or row["mediaType"] not in {"application/vnd.oci.image.config.v1+json", "application/vnd.oci.image.layer.v1.tar+gzip"}):
            raise ValueError("unexpected/foreign upstream blob descriptor")
        if key in unique and unique[key] != row:
            raise ValueError("conflicting repeated descriptor")
        unique[key] = row
    total = sum(row["size"] for row in unique.values())
    if total > 3 * 1024**3:
        raise ValueError("official image quota exceeds 3 GiB")
    blob_root = ROOT / "layout/blobs/sha256"
    blob_root.mkdir(parents=True, exist_ok=True)
    tasks = []
    for key, row in unique.items():
        target = blob_root / key
        if target.is_symlink():
            raise ValueError("linked blob output")
        if target.exists():
            if target.stat().st_size != row["size"] or digest(target) != key:
                raise ValueError("existing blob identity changed")
            continue
        tasks.extend((row, start, min(start+CHUNK, row["size"])-1) for start in range(0, row["size"], CHUNK))
    atomic_state(status="downloading", manifest=MANIFEST, expectedBytes=total, expectedChunks=len(tasks))
    with ThreadPoolExecutor(max_workers=4) as workers:
        futures = [workers.submit(fetch_chunk, task) for task in tasks]
        for future in as_completed(futures):
            future.result()
    for key, row in unique.items():
        target = blob_root / key
        if not target.exists():
            partial = target.with_suffix(".partial")
            with partial.open("wb") as out:
                checksum, copied = hashlib.sha256(), 0
                for start in range(0, row["size"], CHUNK):
                    end = min(start+CHUNK, row["size"])-1
                    with chunk_path(row, start, end).open("rb") as source:
                        while data := source.read(4 * 1024**2):
                            copied += len(data)
                            if copied > row["size"]:
                                raise ValueError("assembled blob length exceeds bound")
                            checksum.update(data)
                            out.write(data)
                if copied != row["size"] or checksum.hexdigest() != key:
                    raise ValueError("complete official compressed blob SHA-256 differs")
                out.flush()
                os.fsync(out.fileno())
            partial.replace(target)
            for start in range(0, row["size"], CHUNK):
                chunk_path(row, start, min(start+CHUNK, row["size"])-1).unlink()
        with MUTEX:
            STATE["verifiedBlobs"] += 1
            STATE["verifiedBlobBytes"] += row["size"]
        atomic_state(status="verifying-blobs")
    config = json.loads((blob_root / valid_digest(manifest["config"]["digest"])).read_text())
    if config.get("architecture") != "amd64" or config.get("os") != "linux" or config.get("config", {}).get("Entrypoint") != ["/app/llama-server"]:
        raise ValueError("unexpected official runtime architecture or entrypoint")
    (blob_root / valid_digest(MANIFEST)).write_bytes(manifest_bytes)
    descriptor = {"mediaType": manifest["mediaType"], "digest": MANIFEST, "size": len(manifest_bytes),
                  "platform": {"architecture": "amd64", "os": "linux"},
                  "annotations": {"org.opencontainers.image.ref.name": "gargantua-s5-llama-gpu:verified"}}
    layout = ROOT / "layout"
    (layout / "oci-layout").write_text('{"imageLayoutVersion":"1.0.0"}', encoding="utf-8")
    (layout / "index.json").write_text(json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json",
                                                "manifests": [descriptor]}), encoding="utf-8")
    archive_path = ROOT / "llama-cuda-official-amd64.oci.tar"
    atomic_state(status="creating-oci-archive")
    with archive_path.open("wb") as out:
        with tarfile.open(fileobj=out, mode="w") as archive:
            for file in [layout / "oci-layout", layout / "index.json", *sorted(blob_root.iterdir())]:
                if file.is_symlink() or not file.is_file():
                    raise ValueError("unexpected OCI layout entry")
                info = tarfile.TarInfo(file.relative_to(layout).as_posix())
                info.size, info.mode = file.stat().st_size, 0o444
                with file.open("rb") as data:
                    archive.addfile(info, data)
        out.flush()
        os.fsync(out.fileno())
    receipt = {"schemaVersion": 1, "status": "official-pinned-oci-archive-ready-not-loaded",
               "manifest": MANIFEST, "config": manifest["config"], "compressedBlobBytes": total,
               "blobsVerified": len(unique), "archive": str(archive_path.relative_to(ROOT)),
               "archiveBytes": archive_path.stat().st_size, "archiveSha256": digest(archive_path),
               "localAlias": "gargantua-s5-llama-gpu:verified", "originalDockerPullTouched": False,
               "hostLayerExtraction": False, "dockerImageLoaded": False, "modelInferenceRun": False}
    (ROOT / "download-receipt.json").write_text(json.dumps(receipt, indent=2)+"\n", encoding="utf-8")
    atomic_state(status=receipt["status"])
    print(json.dumps(receipt), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Never serialize HTTP/signed URL/auth exception text.
        atomic_state(status="failed", errorType=type(exc).__name__)
        print(json.dumps({"status": "download-failed", "errorType": type(exc).__name__}), flush=True)
        raise SystemExit(1)
