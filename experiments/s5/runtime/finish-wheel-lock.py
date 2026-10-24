"""Download exact resolved wheel data without host pip or host installation.

Pip's existing container resolution supplies package versions and target tags.
Only exact official PyPI artifacts are read. Offline container pip check remains
mandatory; this metadata snapshot alone is not dependency acceptance.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import time
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
MAX_TOTAL = 1024**3


def admitted_url(url):
    value = urlsplit(url)
    if (value.scheme != "https" or value.hostname not in {"pypi.org", "files.pythonhosted.org"}
            or value.username or value.password or value.port not in (None, 443) or value.fragment):
        raise ValueError("URL outside exact upstream PyPI delivery origins")
    return url


class Redirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        admitted_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def opener():
    return build_opener(ProxyHandler({}), Redirects(), HTTPSHandler(context=ssl.create_default_context()))


def request(url):
    return Request(admitted_url(url), headers={"User-Agent": "Gargantua-S5-wheel-lock/1", "Accept-Encoding": "identity"})


def wheel_rank(filename, tags):
    if not filename.endswith(".whl"):
        return None
    parts = filename[:-4].split("-")
    if len(parts) not in (5, 6):
        return None
    matching = [tags.get(f"{python}-{abi}-{platform}") for python in parts[-3].split(".")
                for abi in parts[-2].split(".") for platform in parts[-1].split(".")]
    matching = [rank for rank in matching if rank is not None]
    return min(matching) if matching else None


def metadata_row(row, tags):
    name, version = row["name"], row["version"]
    if not re.fullmatch(r"[-a-zA-Z0-9_.]+", name) or not re.fullmatch(r"[-a-zA-Z0-9_.+]+", version):
        raise ValueError("invalid resolved package identity")
    with opener().open(request(f"https://pypi.org/pypi/{name}/{version}/json"), timeout=45) as response:
        raw = response.read(8 * 1024**2 + 1)
    if len(raw) > 8 * 1024**2:
        raise ValueError("release metadata too large")
    release = json.loads(raw)
    candidates = []
    for entry in release["urls"]:
        rank = wheel_rank(entry["filename"], tags)
        if rank is not None and not entry.get("yanked"):
            candidates.append((rank, entry["filename"], entry))
    if not candidates:
        raise ValueError("no exact compatible binary wheel: " + name)
    entry = min(candidates, key=lambda row: (row[0], row[1]))[2]
    if not (0 < entry["size"] < 1024**3) or not re.fullmatch(r"[0-9a-f]{64}", entry["digests"]["sha256"]):
        raise ValueError("invalid upstream binary identity")
    if urlsplit(entry["url"]).hostname != "files.pythonhosted.org":
        raise ValueError("unexpected PyPI wheel origin")
    return {"name": name, "version": version, "filename": entry["filename"], "bytes": entry["size"],
            "sha256": entry["digests"]["sha256"], "url": admitted_url(entry["url"])}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(row):
    target = ROOT / "wheels" / row["filename"]
    if target.exists():
        if target.stat().st_size != row["bytes"] or digest(target) != row["sha256"]:
            raise ValueError("previous wheel changed: " + row["filename"])
        return row
    partial = target.with_suffix(".whl.part")
    for attempt in range(1, 5):
        try:
            with opener().open(request(row["url"]), timeout=60) as response, partial.open("wb") as out:
                admitted_url(response.geturl())
                received = 0
                while True:
                    chunk = response.read(min(1024**2, row["bytes"] - received + 1))
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > row["bytes"]:
                        raise ValueError("wheel exceeds declared size")
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            if received != row["bytes"] or digest(partial) != row["sha256"]:
                raise ValueError("wheel size or upstream digest differs")
            partial.replace(target)
            print(json.dumps({"wheel": row["name"], "status": "hash-verified", "bytes": received}), flush=True)
            return row
        except OSError:
            if attempt == 4:
                raise
            time.sleep(attempt)


def main():
    snapshot = json.loads((ROOT / "resolved-metadata.json").read_text())
    names = [row["name"].lower().replace("_", "-") for row in snapshot["packages"]]
    if len(set(names)) != len(names) or not 7 <= len(names) <= 100:
        raise ValueError("ambiguous or incomplete pip resolution metadata")
    tags = {tag: index for index, tag in enumerate(snapshot["tags"])}
    (ROOT / "wheels").mkdir(exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as workers:
        rows = list(workers.map(lambda row: metadata_row(row, tags), snapshot["packages"]))
    torch_name = "torch-2.14.1+cpu-cp312-cp312-manylinux_2_28_x86_64.whl"
    torch_file = ROOT / "prefetched" / torch_name
    torch_hash = "5a6363570c753812540a05eb82380e329469cbe668643e88111414c12627711f"
    if torch_file.stat().st_size != 196253677 or digest(torch_file) != torch_hash:
        raise ValueError("preserved official PyTorch wheel differs")
    shutil.copyfile(torch_file, ROOT / "wheels" / torch_name)
    rows.append({"name": "torch", "version": "2.14.1+cpu", "filename": torch_name,
                 "bytes": 196253677, "sha256": torch_hash,
                 "url": "https://download-r2.pytorch.org/whl/cpu/torch-2.14.1%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl"})
    if sum(row["bytes"] for row in rows) > MAX_TOTAL:
        raise ValueError("wheel byte quota exceeded")
    with ThreadPoolExecutor(max_workers=4) as workers:
        rows = list(workers.map(download, rows))
    rows.sort(key=lambda row: row["name"].lower())
    lock = "\n".join(f'{row["name"]}=={row["version"]} --hash=sha256:{row["sha256"]}' for row in rows) + "\n"
    (ROOT / "requirements.lock").write_text(lock, encoding="utf-8")
    report = {"schemaVersion": 1,
              "baseImage": "python@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70",
              "pythonTarget": "cp312-linux-x86_64", "onlyBinary": True,
              "resolution": "pip container dependency metadata snapshot; target-wheel tags from that exact Python interpreter; offline pip check required",
              "resolutionMetadataSha256": digest(ROOT / "resolved-metadata.json"),
              "artifactIdentity": "exact PyPI release JSON SHA-256; torch separately verified against official CPU simple-index SHA-256",
              "artifacts": rows}
    (ROOT / "wheel-lock.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "locked", "wheels": len(rows), "bytes": sum(row["bytes"] for row in rows)}), flush=True)


if __name__ == "__main__":
    main()
