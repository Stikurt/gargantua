"""Bounded anonymous official GHCR range-speed probe; no full layer download.

Ephemeral anonymous registry token and signed CDN URLs stay in memory and are
never printed or persisted. Only range metadata, public digest and host are kept.
"""
import hashlib
import argparse
import json
from pathlib import Path
import ssl
import time
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener

REPO = "ggml-org/llama.cpp"
MANIFEST = "sha256:e28ed2eea6752a16e22fabb1d449c7557e0ab2494e5d80552e1b6961f1671086"
LAYER = "sha256:cbb9175a9bc5f6553f8c0c5025ea9521898b8a3956ee24798dc35c24c6185053"
ALLOWED = {"ghcr.io", "pkg-containers.githubusercontent.com"}
DEST = Path(__file__).resolve().parents[3] / ".local/s5-pilot/runtime-gpu"


def safe(url):
    p = urlsplit(url)
    if p.scheme != "https" or p.hostname not in ALLOWED or p.port not in (None, 443) or p.username or p.password:
        raise ValueError("unreviewed registry redirect host")
    return p.hostname


class Redirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe(newurl)
        forwarded = super().redirect_request(req, fp, code, msg, headers, newurl)
        if forwarded and urlsplit(req.full_url).hostname != urlsplit(newurl).hostname:
            forwarded.remove_header("Authorization")
        return forwarded


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--range-mib", type=int, choices=(1, 4), default=1)
    args = parser.parse_args()
    http = build_opener(ProxyHandler({}), Redirects(), HTTPSHandler(context=ssl.create_default_context()))
    request = Request(f"https://ghcr.io/token?service=ghcr.io&scope=repository:{REPO}:pull",
                      headers={"User-Agent": "Gargantua-S5-official-registry-probe/1"})
    with http.open(request, timeout=20) as response:
        data = response.read(65537)
    if len(data) > 65536:
        raise ValueError("registry auth response exceeds limit")
    token = json.loads(data)["token"]
    headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.oci.image.manifest.v1+json",
               "User-Agent": "Gargantua-S5-official-registry-probe/1", "Accept-Encoding": "identity"}
    with http.open(Request(f"https://ghcr.io/v2/{REPO}/manifests/{MANIFEST}", headers=headers), timeout=20) as response:
        manifest_bytes = response.read(1024 * 1024 + 1)
    if len(manifest_bytes) > 1024 * 1024 or "sha256:" + hashlib.sha256(manifest_bytes).hexdigest() != MANIFEST:
        raise ValueError("official manifest digest differs")
    manifest = json.loads(manifest_bytes)
    layer = next(item for item in manifest["layers"] if item["digest"] == LAYER)
    # At most four MiB. Refuse ignored Range before reading a full body.
    bounded = args.range_mib * 1024 * 1024
    headers["Range"] = f"bytes=0-{bounded-1}"
    start = time.monotonic()
    with http.open(Request(f"https://ghcr.io/v2/{REPO}/blobs/{LAYER}", headers=headers), timeout=20) as response:
        body_start = time.monotonic()
        host = safe(response.geturl())
        status = response.status
        content_range = response.headers.get("Content-Range", "")
        if status != 206 or content_range != f"bytes 0-{bounded-1}/{layer['size']}":
            raise ValueError("registry did not honor exact bounded range")
        data = response.read(bounded + 1)
    body_elapsed = time.monotonic() - body_start
    elapsed = time.monotonic() - start
    if len(data) != bounded:
        raise ValueError("range length differs")
    result = {"schemaVersion": 1, "kind": "bounded-range-speed-probe-not-layer-admission",
              "manifest": MANIFEST, "layer": LAYER, "layerBytes": layer["size"],
              "rangeBytes": len(data), "elapsedSecondsIncludingHeaders": elapsed,
              "bytesPerSecond": len(data)/elapsed, "deliveredHost": host,
              "bodySeconds": body_elapsed, "bodyBytesPerSecond": len(data)/body_elapsed,
              "partialSha256": hashlib.sha256(data).hexdigest(),
              "fullLayerHashVerified": False, "fullLayerDownloaded": False,
              "originalDockerPullTouched": False}
    DEST.mkdir(parents=True, exist_ok=True)
    (DEST / f"range-probe-{args.range_mib}m.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    (DEST / "manifest.json").write_bytes(manifest_bytes)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Network exceptions can include a signed URL. Report class only.
        print(json.dumps({"status": "probe-failed", "errorType": type(exc).__name__}))
        raise SystemExit(1)
