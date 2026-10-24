"""S5 pilot model admission helpers; no downloader and no inference execution.

Only the explicitly selected model artifacts are admitted. Tar helpers must be
called inside the caller's bounded, network-denied OS sandbox, never as a claim
that Python path checks alone are a sandbox. This module uses the standard
library and does not import a model repository or deserialize model objects.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
from urllib.parse import unquote, urlsplit


class PolicyError(ValueError):
    """A model/package fails this pilot's narrow admission policy."""


DEFAULT_LIMITS = {
    "maxArchiveBytes": 1024 * 1024 * 1024,
    "maxMembers": 10000,
    "maxFileBytes": 1024 * 1024 * 1024,
    "maxTotalBytes": 3 * 1024 * 1024 * 1024,
    "maxExpansionRatio": 200,
    "maxPathLength": 240,
    "maxDepth": 12,
}
_SHA = re.compile(r"^[0-9a-f]{64}$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,149}$")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
_RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)
_BANNED = {
    ".bin", ".pkl", ".pickle", ".pt", ".pth", ".ckpt", ".joblib",
    ".py", ".pyc", ".pyo", ".sh", ".bash", ".ps1", ".cmd", ".bat",
    ".exe", ".dll", ".so", ".dylib", ".com", ".jar", ".js", ".mjs",
    ".html", ".htm", ".svg", ".lnk", ".url", ".zip", ".7z", ".rar",
}
_KINDS = {"weights", "tokenizer", "config", "license", "archive", "resource"}


def _require(condition, reason):
    if not condition:
        raise PolicyError(reason)


def _positive_int(value, name):
    _require(type(value) is int and value > 0, f"{name}: positive integer required")
    return value


def _limits(overrides=None):
    limits = dict(DEFAULT_LIMITS)
    if overrides is not None:
        _require(isinstance(overrides, dict), "limits must be an object")
        _require(not (set(overrides) - set(limits)), "unknown archive limit")
        limits.update(overrides)
    for name, value in limits.items():
        _positive_int(value, name)
    return limits


def safe_relative_path(value, *, limits=None, allow_directory=False):
    policy = _limits(limits)
    _require(isinstance(value, str) and value, "empty or non-string path")
    if allow_directory and value.endswith("/"):
        value = value[:-1]
    _require(len(value) <= policy["maxPathLength"], "path too long")
    _require("\\" not in value and ":" not in value and "%" not in value,
             "noncanonical path separator, drive, ADS or encoding")
    _require(not value.startswith("/") and "//" not in value, "absolute or empty path component")
    parts = value.split("/")
    _require(len(parts) <= policy["maxDepth"], "path depth exceeds limit")
    for index, part in enumerate(parts):
        # Official espeak data uses the inert variant directory "voices/!v".
        # Admit only this literal position, never arbitrary shell punctuation.
        espeak_variant = (part == "!v" and index >= 2
                          and parts[index - 2:index] == ["espeak-ng-data", "voices"])
        _require(part not in {"", ".", ".."} and (bool(_COMPONENT.fullmatch(part)) or espeak_variant),
                 "invalid path component")
        _require(not part.endswith((".", " ")) and not _RESERVED.match(part),
                 "Windows-ambiguous or reserved path")
    _require(str(PurePosixPath(value)) == value, "noncanonical path")
    return value


def _https_url(value):
    _require(isinstance(value, str) and value and len(value) <= 4096, "invalid URL")
    _require(not any(ord(c) < 33 or ord(c) > 126 for c in value), "URL must be canonical ASCII")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise PolicyError("invalid URL authority") from exc
    _require(parsed.scheme == "https" and parsed.hostname and parsed.netloc == parsed.hostname,
             "HTTPS canonical hostname without credentials or explicit port required")
    _require(port is None and not parsed.fragment and not parsed.query, "URL query/fragment/port forbidden")
    _require("%" not in parsed.path and "\\" not in parsed.path and "//" not in parsed.path,
             "encoded or noncanonical URL path")
    _require(unquote(parsed.path) == parsed.path, "encoded URL path forbidden")
    return parsed


def _artifact_suffix_allowed(path, kind):
    suffix = PurePosixPath(path).suffix.lower()
    _require(suffix not in _BANNED, "executable, pickle or unsupported archive/model format")
    if kind == "weights":
        _require(suffix in {".safetensors", ".gguf", ".onnx"}, "weights need safetensors/GGUF/ONNX")
    elif kind == "tokenizer":
        _require(suffix in {".json", ".txt", ".model", ".vocab", ".spm", ".tiktoken"},
                 "unsupported tokenizer file")
    elif kind == "config":
        _require(suffix in {".json", ".txt"}, "only data-only JSON/text config admitted")
    elif kind == "license":
        _require(suffix in {"", ".md", ".txt"}, "invalid license document type")
    elif kind == "archive":
        _require(path.lower().endswith(".tar.bz2"), "only selected official tar.bz2 archives admitted")
    else:
        _require(suffix in {".data", ".json", ".txt", ".wav", ".model", ".onnx"},
                 "unsupported data resource")


