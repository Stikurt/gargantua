"""Explicit experimental bootstrap: pinned downloads, offline staging, local image binding.

No inference, host pip installation, credentials, arbitrary URLs or private server address.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {"files.pythonhosted.org", "download.pytorch.org", "download-r2.pytorch.org", "github.com", "release-assets.githubusercontent.com", "huggingface.co"}


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Credential-free HTTPS required")
    if host not in ALLOWED and not host.endswith(".hf.co") and not host.endswith(".huggingface.co"):
        raise ValueError("Unadmitted artifact origin/redirect")


class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(spec, target):
    safe_url(spec["url"])
    if not re.fullmatch(r"[a-f0-9]{64}", spec["sha256"]) or not isinstance(spec["bytes"], int):
        raise ValueError("Invalid pinned artifact")
    if target.is_symlink():
        raise ValueError("Linked artifact target")
    if target.exists():
        if target.stat().st_size != spec["bytes"] or sha(target) != spec["sha256"]:
            raise ValueError("Existing artifact differs; inspect it before retrying")
        print("Verified:", target.name)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".partial")
    if temporary.exists():
        raise ValueError("Partial artifact exists; inspect/remove that one partial file before retrying")
    total = 0
    digest = hashlib.sha256()
    try:
        request = urllib.request.Request(spec["url"], headers={"User-Agent": "Gargantua-experimental-bootstrap/1"})
        with urllib.request.build_opener(Redirects()).open(request, timeout=120) as source, temporary.open("xb") as output:
            safe_url(source.url)
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                if total > spec["bytes"]:
                    raise ValueError("Artifact exceeds pinned byte count")
                digest.update(chunk)
                output.write(chunk)
        if total != spec["bytes"] or digest.hexdigest() != spec["sha256"]:
            raise ValueError("Artifact size/SHA256 mismatch")
        temporary.replace(target)
    except BaseException:
        # Keep a partial file for inspection; never publish it as a complete artifact.
        raise
    print("Downloaded and verified:", target.name)


def selected_voice():
    rows = read(ROOT / "experiments/s5/tts/models.lock.json")["models"]
    return next(row for row in rows if row["id"] == "piper-denis-fp32")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["wheels", "voice", "stage", "translation-model", "bind-runtime"])
    parser.add_argument("--image", default="gargantua-s5-cpu:pilot")
    args = parser.parse_args()
    if args.action == "wheels":
        lock = read(ROOT / "experiments/s5/runtime/wheel-lock.json")
        for spec in lock["artifacts"]:
            if Path(spec["filename"]).name != spec["filename"] or not spec["filename"].endswith(".whl"):
                raise ValueError("Noncanonical wheel filename")
            download(spec, ROOT / "experiments/s5/runtime/wheels" / spec["filename"])
    elif args.action == "voice":
        spec = selected_voice()["archive"]
        download(spec, ROOT / ".local/audio-downloads" / spec["path"])
    elif args.action == "translation-model":
        lock = read(ROOT / "inference/profiles.lock.json")["translation"]
        for spec in lock["files"]:
            if Path(spec["path"]).name != spec["path"]:
                raise ValueError("Noncanonical selected model path")
            download({**spec, "url": "https://huggingface.co/" + lock["repository"] + "/resolve/" + lock["revision"] + "/" + spec["path"]}, ROOT / lock["modelRoot"] / spec["path"])
    elif args.action == "stage":
        # Run this action only inside the documented offline, constrained CPU image.
        sys.path.insert(0, str(ROOT / "experiments/s5/tts"))
        from safety import extract_bounded
        from formats import inspect_model
        voice = selected_voice()
        spec = voice["archive"]
        archive = ROOT / ".local/audio-downloads" / spec["path"]
        if archive.is_symlink() or archive.stat().st_size != spec["bytes"] or sha(archive) != spec["sha256"]:
            raise ValueError("Selected voice archive mismatch")
        lock = read(ROOT / "inference/profiles.lock.json")["tts"]
        target = ROOT / lock["modelRoot"]
        if not target.exists():
            extract_bounded(archive, target)
            inspect_model(target / lock["modelDirectory"] / lock["modelFilename"], canonicalize_legacy_metadata=True)
        expected = {row["path"]: row for row in lock["files"]}
        actual = {str(path.relative_to(target)).replace("\\", "/"): path for path in target.rglob("*") if path.is_file()}
        if actual.keys() != expected.keys():
            raise ValueError("Staged voice inventory differs from reviewed profile")
        for relative, path in actual.items():
            spec = expected[relative]
            if path.is_symlink() or path.stat().st_size != spec["bytes"] or sha(path) != spec["sha256"]:
                raise ValueError("Staged voice differs from reviewed profile: " + relative)
        print(json.dumps({"status": "selected-profile-file-hashes-verified", "files": len(expected), "antivirus": "NOT_FULLY_SCANNED", "listening": "NOT_LISTENED"}))
    elif args.action == "bind-runtime":
        result = subprocess.run(["docker", "image", "inspect", args.image, "--format", "{{.Id}}"], check=True, capture_output=True, text=True)
        image = result.stdout.strip()
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
            raise ValueError("Immutable local runtime image ID required")
        path = ROOT / "inference/profiles.lock.json"
        lock = read(path)
        lock["tts"]["image"] = image
        path.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("Bound selected TTS to", image, "; explicitly run freeze_profiles.py then --check before building the application.")


if __name__ == "__main__":
    main()
