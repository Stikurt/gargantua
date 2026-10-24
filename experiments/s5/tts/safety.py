"""Bounded, non-executable archive staging for the local TTS experiment."""
from __future__ import annotations
import hashlib
import pathlib
import shutil
import tarfile


def digest(path: pathlib.Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def target_path(root: pathlib.Path, raw: str) -> pathlib.Path:
    if "\\" in raw or ":" in raw or "\0" in raw:
        raise ValueError("noncanonical archive member")
    name = pathlib.PurePosixPath(raw)
    if name.is_absolute() or any(p in {"..", ""} for p in name.parts):
        raise ValueError("archive traversal")
    path = root.joinpath(*name.parts)
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("archive path escaped staging root")
    return path


def extract_bounded(archive: pathlib.Path, root: pathlib.Path,
                    max_total: int = 220 * 1024 * 1024,
                    max_member: int = 180 * 1024 * 1024,
                    max_files: int = 10000) -> dict:
    root.mkdir(parents=True, exist_ok=False)
    try:
        # Streaming validation bounds the member list before reading every
        # header. Container memory/time limits still apply to the tar parser.
        with tarfile.open(archive, "r|bz2") as stream:
            paths = set()
            total = 0
            count = 0
            for member in stream:
                count += 1
                if count > max_files:
                    raise ValueError("archive file budget")
                if len(member.name) > 1024:
                    raise ValueError("archive filename budget")
                target = target_path(root, member.name)
                key = str(target).casefold()
                if key in paths:
                    raise ValueError("duplicate archive member")
                paths.add(key)
                if not member.isfile() and not member.isdir():
                    raise ValueError("links/devices are forbidden")
                if member.size < 0 or member.size > max_member:
                    raise ValueError("archive member budget")
                total += member.size
                if total > max_total:
                    raise ValueError("archive expanded budget")
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                source = stream.extractfile(member)
                if source is None:
                    raise ValueError("archive payload absent")
                with source, target.open("xb") as output:
                    remaining = member.size
                    while remaining:
                        block = source.read(min(1024 * 1024, remaining))
                        if not block:
                            raise ValueError("truncated archive member")
                        output.write(block)
                        remaining -= len(block)
            return {"files": count, "expandedBytes": total}
    except BaseException:
        # Only the newly created staging directory, checked against the caller root.
        if root.exists():
            shutil.rmtree(root)
        raise