def validate_artifact(artifact, *, expected_revision=None):
    """Validate one manifest entry without accessing network/filesystem.

    `url` is the pinned origin URL, not a redirect CDN with expiring credentials.
    Downloader must separately enforce public HTTPS redirect destinations, byte
    limits, final digest and then offline inference. Tar archives are restricted
    to the selected official sherpa-onnx release origin plus exact file digest.
    """
    _require(isinstance(artifact, dict), "artifact must be an object")
    required = {"url", "size", "sha256", "path", "kind"}
    _require(required <= set(artifact), "missing required artifact field")
    _require(not (set(artifact) - (required | {"license", "source"})), "unknown artifact field")
    path = safe_relative_path(artifact["path"])
    _positive_int(artifact["size"], "artifact size")
    _require(artifact["size"] <= 8 * 1024**3, "artifact exceeds 8 GiB pilot cap")
    _require(isinstance(artifact["sha256"], str) and bool(_SHA.fullmatch(artifact["sha256"])),
             "exact lowercase SHA-256 required")
    kind = artifact["kind"]
    _require(isinstance(kind, str) and kind in _KINDS, "unknown artifact kind")
    _artifact_suffix_allowed(path, kind)
    parsed = _https_url(artifact["url"])
    parts = parsed.path.strip("/").split("/")
    if parsed.hostname == "huggingface.co":
        _require(len(parts) >= 5 and parts[2] == "resolve" and bool(_COMMIT.fullmatch(parts[3])),
                 "HF origin needs owner/repo/resolve/full-commit/file")
        for part in parts[:2]:
            _require(bool(_ID.fullmatch(part)), "invalid HF repository")
        safe_relative_path("/".join(parts[4:]))
        if expected_revision is not None:
            _require(parts[3] == expected_revision, "model/source commit differs from artifact URL")
        _require(kind != "archive", "HF archive admission requires a separate reviewed policy")
    elif parsed.hostname == "github.com":
        _require(kind == "archive" and len(parts) == 6
                 and parts[:4] == ["k2-fsa", "sherpa-onnx", "releases", "download"]
                 and bool(_ID.fullmatch(parts[4])) and parts[5].lower().endswith(".tar.bz2"),
                 "only selected official sherpa-onnx archive origin admitted")
        safe_relative_path(parts[5])
    else:
        raise PolicyError("artifact origin is outside the reviewed model allowlist")
    if "license" in artifact:
        validate_license(artifact["license"])
    if "source" in artifact:
        _require(isinstance(artifact["source"], str) and 0 < len(artifact["source"]) <= 2000,
                 "artifact source annotation must be a bounded string")
    return dict(artifact)


def validate_license(value):
    _require(isinstance(value, dict) and set(value) == {"id", "sourceUrl", "scope"},
             "license needs explicit id/sourceUrl/scope")
    _require(isinstance(value["id"], str) and 0 < len(value["id"]) <= 200,
             "license identifier required (including an explicit custom license name)")
    _require(isinstance(value["scope"], str)
             and value["scope"] in {"model-weights", "voice-weights", "tokenizer", "runtime", "data"},
             "unknown license scope")
    _https_url(value["sourceUrl"])
    return value


