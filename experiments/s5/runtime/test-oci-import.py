"""Small real Docker OCI import proof with one inert text file; never runs image."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[3] / ".local/s5-pilot/runtime-gpu/oci-proof"
TAG = "gargantua-s5-oci-import-proof:fixture"


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


def description(data, media):
    return {"mediaType": media, "digest": "sha256:" + hashlib.sha256(data).hexdigest(), "size": len(data)}


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    text = b"Gargantua S5 inert OCI import fixture. No executable or model.\n"
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as layer:
        member = tarfile.TarInfo("fixture.txt")
        member.size, member.mode = len(text), 0o444
        layer.addfile(member, io.BytesIO(text))
    plain = raw.getvalue()
    packed = gzip.compress(plain, mtime=0)
    layer = description(packed, "application/vnd.oci.image.layer.v1.tar+gzip")
    config_bytes = encoded({"architecture": "amd64", "os": "linux", "config": {
        "Cmd": ["/no-executable-present-this-image-is-never-run"],
        "Labels": {"gargantua.s5.fixture": "oci-import-data-only"}},
        "rootfs": {"type": "layers", "diff_ids": ["sha256:" + hashlib.sha256(plain).hexdigest()]}})
    config = description(config_bytes, "application/vnd.oci.image.config.v1+json")
    manifest_bytes = encoded({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                              "config": config, "layers": [layer]})
    manifest = description(manifest_bytes, "application/vnd.oci.image.manifest.v1+json")
    manifest["annotations"] = {"org.opencontainers.image.ref.name": TAG}
    index = encoded({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [manifest]})
    files = {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}', "index.json": index,
             "blobs/sha256/" + hashlib.sha256(packed).hexdigest(): packed,
             "blobs/sha256/" + hashlib.sha256(config_bytes).hexdigest(): config_bytes,
             "blobs/sha256/" + hashlib.sha256(manifest_bytes).hexdigest(): manifest_bytes}
    archive = ROOT / "inert-fixture.oci.tar"
    with tarfile.open(archive, "w") as out:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode = len(data), 0o444
            out.addfile(entry, io.BytesIO(data))
    result = {"schemaVersion": 1, "fixture": "one inert text layer + gzip OCI manifests",
              "archiveBytes": archive.stat().st_size, "imageExecuted": False, "modelLoaded": False,
              "productionMounted": False}
    try:
        loaded = subprocess.run(["docker", "load", "--input", str(archive)], capture_output=True, text=True, timeout=40)
        result["loadExitCode"] = loaded.returncode
        result["loadStdout"] = loaded.stdout.strip()
        if loaded.returncode:
            result["error"] = "Docker rejected inert OCI format"
            raise RuntimeError("OCI import unsupported")
        inspected = subprocess.run(["docker", "image", "inspect", TAG], capture_output=True, text=True, check=True, timeout=15)
        image = json.loads(inspected.stdout)[0]
        if image["Config"]["Labels"].get("gargantua.s5.fixture") != "oci-import-data-only" or len(image["RootFS"]["Layers"]) != 1:
            raise ValueError("loaded fixture identity differs")
        result.update(status="passed", imageId=image["Id"], gzipOciLayerAccepted=True)
    finally:
        removed = subprocess.run(["docker", "image", "rm", TAG], capture_output=True, text=True, timeout=20)
        result["fixtureTagCleanupExitCode"] = removed.returncode
        (ROOT / "report.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
