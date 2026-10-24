"""Resolve binary-only CPU pilot wheels in a disposable network-enabled container.

No package is installed here and no host interpreter/site-packages is modified.
Every wheel is bound to the upstream simple-index/PyPI digest and an offline
requirements lock; the following Docker build installs from that inventory only.
"""
import hashlib
from html.parser import HTMLParser
from email.parser import Parser
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import parse_qs, unquote, urljoin, urlsplit
from urllib.request import Request, urlopen
import zipfile

ROOT = Path("/out")
WHEELS = ROOT / "wheels"
TORCH_VERSION = "2.14.1+cpu"
TORCH_FILENAME = f"torch-{TORCH_VERSION}-cp312-cp312-manylinux_2_28_x86_64.whl"
TORCH_INDEX = "https://download.pytorch.org/whl/cpu/torch/"


def fetch(url, max_bytes=8 * 1024 * 1024):
    request = Request(url, headers={"User-Agent": "Gargantua-S5-runtime-lock/1"})
    with urlopen(request, timeout=60) as response:
        data = response.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("upstream metadata exceeds limit")
        return data


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.hrefs.extend(value for key, value in attrs if key == "href" and value)


def main():
    WHEELS.mkdir(exist_ok=True)
    parser = Links()
    parser.feed(fetch(TORCH_INDEX).decode("utf-8"))
    matches = []
    for href in parser.hrefs:
        url = urljoin(TORCH_INDEX, href)
        parsed = urlsplit(url)
        if unquote(parsed.path.rsplit("/", 1)[-1]) == TORCH_FILENAME:
            if parsed.scheme != "https" or parsed.hostname not in {"download.pytorch.org", "download-r2.pytorch.org"}:
                raise ValueError("unexpected PyTorch wheel host")
            digest = parse_qs(parsed.fragment).get("sha256", [])
            if len(digest) != 1 or not re.fullmatch(r"[0-9a-f]{64}", digest[0]):
                raise ValueError("PyTorch CPU index does not pin SHA-256")
            matches.append((url, digest[0]))
    if len(matches) != 1:
        raise ValueError(f"expected one exact CPU torch wheel, got {len(matches)}")
    torch_url, torch_digest = matches[0]
    prefetched = ROOT / "prefetched" / TORCH_FILENAME
    torch_requirement = torch_url
    if prefetched.exists():
        with prefetched.open("rb") as stream:
            admitted = hashlib.file_digest(stream, "sha256").hexdigest()
        if admitted != torch_digest:
            raise ValueError("prefetched official CPU torch wheel digest differs")
        torch_requirement = str(prefetched)
        print("Reusing completed CPU torch wheel after matching official index SHA-256.", flush=True)
    command = [sys.executable, "-m", "pip", "download", "--disable-pip-version-check",
               "--only-binary=:all:", "--no-cache-dir", "--dest", str(WHEELS),
               "--index-url", "https://pypi.org/simple", "-r", str(ROOT / "requirements.in"), torch_requirement]
    print("Resolving binary-only dependencies, exact official CPU torch wheel.", flush=True)
    subprocess.run(command, check=True, timeout=900)
    rows, locked = [], []
    for wheel in sorted(WHEELS.iterdir()):
        if wheel.suffix != ".whl" or wheel.stat().st_size > 1024 * 1024**2:
            raise ValueError("unexpected wheel file/type/size")
        with zipfile.ZipFile(wheel) as package:
            names = [entry for entry in package.infolist() if entry.filename.endswith(".dist-info/METADATA")]
            if len(names) != 1 or names[0].file_size > 4 * 1024**2:
                raise ValueError("invalid wheel metadata")
            metadata = package.read(names[0]).decode("utf-8")
        headers = Parser().parsestr(metadata)
        package_name, version = headers.get("Name", ""), headers.get("Version", "")
        if not re.fullmatch(r"[-a-zA-Z0-9_.]+", package_name) or not re.fullmatch(r"[-a-zA-Z0-9_.+]+", version):
            raise ValueError("invalid wheel package identity")
        name = package_name
        with wheel.open("rb") as contents:
            digest = hashlib.file_digest(contents, "sha256").hexdigest()
        if name.lower() == "torch":
            expected, origin = torch_digest, torch_url.split("#", 1)[0]
            if version != TORCH_VERSION:
                raise ValueError("resolved wrong torch variant")
        else:
            release = json.loads(fetch(f"https://pypi.org/pypi/{name}/{version}/json"))
            exact = [entry for entry in release["urls"] if entry["filename"] == wheel.name]
            if len(exact) != 1:
                raise ValueError("wheel missing from exact PyPI release")
            expected, origin = exact[0]["digests"]["sha256"], exact[0]["url"]
            if urlsplit(origin).hostname != "files.pythonhosted.org":
                raise ValueError("unexpected PyPI artifact host")
        if digest != expected:
            raise ValueError(f"wheel upstream SHA mismatch: {name}")
        rows.append({"name": name, "version": version, "filename": wheel.name,
                     "bytes": wheel.stat().st_size, "sha256": digest, "url": origin})
        locked.append(f"{name}=={version} --hash=sha256:{digest}")
    if not rows or sum(row["bytes"] for row in rows) > 2 * 1024**3:
        raise ValueError("wheel inventory missing or too large")
    (ROOT / "requirements.lock").write_text("\n".join(locked) + "\n", encoding="utf-8")
    (ROOT / "wheel-lock.json").write_text(json.dumps({"schemaVersion": 1,
        "baseImage": "python@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70",
        "pythonTarget": "cp312-linux-x86_64", "torchOfficialIndex": TORCH_INDEX,
        "onlyBinary": True, "artifacts": rows}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "locked", "wheels": len(rows), "bytes": sum(row["bytes"] for row in rows)}), flush=True)


if __name__ == "__main__":
    main()