def validate_manifest(manifest):
    _require(isinstance(manifest, dict) and set(manifest) == {"schemaVersion", "models"},
             "manifest needs exactly schemaVersion/models")
    _require(type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 1,
             "unsupported model manifest schema")
    models = manifest["models"]
    _require(isinstance(models, list) and 0 < len(models) <= 50, "bounded nonempty model list required")
    ids, paths, total = set(), set(), 0
    for model in models:
        _require(isinstance(model, dict) and set(model) == {"id", "role", "license", "source", "artifacts"},
                 "model needs exactly id/role/license/source/artifacts")
        _require(isinstance(model["id"], str) and bool(_ID.fullmatch(model["id"])) and model["id"] not in ids,
                 "model ID invalid or repeated")
        ids.add(model["id"])
        _require(isinstance(model["role"], str) and model["role"] in {"translation", "tts", "asr-qc"},
                 "unsupported pilot model role")
        validate_license(model["license"])
        source = model["source"]
        _require(isinstance(source, dict) and set(source) == {"publisher", "repo", "revision", "reviewStatus"},
                 "source needs explicit publisher/repo/revision/reviewStatus")
        _require(all(isinstance(source[k], str) and 0 < len(source[k]) <= 250
                     for k in ("publisher", "repo", "revision")), "source identity invalid")
        _require(isinstance(source["reviewStatus"], str)
                 and source["reviewStatus"] in {"verified-official", "reviewed-conversion"},
                 "source must be reviewed; conversion is never mislabeled upstream official")
        artifacts = model["artifacts"]
        _require(isinstance(artifacts, list) and 0 < len(artifacts) <= 100, "bounded nonempty artifact list required")
        _require(any(isinstance(a.get("kind"), str) and a.get("kind") in {"weights", "archive"}
                     for a in artifacts if isinstance(a, dict)),
                 "model must contain weight data or a reviewed archive")
        for artifact in artifacts:
            revision = source["revision"] if _COMMIT.fullmatch(source["revision"]) else None
            validate_artifact(artifact, expected_revision=revision)
            origin = urlsplit(artifact["url"])
            if origin.hostname == "huggingface.co":
                origin_parts = origin.path.strip("/").split("/")
                _require(revision is not None, "HF model source needs a full immutable commit")
                _require("/".join(origin_parts[:2]) == source["repo"], "source repository differs from artifact origin")
            elif origin.hostname == "github.com":
                _require(source["repo"] == "k2-fsa/sherpa-onnx"
                         and source["revision"] == origin.path.strip("/").split("/")[4],
                         "sherpa archive source repo/release differs from origin")
            key = artifact["path"].casefold()
            _require(key not in paths, "artifact paths overlap across models")
            paths.add(key)
            total += artifact["size"]
    for key in paths:
        parts = key.split("/")
        for stop in range(1, len(parts)):
            _require("/".join(parts[:stop]) not in paths, "artifact file/directory path collision")
    _require(total <= 24 * 1024**3, "total pilot model inventory exceeds 24 GiB cap")
    return manifest


def strict_json(data):
    """Decode data-only JSON, rejecting duplicate keys and nonfinite numbers."""
    def pairs(rows):
        result = {}
        for key, value in rows:
            _require(key not in result, "duplicate JSON object key")
            result[key] = value
        return result

    def constant(_value):
        raise PolicyError("nonfinite JSON number")

    return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)


def verify_artifact(root, artifact):
    """Verify declared file without loading it; reject links and path escapes."""
    validate_artifact(artifact)
    base = Path(root).resolve(strict=True)
    _require(base.is_dir(), "artifact root is not a directory")
    candidate = base
    for component in artifact["path"].split("/"):
        candidate = candidate / component
        _require(not candidate.is_symlink(), "symlink in model artifact path")
    resolved = candidate.resolve(strict=True)
    _require(resolved.is_relative_to(base), "artifact escapes model root")
    before = resolved.stat(follow_symlinks=False)
    _require(stat.S_ISREG(before.st_mode) and before.st_size == artifact["size"], "artifact type/size differs")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(resolved, flags)
    try:
        opened = os.fstat(fd)
        _require((opened.st_dev, opened.st_ino, opened.st_size) == (before.st_dev, before.st_ino, before.st_size),
                 "artifact changed while opening")
        digest = hashlib.sha256()
        read = 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            read += len(chunk)
            _require(read <= artifact["size"], "artifact grew while reading")
            digest.update(chunk)
        after = os.fstat(fd)
        _require(read == artifact["size"] and after.st_size == before.st_size
                 and after.st_mtime_ns == before.st_mtime_ns, "artifact changed during hash verification")
        _require(digest.hexdigest() == artifact["sha256"], "artifact SHA-256 mismatch")
        return {"path": artifact["path"], "size": read, "sha256": digest.hexdigest()}
    finally:
        os.close(fd)


def _tar_plan(archive, limits):
    """Read header inventory under caller-enforced CPU/memory/time limits."""
    path = Path(archive)
    _require(not path.is_symlink() and path.is_file(), "archive must be a regular non-link file")
    size = path.stat().st_size
    _require(0 < size <= limits["maxArchiveBytes"], "archive byte limit exceeded")
    names, files, directories = set(), {}, set()
    total, count = 0, 0
    with tarfile.open(path, mode="r:bz2") as stream:
        for member in stream:
            count += 1
            _require(count <= limits["maxMembers"], "archive member count exceeded")
            _require(member.isdir() or member.isreg(), "archive links/devices/FIFO/special types forbidden")
            _require(not member.issparse() and not any(k.startswith("GNU.sparse") for k in member.pax_headers),
                     "sparse archive member forbidden")
            _require(not member.linkname, "archive link target forbidden")
            name = safe_relative_path(member.name, limits=limits, allow_directory=member.isdir())
            key = name.casefold()
            _require(key not in names, "duplicate/case-colliding archive path")
            names.add(key)
            _require(type(member.size) is int and member.size >= 0, "invalid archive member size")
            if member.isdir():
                _require(member.size == 0, "nonempty directory entry")
                directories.add(key)
            else:
                _require(member.size <= limits["maxFileBytes"], "archive file size exceeded")
                suffix = PurePosixPath(name).suffix.lower()
                _require(suffix not in _BANNED and suffix not in {".bz2", ".gz", ".xz", ".tar"},
                         "executable/unsafe/nested archive member forbidden")
                total += member.size
                _require(total <= limits["maxTotalBytes"], "archive expanded byte limit exceeded")
                _require(total <= size * limits["maxExpansionRatio"], "archive expansion ratio exceeded")
                files[key] = {"path": name, "size": member.size}
        for key in files.keys() | directories:
            parts = key.split("/")
            for stop in range(1, len(parts)):
                _require("/".join(parts[:stop]) not in files, "archive file/directory collision")
    _require(files, "archive has no regular files")
    return {"archiveBytes": size, "members": count, "expandedBytes": total,
            "files": list(files.values()), "directories": sorted(directories)}


def inspect_tar(archive, limits=None):
    """Validate inventory only. Caller MUST run in an OS sandbox with timeout."""
    try:
        return _tar_plan(archive, _limits(limits))
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise PolicyError(f"archive cannot be safely read: {type(exc).__name__}") from exc


def extract_tar(archive, destination, limits=None):
    """Extract only regular data to a NEW directory inside the OS sandbox.

    Never uses TarFile.extract/all, never restores ownership, permissions or
    timestamps. On failure partial output remains untrusted in job scratch; the
    sandbox owner discards it. No recursive host deletion is performed here.
    """
    policy = _limits(limits)
    plan = inspect_tar(archive, policy)
    dest = Path(destination)
    _require(not dest.exists() and not dest.is_symlink(), "extraction destination must not exist")
    parent = dest.parent.resolve(strict=True)
    _require(parent.is_dir(), "destination parent must exist")
    dest = parent / dest.name
    _require(bool(_COMPONENT.fullmatch(dest.name)) and not _RESERVED.match(dest.name)
             and not dest.name.endswith((".", " ")), "invalid extraction destination name")
    dest.mkdir(mode=0o700)
    expected = {row["path"]: row for row in plan["files"]}
    accepted = {}
    try:
        with tarfile.open(archive, mode="r:bz2") as stream:
            for member in stream:
                _require(member.isdir() or member.isreg(), "archive changed: special member")
                name = safe_relative_path(member.name, limits=policy, allow_directory=member.isdir())
                target = dest.joinpath(*name.split("/"))
                _require(target.resolve(strict=False).is_relative_to(dest), "extraction path escape")
                if member.isdir():
                    _require(name.casefold() in plan["directories"], "archive changed: directory")
                    target.mkdir(parents=True, mode=0o700, exist_ok=True)
                    continue
                _require(name in expected and name not in accepted and member.size == expected[name]["size"],
                         "archive changed: file inventory")
                target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                for ancestor in [target.parent, *target.parent.parents]:
                    if ancestor == parent:
                        break
                    _require(not ancestor.is_symlink(), "symlink in extraction output")
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
                fd = os.open(target, flags, 0o600)
                digest, copied = hashlib.sha256(), 0
                source = stream.extractfile(member)
                _require(source is not None, "archive member has no file stream")
                try:
                    with source:
                        while True:
                            chunk = source.read(min(1024 * 1024, member.size - copied + 1))
                            if not chunk:
                                break
                            copied += len(chunk)
                            _require(copied <= member.size, "archive member exceeds declared length")
                            digest.update(chunk)
                            view = memoryview(chunk)
                            while view:
                                written = os.write(fd, view)
                                _require(written > 0, "short extraction write")
                                view = view[written:]
                    _require(copied == member.size, "truncated archive member")
                    os.fsync(fd)
                finally:
                    os.close(fd)
                accepted[name] = {"path": name, "size": copied, "sha256": digest.hexdigest()}
        _require(set(accepted) == set(expected), "archive changed: missing member")
        return {**plan, "files": list(accepted.values())}
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise PolicyError(f"extraction failed: {type(exc).__name__}") from exc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--root", type=Path, help="verify every declared artifact against this root")
    args = parser.parse_args()
    _require(args.manifest.stat().st_size <= 1024 * 1024, "manifest exceeds 1 MiB")
    manifest = validate_manifest(strict_json(args.manifest.read_text(encoding="utf-8-sig")))
    artifacts = [a for m in manifest["models"] for a in m["artifacts"]]
    verified = [verify_artifact(args.root, a) for a in artifacts] if args.root else []
    print(json.dumps({"status": "verified" if args.root else "manifest-valid",
                      "models": len(manifest["models"]), "artifacts": len(artifacts),
                      "verifiedArtifacts": verified}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (PolicyError, ValueError, OSError) as exc:
        raise SystemExit(f"Model policy rejected input: {exc}")
