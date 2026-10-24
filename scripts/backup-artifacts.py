"""Offline snapshot manifests and library validation. No Docker or database client.

Contains no secrets, never executes source archives, and writes only explicit targets.
The PowerShell orchestrators obtain database inventories inside a consistent snapshot.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import sys
import tarfile
import unicodedata
import zlib
from datetime import datetime, timezone

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ASSET = re.compile(r"^image-[0-9]{1,3}\.png$")
SHA = re.compile(r"^[0-9a-fA-F]{64}$")
MAX_JSON = 32 * 1024 * 1024
MAX_FILES = 200000
PNG = b"\x89PNG\r\n\x1a\n"
SOURCE_ROOTS = ("server", "src", "public", "parser", "inference", "experiments/s5", "desktop", "android", "ops", "scripts", "tests", "docs")
SOURCE_FILES = ("Dockerfile", "compose.yaml", "package.json", "package-lock.json", "index.html", "vite.config.mjs", "README.md", "LIBRARY_POLICY.md", "PERSONAL_LIBRARY_SPEC.md", "SOURCES_RESEARCH.md", "INCIDENT_RESPONSE.md", "TEST_REPORT.md")
DENIED_PARTS = {".git", ".local", ".gradle", ".pytest_cache", ".backup-test-tmp", ".test-tmp", "node_modules", "__pycache__", "build", "dist", "backups", "releases", "test-results"}
DENIED_NAMES = {"local.properties", "keystore.properties", "key.properties", "credentials.json", "google-services.json"}


def fail(message):
    raise ValueError(message)


def read_json(path, limit=MAX_JSON):
    if path.stat().st_size > limit:
        fail("JSON exceeds validation limit")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def linked(path):
    value = path.lstat()
    return stat.S_ISLNK(value.st_mode) or bool(getattr(value, "st_file_attributes", 0) & 0x400)


def relative_name(value, legacy=False):
    if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
        fail("Invalid manifest path")
    if legacy:
        value = value.replace("\\", "/")
    if "\\" in value or ":" in value or value.startswith("/"):
        fail("Absolute or nonportable manifest path")
    parts = value.split("/")
    if any(part in ("", ".", "..") or part.endswith((".", " ")) for part in parts):
        fail("Unsafe manifest path")
    return PurePosixPath(*parts).as_posix()


def safe_path(root, relative):
    root = Path(root).resolve()
    result = root
    for part in relative_name(relative).split("/"):
        result = result / part
        if result.exists() or result.is_symlink():
            if linked(result):
                fail("Symlink/reparse point is not a snapshot file")
    if not result.resolve().is_relative_to(root):
        fail("Snapshot path escaped its root")
    return result


def files_under(root):
    root = Path(root)
    if not root.is_dir() or linked(root):
        fail("Snapshot root is not a regular directory")
    result, folded = {}, set()
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            path = Path(parent) / name
            if linked(path):
                fail("Snapshot contains a symlink/reparse point")
        for name in files:
            path = Path(parent) / name
            relative = relative_name(path.relative_to(root).as_posix())
            if not path.is_file():
                fail("Snapshot contains a non-regular file")
            if relative.casefold() in folded:
                fail("Duplicate portable snapshot path")
            folded.add(relative.casefold())
            result[relative] = path
            if len(result) > MAX_FILES:
                fail("Too many snapshot files")
    return result


def file_record(path):
    digest = hashlib.sha256()
    count = 0
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            count += len(block)
            digest.update(block)
    return {"path": "", "bytes": count, "sha256": digest.hexdigest()}


def source_allowed(relative):
    parts = PurePosixPath(relative).parts
    name = parts[-1].lower()
    pilot_cache = parts[:2] == ("experiments", "s5") and (
        any(part.lower() in {"wheels", "prefetched", "pip-tmp", "downloads", "tts-models"} for part in parts)
        or name.endswith((".whl", ".onnx", ".gguf", ".safetensors", ".bin", ".pt", ".pth", ".tar", ".tar.gz", ".tgz", ".zip"))
    )
    return not (
        pilot_cache or any(part.lower() in DENIED_PARTS for part in parts)
        or name in DENIED_NAMES or name.startswith(".env")
        or name.endswith((".jks", ".keystore", ".p12", ".pfx", ".pem", ".key", ".apk", ".aab", ".exe", ".dll", ".pyc"))
        or parts[:5] == ("android", "app", "src", "main", "assets")
        or "signing" in name
    )


def source_candidates(project):
    project = Path(project).resolve()
    candidates = set()
    for name in SOURCE_FILES:
        if (project / name).is_file():
            candidates.add(name)
    for name in SOURCE_ROOTS:
        folder = project / name
        if not folder.exists():
            continue
        if linked(folder):
            fail("Source root is a symlink/reparse point")
        for parent, directories, files in os.walk(folder, followlinks=False, onerror=lambda error: fail("Source directory is unreadable")):
            kept = []
            for child in directories:
                path = Path(parent) / child
                relative = path.relative_to(project).as_posix()
                if source_allowed(relative):
                    if linked(path):
                        fail("Source contains a symlink/reparse point")
                    kept.append(child)
            directories[:] = kept
            for child in files:
                path = Path(parent) / child
                relative = path.relative_to(project).as_posix()
                if source_allowed(relative):
                    safe_path(project, relative)
                    if not stat.S_ISREG(path.lstat().st_mode):
                        fail("Source contains a non-regular file")
                    candidates.add(relative)
                    if len(candidates) > MAX_FILES:
                        fail("Too many selected source files")
    if not {"compose.yaml", "package.json", "server/db.mjs"}.issubset(candidates):
        fail("Required source/config inputs are missing")
    size = 0
    for relative in candidates:
        if len(relative.encode("utf-8")) > 4096:
            fail("Source path exceeds the archive budget limit")
        size += safe_path(project, relative).stat().st_size
        if size > 8 * 1024**3:
            fail("Selected source exceeds the 8 GiB archive limit")
    return sorted(candidates), size


def source_estimate(project):
    candidates, size = source_candidates(project)
    # PAX paths/headers, 512-byte padding and incompressible gzip slack are bounded.
    return {"files": len(candidates), "bytes": size,
            "archiveBoundBytes": size * 2 + len(candidates) * 32768 + 1024**2}


def source_archive(project, output):
    project = Path(project).resolve()
    candidates, _ = source_candidates(project)
    output = Path(output)
    if output.exists():
        fail("Refusing to overwrite source archive")
    with tarfile.open(output, "w:gz", format=tarfile.PAX_FORMAT) as bundle:
        for relative in sorted(candidates):
            path = safe_path(project, relative)
            # Refuse embedded private keys even in an otherwise allowed filename.
            if path.stat().st_size <= MAX_JSON and re.search(rb"(?m)^-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\r\n]", path.read_bytes()):
                fail("Embedded private key in source/config input")
            bundle.add(path, arcname=relative, recursive=False)
    return {"sourceFiles": len(candidates), "runtimeSecretsIncluded": False}


def check_source_archive(path, legacy=False):
    seen = set()
    with tarfile.open(path, "r:gz") as bundle:
        for item in bundle:
            name = relative_name(item.name)
            if name.casefold() in seen:
                fail("Duplicate source archive member")
            seen.add(name.casefold())
            if not (item.isfile() or item.isdir()) or item.issym() or item.islnk():
                fail("Unsafe source archive member")
            if not source_allowed(name) and not legacy:
                fail("Excluded runtime/build/secret path in source archive")


def table_fingerprints(path):
    if path.stat().st_size > MAX_JSON:
        fail("Database fingerprint inventory too large")
    result = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        if not isinstance(item, dict) or not isinstance(item.get("table"), str) or item["table"] in result:
            fail("Invalid or duplicate database table fingerprint")
        algorithm = item.get("algorithm", "md5-sorted-v1")
        size = {"md5-sorted-v1": 32, "sha256-sorted-fold-v2": 64}.get(algorithm) if isinstance(algorithm, str) else None
        if not set(item).issubset({"table", "count", "fingerprint", "algorithm"}) or size is None or type(item.get("count")) is not int or item["count"] < 0 or not isinstance(item.get("fingerprint"), str) or not re.fullmatch(r"[a-f0-9]{" + str(size) + "}", item["fingerprint"]):
            fail("Invalid database table fingerprint")
        result[item["table"]] = item
    if not {"profiles", "books", "imports", "reading", "bookmarks", "settings"}.issubset(result):
        fail("Database inventory is incomplete")
    return result


def rows_by_id(rows, label):
    if not isinstance(rows, list):
        fail("Invalid inventory table: " + label)
    result = {}
    for row in rows:
        value = row.get("id") if isinstance(row, dict) else None
        if not isinstance(value, str) or not UUID.fullmatch(value) or value in result:
            fail("Invalid or duplicate inventory ID: " + label)
        result[value] = row
    return result


READER_TABLES = ("reader_profiles", "reader_devices", "reader_entities", "reader_mutations", "reader_changes")
READER_CATALOG_ID = "00000000-0000-4000-8000-000000000002"
READER_KINDS = ("reading", "bookmark", "catalog")
READER_SHELVES = ("reading", "planned", "finished", "paused", "dropped", "favorite")
READER_COLUMNS = {
    "reader_profiles": {"profile_id", "revision", "min_revision"},
    "reader_devices": {"profile_id", "device_id", "last_counter", "updated_at"},
    "reader_entities": {"profile_id", "entity_type", "entity_id", "revision", "deleted", "payload", "legacy_id", "updated_at"},
    "reader_mutations": {"profile_id", "mutation_id", "device_id", "counter", "body_sha256", "canonical_body", "body", "result", "created_at"},
    "reader_changes": {"profile_id", "change_revision", "entity_type", "entity_id", "record"},
}
READER_COLUMNS_V2 = {name: columns | {
    "reader_devices": {"protocol_version", "compacted_through", "compacted_accepted", "compaction_sha256"},
    "reader_entities": {"modern_write"},
    "reader_mutations": {"compacted", "entity_type", "entity_id", "accepted_revision"},
}.get(name, set()) for name, columns in READER_COLUMNS.items()}
READER_METADATA_LIMIT = 128 * 1024**2
READER_ROW_LIMIT = 500000
READER_JOURNAL_MAX_BYTES = 96 * 1024**2
READER_JOURNAL_MAX_ROWS = 250000


def reader_mutation_id(profile, device, counter):
    """The v2 ID binds a consumed counter to one operation identity forever."""
    value = bytearray(hashlib.sha256(f"gargantua-reader-v2\0{profile}\0{device}\0{counter}".encode("utf-8")).digest()[:16])
    value[6] = (value[6] & 15) | 128
    value[8] = (value[8] & 63) | 128
    text = value.hex()
    return "-".join((text[:8], text[8:12], text[12:16], text[16:20], text[20:]))


def reader_integer(value, minimum=0, maximum=9007199254740991):
    return type(value) is int and minimum <= value <= maximum


def reader_text(value, limit, minimum=0, multiline=False):
    if not isinstance(value, str):
        return False
    try:
        units = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        return False
    return minimum <= units <= limit and not any(
        unicodedata.category(character) in ("Cc", "Cf") and not (multiline and character in "\t\n\r")
        for character in value
    )


def validate_reader_catalogs(payload):
    if not isinstance(payload, dict) or set(payload) != {"catalogs"} or not isinstance(payload["catalogs"], list) or len(payload["catalogs"]) > 100:
        fail("Invalid reader catalogue payload")
    catalogs = rows_by_id(payload["catalogs"], "reader catalogue")
    count = 0
    for identity, row in catalogs.items():
        if set(row) != {"id", "title", "parent", "items"} or not reader_text(row["title"], 120, 1) or not row["title"].strip() or not isinstance(row["items"], list):
            fail("Invalid reader catalogue shape")
        parent, seen = row["parent"], {identity}
        while parent is not None:
            if parent not in catalogs or parent in seen or len(seen) >= 8:
                fail("Broken reader catalogue hierarchy")
            seen.add(parent)
            parent = catalogs[parent]["parent"]
        seen_items = set()
        for item in row["items"]:
            count += 1
            if count > 200 or not isinstance(item, dict) or set(item) != {"id", "scope", "title", "author"} or not UUID.fullmatch(str(item["id"])) or item["scope"] not in ("device", "server") or not reader_text(item["title"], 250) or not reader_text(item["author"], 250):
                fail("Invalid reader catalogue reference/budget")
            key = (item["scope"], item["id"])
            if key in seen_items:
                fail("Duplicate reader catalogue reference")
            seen_items.add(key)
    if len(canonical_json(payload).encode("utf-8")) > 24000:
        fail("Reader catalogue exceeds its byte budget")


def validate_reader_payload(kind, identity, payload, books_root, books, cache):
    if kind == "catalog":
        if identity != READER_CATALOG_ID:
            fail("Reader catalogue identity differs")
        validate_reader_catalogs(payload)
        return
    extra = "shelf" if kind == "reading" else "note"
    if kind not in ("reading", "bookmark") or not isinstance(payload, dict) or set(payload) != {"publicationId", "publicationRevision", "locator", extra}:
        fail("Invalid reader publication payload")
    publication = payload["publicationId"]
    if publication not in books or type(payload["publicationRevision"]) is not int or payload["publicationRevision"] != 1 or kind == "reading" and identity != publication:
        fail("Broken reader publication relationship/revision")
    if kind == "reading" and payload[extra] not in READER_SHELVES or kind == "bookmark" and not reader_text(payload[extra], 500, multiline=True):
        fail("Invalid reader shelf/note")
    locator = payload["locator"]
    if not isinstance(locator, dict):
        fail("Invalid reader locator")
    ratio = lambda value: type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1
    if locator.get("type") == "legacy":
        if set(locator) != {"type", "chapter", "position"} or not reader_integer(locator["chapter"], 0, books[publication]["chapter_count"] - 1) or not ratio(locator["position"]):
            fail("Invalid legacy reader locator")
        return
    if not {"publicationId", "publicationRevision", "chapterId"}.issubset(locator) or not set(locator).issubset({"publicationId", "publicationRevision", "chapterId", "blockId", "offset", "quote", "progression"}) or locator["publicationId"] != publication or type(locator["publicationRevision"]) is not int or locator["publicationRevision"] != 1:
        fail("Reader locator belongs to another publication/revision")
    if publication not in cache:
        content = read_json(safe_path(books_root, publication + "/book.json"))
        cache[publication] = content.get("structure", {}).get("chapters") or [
            {"id": f"c-{index}", "blocks": [{**block, "id": f"c-{index}-b-{ordinal}"} for ordinal, block in enumerate(chapter["blocks"])]}
            for index, chapter in enumerate(content["chapters"])
        ]
    chapter = next((row for row in cache[publication] if row["id"] == locator["chapterId"]), None)
    if chapter is None:
        fail("Reader locator chapter is missing")
    block = next((row for row in chapter["blocks"] if row["id"] == locator.get("blockId")), None)
    if "blockId" in locator and block is None or any(key in locator for key in ("offset", "quote")) and block is None:
        fail("Reader locator block is missing")
    if "offset" in locator:
        offset, encoded = locator["offset"], block["text"].encode("utf-16-le")
        if not reader_integer(offset, 0, len(encoded) // 2):
            fail("Reader locator offset exceeds its block")
        try:
            encoded[:offset * 2].decode("utf-16-le")
            encoded[offset * 2:].decode("utf-16-le")
        except UnicodeDecodeError:
            fail("Reader locator offset splits a character")
    if "progression" in locator and not ratio(locator["progression"]):
        fail("Invalid reader locator progression")
    if "quote" in locator:
        quote = locator["quote"]
        if not isinstance(quote, dict) or not {"exact"}.issubset(quote) or not set(quote).issubset({"exact", "prefix", "suffix"}) or not reader_text(quote["exact"], 1000, 1, True) or any(not reader_text(quote[key], 200, multiline=True) for key in ("prefix", "suffix") if key in quote):
            fail("Invalid reader locator quote")
        text = block["text"]
        if "offset" in locator:
            position = len(text.encode("utf-16-le")[:locator["offset"] * 2].decode("utf-16-le"))
        else:
            position = text.find(quote["exact"])
            if position < 0 or text.find(quote["exact"], position + 1) >= 0:
                fail("Reader quote is missing/ambiguous without an offset")
        end = position + len(quote["exact"])
        if text[position:end] != quote["exact"] or "prefix" in quote and not text[:position].endswith(quote["prefix"]) or "suffix" in quote and not text[end:].startswith(quote["suffix"]):
            fail("Reader quote/context differs from immutable text")


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def reader_metadata(path, metadata_format="source-jsonl-v1"):
    columns = READER_COLUMNS_V2 if metadata_format == "source-jsonl-v2" else READER_COLUMNS
    if metadata_format not in ("source-jsonl-v1", "source-jsonl-v2"):
        fail("Unsupported reader metadata format")
    if path is None or not Path(path).is_file() or Path(path).stat().st_size > READER_METADATA_LIMIT or linked(Path(path)):
        fail("Missing/oversized reader metadata sidecar")
    phase = -1
    with Path(path).open("rb") as stream:
        for count, line in enumerate(iter(lambda: stream.readline(128 * 1024 + 1), b""), 1):
            if len(line) > 128 * 1024 or count > READER_ROW_LIMIT or not line.endswith(b"\n"):
                fail("Unbounded or incomplete reader metadata record")
            value = json.loads(line.decode("utf-8"))
            if not isinstance(value, dict) or set(value) != {"table", "row"} or value["table"] not in READER_TABLES or not isinstance(value["row"], dict):
                fail("Unexpected reader metadata table/record")
            if not set(value["row"]).issubset(columns[value["table"]]):
                fail("Unknown/private credential field in reader metadata")
            next_phase = READER_TABLES.index(value["table"])
            if next_phase < phase:
                fail("Reader metadata tables are out of dependency order")
            phase = next_phase
            yield value["table"], value["row"]


def validate_reader(books_root, inventory, metadata_path=None, expected_tables=None):
    empty = {"readerProfilesChecked": 0, "readerDevicesChecked": 0, "readerEntitiesChecked": 0,
             "readerTombstonesChecked": 0, "readerReceiptsChecked": 0, "readerChangesChecked": 0,
             "readerCompactedReceiptsChecked": 0, "readerPrunedAcceptedChecked": 0}
    if not inventory.get("readerSupported"):
        if expected_tables is not None and any(name in expected_tables for name in READER_TABLES) or any(name in inventory.get("tables", {}) for name in READER_TABLES):
            fail("Reader support flag omits fingerprinted metadata")
        return empty
    metadata_format = inventory.get("readerMetadataFormat")
    modern = metadata_format == "source-jsonl-v2"
    if inventory.get("readerSupported") is not True or metadata_format not in ("source-jsonl-v1", "source-jsonl-v2") or any(name in inventory.get("tables", {}) for name in READER_TABLES):
        fail("Unsupported/duplicated reader metadata")
    budget = inventory.get("readerBudget")
    if modern:
        if not isinstance(budget, dict) or set(budget) != {"format", "rows", "bytes", "maxRows", "maxBytes"} or budget["format"] != "exact-jsonl-v1" or budget["maxRows"] != READER_JOURNAL_MAX_ROWS or budget["maxBytes"] != READER_JOURNAL_MAX_BYTES or not reader_integer(budget["rows"], 0, READER_JOURNAL_MAX_ROWS) or not reader_integer(budget["bytes"], 0, READER_JOURNAL_MAX_BYTES):
            fail("Missing/invalid reader journal budget")
        if metadata_path is None or not Path(metadata_path).is_file() or Path(metadata_path).stat().st_size != budget["bytes"]:
            fail("Reader metadata bytes differ from the accounted source budget")
        if expected_tables is not None and ("reader_journal_budget" not in expected_tables or expected_tables["reader_journal_budget"]["count"] != 1):
            fail("Reader journal budget singleton is missing from the fingerprint baseline")
    elif budget is not None:
        fail("Legacy reader metadata unexpectedly includes a journal budget")
    profiles = rows_by_id(inventory.get("tables", {}).get("profiles"), "profiles")
    books = rows_by_id(inventory.get("tables", {}).get("books"), "books")
    legacy_bookmarks = rows_by_id(inventory.get("tables", {}).get("bookmarks", []), "bookmarks")
    counts = {name: 0 for name in READER_TABLES}
    heads, devices, entities, cache, legacy_ids = {}, {}, {}, {}, set()
    mutation_ids, receipt_counters, receipt_counts, change_counters, change_entity_revisions = set(), {}, {}, {}, {}

    def public_record(row):
        required = {"entityType", "entityId", "revision", "deleted", "payload"}
        if not isinstance(row, dict) or not required.issubset(row) or not set(row).issubset(required | {"updatedAt"}) or row["entityType"] not in READER_KINDS or not UUID.fullmatch(str(row["entityId"])) or not reader_integer(row["revision"], 0, 2147483647) or type(row["deleted"]) is not bool:
            fail("Invalid historical reader entity record")
        if row["revision"] == 0 and not (row["entityType"] == "catalog" and row["entityId"] == READER_CATALOG_ID and not row["deleted"]):
            fail("Zero reader revision is only a legacy catalogue baseline")
        if row["entityType"] == "catalog" and row["entityId"] != READER_CATALOG_ID:
            fail("Reader catalogue record identity differs")
        if "updatedAt" in row:
            if not isinstance(row["updatedAt"], str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z", row["updatedAt"]):
                fail("Invalid reader record timestamp")
            try:
                datetime.fromisoformat(row["updatedAt"].replace("Z", "+00:00"))
            except ValueError:
                fail("Invalid reader record timestamp")
        if row["payload"] is None:
            if not row["deleted"]:
                fail("Active reader entity lacks payload")
        else:
            validate_reader_payload(row["entityType"], row["entityId"], row["payload"], books_root, books, cache)
        return row

    for name, row in reader_metadata(metadata_path, metadata_format):
        counts[name] += 1
        profile = row.get("profile_id")
        if profile not in profiles:
            fail("Reader metadata belongs to a missing profile")
        if name == "reader_profiles":
            if profile in heads or not reader_integer(row.get("revision")) or not reader_integer(row.get("min_revision"), 0, row["revision"]):
                fail("Invalid/duplicate reader profile cursor")
            heads[profile] = row
            continue
        if profile not in heads:
            fail("Reader metadata lacks its profile cursor")
        if name == "reader_devices":
            key = (profile, row.get("device_id"))
            if not UUID.fullmatch(str(row.get("device_id"))) or key in devices or not reader_integer(row.get("last_counter")):
                fail("Invalid/duplicate reader sync device")
            if modern:
                protocol, floor, removed, proof = (row.get(field) for field in ("protocol_version", "compacted_through", "compacted_accepted", "compaction_sha256"))
                if type(protocol) is not int or protocol not in (1, 2) or not reader_integer(floor, 0, row["last_counter"]) or not reader_integer(removed, 0, floor) or (removed == 0 and (floor != 0 or proof is not None)) or (removed > 0 and (floor == 0 or not re.fullmatch(r"[a-f0-9]{64}", str(proof)))) or protocol == 1 and (floor or removed or proof is not None):
                    fail("Invalid reader device compaction checkpoint")
            devices[key] = row
        elif name == "reader_entities":
            key = (profile, row.get("entity_type"), row.get("entity_id"))
            if key in entities:
                fail("Duplicate reader entity")
            public_record({"entityType": row.get("entity_type"), "entityId": row.get("entity_id"), "revision": row.get("revision"), "deleted": row.get("deleted"), "payload": row.get("payload")})
            if modern and type(row.get("modern_write")) is not bool:
                fail("Invalid reader entity modern-write guard")
            if row.get("legacy_id") is not None:
                if row["entity_type"] != "bookmark" or not UUID.fullmatch(str(row["legacy_id"])) or row["legacy_id"] in legacy_ids:
                    fail("Invalid/duplicate legacy reader bookmark identity")
                legacy_ids.add(row["legacy_id"])
                legacy = legacy_bookmarks.get(row["legacy_id"])
                if legacy and (legacy["profile_id"] != profile or row["deleted"] or legacy["book_id"] != row["payload"]["publicationId"]):
                    fail("Legacy reader bookmark belongs to another profile/publication or resurrects a tombstone")
            entities[key] = row
            empty["readerTombstonesChecked"] += row["deleted"]
        elif name == "reader_mutations":
            key = (profile, row.get("device_id"))
            counter = row.get("counter")
            body, result = row.get("body"), row.get("result")
            if key not in devices or not UUID.fullmatch(str(row.get("mutation_id"))) or not reader_integer(counter, 1, devices[key]["last_counter"]) or not re.fullmatch(r"[a-f0-9]{64}", str(row.get("body_sha256", ""))):
                fail("Broken reader receipt/device/counter relationship")
            # Fixed-width binary keys avoid retaining two UUID strings and a
            # tuple per receipt. The global v2 journal budget also bounds rows.
            identity = bytes.fromhex(profile.replace("-", "") + row["mutation_id"].replace("-", ""))
            floor = devices[key].get("compacted_through", 0) if modern else 0
            previous = receipt_counters.get(key, 0)
            if identity in mutation_ids or counter <= previous or counter > floor and counter != max(previous, floor) + 1:
                fail("Broken reader receipt/device/counter relationship")
            if modern:
                if type(row.get("compacted")) is not bool or row.get("entity_type") not in READER_KINDS or not UUID.fullmatch(str(row.get("entity_id"))):
                    fail("Invalid typed reader receipt checkpoint")
                if devices[key]["protocol_version"] == 2 and (row["compacted"] or row["mutation_id"] != reader_mutation_id(profile, row["device_id"], counter)):
                    fail("Reader v2 receipt identity differs from its durable counter")
                if row["compacted"]:
                    entity_key = (profile, row["entity_type"], row["entity_id"])
                    expected = {"mutationId": row["mutation_id"], "status": "accepted", "compacted": True, "entityType": row["entity_type"], "entityId": row["entity_id"], "revision": row.get("accepted_revision"), "snapshotRequired": True}
                    if body is not None or row.get("canonical_body") is not None or result != expected or not reader_integer(row.get("accepted_revision"), 1, 2147483647) or entity_key not in entities or row["accepted_revision"] > entities[entity_key]["revision"] or not entities[entity_key]["modern_write"]:
                        fail("Invalid compacted legacy reader receipt")
                    mutation_ids.add(identity)
                    receipt_counters[key] = counter
                    receipt_counts[key] = receipt_counts.get(key, 0) + 1
                    empty["readerCompactedReceiptsChecked"] += 1
                    continue
            if not isinstance(body, dict) or body.get("mutationId") != row["mutation_id"] or body.get("deviceId") != row["device_id"] or not reader_integer(body.get("counter"), 1) or body["counter"] != counter or body.get("entityType") not in READER_KINDS or not UUID.fullmatch(str(body.get("entityId"))) or not reader_integer(body.get("baseRevision"), 0, 2147483646) or body.get("operation") not in ("upsert", "delete"):
                fail("Invalid reader receipt body/identity")
            body_keys = {"mutationId", "deviceId", "counter", "entityType", "entityId", "baseRevision", "operation"}
            # The protocol is part of the original canonical bytes, not an
            # optional backup annotation. Device streams cannot switch versions.
            # Legacy receipts omit the field; every v2 receipt must retain the
            # exact integer 2 accepted by normalizeReaderMutation on the server.
            protocol = devices[key]["protocol_version"] if modern else 1
            if protocol == 2:
                if type(body.get("protocolVersion")) is not int or body["protocolVersion"] != 2:
                    fail("Reader receipt protocol differs from its bound device")
                body_keys.add("protocolVersion")
            elif "protocolVersion" in body:
                fail("Legacy reader receipt cannot declare a newer device protocol")
            if body["operation"] == "upsert":
                body_keys.add("payload")
                validate_reader_payload(body["entityType"], body["entityId"], body.get("payload"), books_root, books, cache)
            canonical_body = row.get("canonical_body")
            # Hash the exact original JS bytes. Re-encoding a JSONB float in
            # Python/Postgres is not equivalent to JSON.stringify (e.g. 1e-7).
            if not isinstance(canonical_body, str) or len(canonical_body.encode("utf-8")) > 128 * 1024 or json.loads(canonical_body) != body:
                fail("Reader canonical receipt bytes differ from its JSON body")
            if set(body) != body_keys or body["entityType"] == "catalog" and body["entityId"] != READER_CATALOG_ID or hashlib.sha256(canonical_body.encode("utf-8")).hexdigest() != row["body_sha256"]:
                fail("Reader receipt body digest/shape differs")
            if not isinstance(result, dict) or result.get("mutationId") != row["mutation_id"] or result.get("status") not in ("accepted", "conflict"):
                fail("Invalid reader receipt result")
            entity_key = (profile, body["entityType"], body["entityId"])
            if modern and (row["entity_type"] != body["entityType"] or row["entity_id"] != body["entityId"] or (result["status"] == "accepted" and (not reader_integer(row.get("accepted_revision"), 1, 2147483647) or row["accepted_revision"] != body["baseRevision"] + 1 or entity_key not in entities or not entities[entity_key]["modern_write"])) or (result["status"] == "conflict" and row.get("accepted_revision") is not None)):
                fail("Reader receipt typed identity differs from its complete body")
            if result["status"] == "accepted":
                if set(result) != {"mutationId", "status", "entity"} or entity_key not in entities:
                    fail("Accepted reader receipt lacks its own entity")
                entity = public_record(result["entity"])
                if entity["entityType"] != body["entityType"] or entity["entityId"] != body["entityId"] or entity["revision"] != body["baseRevision"] + 1 or entity["revision"] > entities[entity_key]["revision"] or entity["deleted"] != (body["operation"] == "delete") or body["operation"] == "upsert" and entity["payload"] != body["payload"]:
                    fail("Reader receipt result differs from its accepted mutation")
            else:
                if set(result) != {"mutationId", "status", "code", "current", "proposed"} or result["code"] != "REVISION_CONFLICT" or result["proposed"] != body:
                    fail("Invalid durable reader conflict")
                current = public_record(result["current"]) if result["current"] is not None else None
                if current and (current["entityType"] != body["entityType"] or current["entityId"] != body["entityId"] or entity_key not in entities or current["revision"] > entities[entity_key]["revision"]) or body["baseRevision"] == (current["revision"] if current else 0):
                    fail("Reader conflict belongs to another entity/revision")
            mutation_ids.add(identity)
            receipt_counters[key] = counter
            receipt_counts[key] = receipt_counts.get(key, 0) + 1
        else:
            key = (profile, row.get("entity_type"), row.get("entity_id"))
            revision = row.get("change_revision")
            if key not in entities or not reader_integer(revision, heads[profile]["min_revision"] + 1, heads[profile]["revision"]) or revision != change_counters.get(profile, heads[profile]["min_revision"]) + 1:
                fail("Broken reader change cursor/entity relationship")
            entity = public_record(row.get("record"))
            if entity["entityType"] != key[1] or entity["entityId"] != key[2] or entity["revision"] > entities[key]["revision"] or entity["revision"] <= change_entity_revisions.get(key, 0):
                fail("Reader change record belongs to another entity/revision")
            if entity["revision"] == entities[key]["revision"] and (entity["deleted"] != entities[key]["deleted"] or entity["payload"] != entities[key]["payload"]):
                fail("Latest reader change differs from current entity")
            change_counters[profile] = revision
            change_entity_revisions[key] = entity["revision"]
    if any(max(receipt_counters.get(key, 0), row.get("compacted_through", 0)) != row["last_counter"] or receipt_counts.get(key, 0) + row.get("compacted_accepted", 0) != row["last_counter"] for key, row in devices.items()) or any(change_counters.get(profile, row["min_revision"]) != row["revision"] for profile, row in heads.items()):
        fail("Reader cursor/device history is incomplete")
    if modern and sum(counts.values()) != budget["rows"]:
        fail("Reader metadata row count differs from the accounted source budget")
    if modern:
        empty["readerPrunedAcceptedChecked"] = sum(row["compacted_accepted"] for row in devices.values())
    if expected_tables is not None:
        for name in READER_TABLES:
            if name not in expected_tables or counts[name] != expected_tables[name]["count"]:
                fail("Reader metadata count differs from fingerprint baseline: " + name)
    empty.update({"readerProfilesChecked": counts["reader_profiles"], "readerDevicesChecked": counts["reader_devices"],
                  "readerEntitiesChecked": counts["reader_entities"], "readerReceiptsChecked": counts["reader_mutations"], "readerChangesChecked": counts["reader_changes"]})
    return empty


def chapter_fingerprint(book, index=0):
    assets = book["assets"]
    def normalized(value):
        if isinstance(value, list):
            return [normalized(item) for item in value]
        if isinstance(value, dict):
            return {key: "sha256:" + hashlib.sha256(base64.b64decode(assets[item], validate=True)).hexdigest()
                    if key in ("asset", "resource") and isinstance(item, str) and item in assets else normalized(item)
                    for key, item in value.items()}
        return value
    value = {"chapter": book["chapters"][index], "structure": book.get("structure", {}).get("chapters", [None] * len(book["chapters"]))[index]}
    return hashlib.sha256(canonical_json(normalized(value)).encode("utf-8")).hexdigest()


def checkpoint_png(raw):
    if not raw.startswith(PNG): fail("Invalid sanitized checkpoint PNG")
    offset, chunks, width, height, channels, compressed, ended = 8, 0, 0, 0, 0, [], False
    while offset < len(raw):
        if offset + 12 > len(raw) or chunks >= 10000: fail("Invalid checkpoint PNG framing")
        length = struct.unpack(">I", raw[offset:offset+4])[0]
        kind = raw[offset+4:offset+8]; end = offset + 12 + length
        if end > len(raw): fail("Truncated checkpoint PNG")
        data = raw[offset+8:end-4]
        if zlib.crc32(kind + data) & 0xffffffff != struct.unpack(">I", raw[end-4:end])[0]: fail("Checkpoint PNG CRC differs")
        if chunks == 0:
            if kind != b"IHDR" or length != 13: fail("Invalid checkpoint PNG header")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", data)
            if not 1 <= width <= 1800 or not 1 <= height <= 2400 or depth != 8 or color not in (2, 6) or compression or filtering or interlace: fail("Checkpoint PNG is not a bounded reencoded raster")
            channels = 3 if color == 2 else 4
        elif kind == b"IDAT":
            compressed.append(data)
        elif kind == b"IEND":
            if length or end != len(raw) or not compressed: fail("Invalid checkpoint PNG end")
            ended = True
        else: fail("Unexpected metadata/active payload in sanitized PNG")
        chunks += 1; offset = end
    if not ended: fail("Incomplete checkpoint PNG")
    expected = height * (1 + width * channels); count = 0; decoder = zlib.decompressobj()
    try:
        for block in compressed:
            pending = block
            while pending:
                decoded = decoder.decompress(pending, 1024**2)
                stride = 1 + width * channels
                first_filter = (-count) % stride
                if any(decoded[i] > 4 for i in range(first_filter, len(decoded), stride)): fail("Invalid checkpoint PNG row filter")
                count += len(decoded)
                if count > expected or decoder.unused_data: fail("Checkpoint PNG inflated budget exceeded")
                pending = decoder.unconsumed_tail
        if not decoder.eof or count != expected: fail("Invalid checkpoint PNG raster stream")
    except zlib.error:
        fail("Invalid checkpoint PNG compressed raster")


def validate_derivation_metadata(value):
    keys = {"schemaVersion", "kind", "quality", "sourceSha256", "recipeSha256", "jobId"}
    if not isinstance(value, dict) or set(value) != keys or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1 or value.get("kind") != "machine-translation" or value.get("quality") != "machine-draft" or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", str(value.get("jobId", ""))) or any(not re.fullmatch(r"[a-f0-9]{64}", str(value.get(key, ""))) for key in ("sourceSha256", "recipeSha256")):
        fail("Invalid inert derivation metadata")
    return value


def validate_checkpoint_book(book):
    def exact(value, keys):
        return isinstance(value, dict) and set(value).issubset(keys)
    def string(value, limit):
        return isinstance(value, str) and len(value.encode("utf-8")) <= limit * 4 and len(value.encode("utf-16-le")) // 2 <= limit
    if not exact(book, {"title", "author", "language", "chapters", "assets", "structure", "sourceMetadata", "derivation"}) or not string(book.get("title"), 300) or not book["title"] or not string(book.get("author"), 300) or not string(book.get("language"), 30) or not isinstance(book.get("chapters"), list) or len(book["chapters"]) != 1 or not isinstance(book.get("assets"), dict) or len(book["assets"]) > 200:
        fail("Invalid sanitized Ranobe checkpoint book")
    if "derivation" in book:
        validate_derivation_metadata(book["derivation"])
    total = 0
    for name, encoded in book["assets"].items():
        if not ASSET.fullmatch(name) or not isinstance(encoded, str) or len(encoded) > 16 * 1024**2:
            fail("Invalid sanitized checkpoint image")
        raw = base64.b64decode(encoded, validate=True)
        total += len(raw)
        if base64.b64encode(raw).decode() != encoded or not raw.startswith(PNG) or total > 20 * 1024**2:
            fail("Invalid sanitized checkpoint PNG/budget")
        checkpoint_png(raw)
    chapter = book["chapters"][0]
    if not exact(chapter, {"title", "blocks"}) or not string(chapter.get("title"), 300) or not isinstance(chapter.get("blocks"), list) or not 1 <= len(chapter["blocks"]) <= 30000:
        fail("Invalid sanitized checkpoint chapter")
    for block in chapter["blocks"]:
        if not isinstance(block, dict) or block.get("type") not in ("text", "heading", "image"):
            fail("Active/unsupported checkpoint block")
        if block["type"] == "image":
            if not exact(block, {"type", "text", "asset"}) or block.get("asset") not in book["assets"] or not string(block.get("text"), 500):
                fail("Invalid sanitized checkpoint image reference")
        elif not exact(block, {"type", "text"}) or not string(block.get("text"), 100000):
            fail("Invalid sanitized checkpoint text")
    structure = book.get("structure")
    if structure is not None:
        kinds = {"paragraph", "heading", "quote", "verse", "list", "table", "image", "footnote", "ruby"}
        identifier = lambda value: isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}", value)
        if not exact(structure, {"schemaVersion", "chapters", "warnings"}) or structure.get("schemaVersion") != 2 or not isinstance(structure.get("chapters"), list) or len(structure["chapters"]) != 1 or not isinstance(structure.get("warnings"), list) or len(structure["warnings"]) > 100 or any(not string(w, 120) for w in structure["warnings"]):
            fail("Invalid checkpoint rich structure")
        rich = structure["chapters"][0]
        if not exact(rich, {"id", "revision", "title", "blocks"}) or not identifier(rich.get("id")) or rich.get("revision") != 1 or not string(rich.get("title"), 300) or not isinstance(rich.get("blocks"), list) or not 1 <= len(rich["blocks"]) <= 30000:
            fail("Invalid checkpoint rich chapter")
        seen, references, text_total = set(), [], 0
        for block in rich["blocks"]:
            if not exact(block, {"id", "type", "text", "resource", "referenceId", "direction", "spans", "rows", "level"}) or not identifier(block.get("id")) or block["id"] in seen or block.get("type") not in kinds or not string(block.get("text"), 100000):
                fail("Invalid checkpoint rich block")
            seen.add(block["id"]); text_total += len(block["text"].encode("utf-16-le")) // 2
            if text_total > 12 * 1024**2 or ("direction" in block and block["direction"] not in ("ltr", "rtl", "auto")) or ("level" in block and (type(block["level"]) is not int or not 1 <= block["level"] <= 6 or block["type"] != "heading")):
                fail("Invalid checkpoint rich text budget/attributes")
            if (block["type"] == "image" and block.get("resource") not in book["assets"]) or (block["type"] != "image" and "resource" in block):
                fail("Invalid checkpoint rich resource")
            if "referenceId" in block:
                if not identifier(block["referenceId"]): fail("Invalid checkpoint internal reference")
                references.append(block["referenceId"])
            if "rows" in block and (block["type"] != "table" or not isinstance(block["rows"], list) or len(block["rows"]) > 1000 or any(not isinstance(row, list) or not 1 <= len(row) <= 100 or any(not string(cell, 10000) for cell in row) for row in block["rows"])):
                fail("Invalid checkpoint table")
            if "spans" in block:
                if not isinstance(block["spans"], list) or len(block["spans"]) > 2000: fail("Invalid checkpoint inline spans")
                units = len(block["text"].encode("utf-16-le")) // 2
                for span in block["spans"]:
                    if not exact(span, {"start", "end", "kind", "target"}) or type(span.get("start")) is not int or type(span.get("end")) is not int or not 0 <= span["start"] < span["end"] <= units or span.get("kind") not in ("emphasis", "strong", "code", "link", "superscript", "subscript"):
                        fail("Invalid checkpoint inline span")
                    if span["kind"] == "link":
                        if not identifier(span.get("target")): fail("External checkpoint link")
                        references.append(span["target"])
                    elif "target" in span: fail("Unexpected checkpoint span target")
        if any(ref not in seen for ref in references): fail("Dangling checkpoint internal reference")
    if "sourceMetadata" in book:
        meta = book["sourceMetadata"]
        if not isinstance(meta, dict) or set(meta) != {"schemaVersion", "format", "provenance", "title", "authors", "languages", "identifiers"} or meta.get("schemaVersion") != 1 or meta.get("format") not in ("epub", "txt") or meta.get("provenance") != ("opf" if meta.get("format") == "epub" else "gutenberg-txt-header") or not string(meta.get("title"), 300):
            fail("Invalid checkpoint source metadata")
        for key, count, length in (("authors", 16, 200), ("languages", 16, 30), ("identifiers", 32, 500)):
            if not isinstance(meta.get(key), list) or len(meta[key]) > count or any(not string(item, length) for item in meta[key]): fail("Invalid checkpoint source metadata list")
    return len(canonical_json(book).encode("utf-8")), chapter_fingerprint(book)


def checkpoint_records(path, chapters):
    wanted = {identity: row for identity, row in chapters.items() if row.get("prepared_present") is True}
    if path is None or not Path(path).is_file():
        if wanted: fail("Sanitized checkpoint sidecar is missing")
        return 0
    path = Path(path)
    if linked(path) or path.stat().st_size > 96 * 1024**2: fail("Checkpoint sidecar exceeds bounded regular-file budget")
    seen, prepared_total = set(), 0
    with path.open("rb") as stream:
        while raw := stream.readline(22 * 1024**2 + 1):
            if len(raw) > 22 * 1024**2 or not raw.endswith(b"\n"): fail("Checkpoint sidecar record is oversized/incomplete")
            line = raw.decode("utf-8")
            value = json.loads(line)
            if not isinstance(value, dict) or set(value) != {"id", "prepared_book"} or value["id"] not in wanted or value["id"] in seen: fail("Unexpected/duplicate checkpoint sidecar record")
            row = wanted[value["id"]]
            match = re.search(r'"prepared_book"\s*:\s*', line)
            if not match: fail("Missing checkpoint blob")
            book, end = json.JSONDecoder().raw_decode(line, match.end())
            serialized = line[match.end():end].encode("utf-8")
            if len(serialized) != row.get("prepared_json_bytes") or hashlib.sha256(serialized).hexdigest() != row.get("prepared_json_sha256"): fail("Checkpoint JSON hash/size differs")
            size, fingerprint = validate_checkpoint_book(book)
            if size != row.get("prepared_bytes") or fingerprint != row.get("content_sha256"): fail("Checkpoint semantic hash/size differs")
            prepared_total += size
            if prepared_total > 64 * 1024**2: fail("Sanitized checkpoint cache exceeds 64 MiB")
            seen.add(value["id"])
    if seen != set(wanted): fail("Checkpoint sidecar omitted sanitized books")
    return len(seen)


def ranobe_publication(books_root, row):
    path = safe_path(books_root, row["id"] + "/book.json")
    raw = path.read_bytes()
    if len(raw) > MAX_JSON or len(raw) != row.get("content_bytes") or hashlib.sha256(raw).hexdigest() != row.get("content_sha256"):
        fail("Ranobe publication content hash/size differs")
    book = json.loads(raw)
    artifact = row.get("artifact_manifest", {})
    files = artifact.get("files")
    if artifact.get("schemaVersion") != 1 or not isinstance(files, list): fail("Invalid Ranobe artifact manifest")
    normalized = {"schemaVersion": 1, "files": sorted(({key: item[key] for key in ("path", "bytes", "sha256")} for item in files), key=lambda item: item["path"])}
    if hashlib.sha256(json.dumps(normalized, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest() != row.get("package_sha256"):
        fail("Ranobe publication package hash differs")
    structure = book.get("structure")
    if structure is None:
        structure = {"chapters": [{"id": f"c-{c}", "revision": 1, "title": chapter["title"], "blocks": [
            {"id": f"c-{c}-b-{b}", "type": "paragraph" if block["type"] == "text" else block["type"], "text": block["text"],
             **({"resource": block["asset"]} if block["type"] == "image" else {})} for b, block in enumerate(chapter["blocks"])]} for c, chapter in enumerate(book["chapters"])]}
    order = []
    for chapter in structure["chapters"]:
        public = {**chapter, "title": chapter["title"][:250], "blocks": [{**block, **({"resource": "assets/" + block["resource"]} if block["type"] == "image" else {})} for block in chapter["blocks"]]}
        data = canonical_json(public).encode()
        order.append({"chapterId": chapter["id"], "path": "chapters/" + chapter["id"] + ".json", "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "mediaType": "application/json"})
    resources = []
    for name, data in sorted(book["assets"].items()):
        decoded = base64.b64decode(data, validate=True)
        resources.append({"path": "assets/" + name, "sha256": hashlib.sha256(decoded).hexdigest(), "bytes": len(decoded), "mediaType": "image/png"})
    manifest = {"schemaVersion": 2, "id": row["id"], "revision": 1, "workId": row.get("work_id"), "expressionId": row.get("expression_id"), "editionId": row.get("edition_id"),
                "title": book["title"][:250], "language": book["language"] if re.fullmatch(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*", book["language"]) else "und", "readingOrder": order, "resources": resources}
    if manifest != row.get("publication_manifest") or hashlib.sha256(canonical_json(manifest).encode()).hexdigest() != row.get("publication_sha256"):
        fail("Ranobe immutable publication manifest/hash differs")
    return book


RANOBE_TABLES = ("ranobe_feeds", "ranobe_feed_requests", "ranobe_runs", "ranobe_chapters", "ranobe_run_chapters", "ranobe_run_parts", "ranobe_scratch")


def ranobe_metadata(path):
    if path is None or not Path(path).is_file(): fail("Ranobe source metadata sidecar is missing")
    path = Path(path)
    if linked(path) or path.stat().st_size > 256 * 1024**2: fail("Ranobe metadata exceeds bounded regular-file budget")
    tables = {name: [] for name in RANOBE_TABLES}
    count = 0
    with path.open("rb") as stream:
        while raw := stream.readline(1024**2 + 1):
            if len(raw) > 1024**2 or not raw.endswith(b"\n"): fail("Ranobe metadata record is oversized/incomplete")
            value = json.loads(raw.decode("utf-8"))
            if not isinstance(value, dict) or set(value) != {"table", "row"} or value["table"] not in tables or not isinstance(value["row"], dict): fail("Unexpected Ranobe metadata table/record")
            if value["table"] == "ranobe_chapters" and "prepared_book" in value["row"]: fail("Prepared blob is forbidden in metadata sidecar")
            tables[value["table"]].append(value["row"])
            count += 1
            if count > 500000: fail("Ranobe metadata exceeds bounded row budget")
    return tables


def validate_ranobe(books_root, inventory, profiles, imports, books, checkpoint_path=None, metadata_path=None, expected_tables=None):
    tables = inventory["tables"]
    names = RANOBE_TABLES
    if not inventory.get("ranobeSupported"):
        if any(tables.get(name) for name in names): fail("Unmarked Ranobe snapshot tables")
        if expected_tables is not None and any(name in expected_tables for name in names): fail("Ranobe support flag omits fingerprinted tables")
        return {}
    if inventory.get("ranobeMetadataFormat") == "source-jsonl-v1":
        if any(name in tables for name in names): fail("Main inventory must not embed source-sidecar metadata")
        if metadata_path is None and checkpoint_path is not None: metadata_path = Path(checkpoint_path).with_name("ranobe-metadata.jsonl")
        tables = {**tables, **ranobe_metadata(metadata_path)}
    if any(not isinstance(tables.get(name), list) for name in names): fail("Ranobe snapshot inventory is incomplete")
    if expected_tables is not None:
        for name in names:
            if name not in expected_tables or len(tables[name]) != expected_tables[name]["count"]: fail("Ranobe metadata row count differs from fingerprint baseline: " + name)
    feeds, requests, runs, chapters, parts = [rows_by_id(tables[name], name) for name in (names[0], names[1], names[2], names[3], names[5])]
    maps = {}
    for row in tables["ranobe_run_chapters"]:
        if not isinstance(row, dict) or row.get("run_id") not in runs or row.get("feed_id") != runs[row["run_id"]]["feed_id"] or type(row.get("ordinal")) is not int:
            fail("Broken Ranobe chapter/run/feed relationship")
        maps.setdefault(row["run_id"], []).append(row)
    for feed in feeds.values():
        if feed.get("provider") != "ranobelib" or not re.fullmatch(r"[0-9]{1,20}", str(feed.get("remote_id", ""))) or not re.fullmatch(r"default|[0-9]{1,20}", str(feed.get("branch_key", ""))) or not str(feed.get("slug", "")).startswith(feed["remote_id"] + "--") or feed.get("requested_by") not in profiles or (feed.get("approved_by") is not None and feed["approved_by"] not in profiles):
            fail("Invalid Ranobe feed identity/provenance")
        if feed.get("head_run_id") is not None and (feed["head_run_id"] not in runs or runs[feed["head_run_id"]]["feed_id"] != feed["id"] or runs[feed["head_run_id"]]["status"] != "ready"):
            fail("Dangling/nonready Ranobe head")
        if feed.get("active_import_id") is not None and feed["active_import_id"] not in imports: fail("Dangling Ranobe active import")
    for run in runs.values():
        if run.get("feed_id") not in feeds or run.get("import_id") not in imports or run.get("status") not in ("building", "ready", "abandoned") or (run["status"] == "ready") != (run.get("activated_at") is not None): fail("Broken Ranobe run identity/state")
        feed, job = feeds[run["feed_id"]], imports[run["import_id"]]
        options = job.get("options", {})
        branch = "default" if options.get("branch") is None else str(options["branch"])
        if job.get("kind") != "ranobe" or options.get("mode") != "full" or options.get("feedId") != feed["id"] or branch != feed["branch_key"] or options.get("language") != feed["language"]: fail("Ranobe parent import branch/feed mismatch")
        if run.get("previous_head_id") is not None and (run["previous_head_id"] not in runs or runs[run["previous_head_id"]]["feed_id"] != feed["id"] or runs[run["previous_head_id"]]["status"] != "ready"): fail("Broken Ranobe previous head")
        ordered = sorted(maps.get(run["id"], []), key=lambda row: row["ordinal"])
        if type(run.get("chapter_count")) is not int or not 1 <= run["chapter_count"] <= 20000 or len(ordered) != run["chapter_count"] or [row["ordinal"] for row in ordered] != list(range(run["chapter_count"])) or len({row.get("source_key") for row in ordered}) != len(ordered): fail("Incomplete/duplicate Ranobe inventory")
        source = []
        for row in ordered:
            metadata = row.get("metadata")
            if not isinstance(metadata, dict) or set(metadata) != {"title", "volume", "number"} or any(not isinstance(v, str) for v in metadata.values()): fail("Invalid Ranobe inventory metadata")
            source.append({"key": row["source_key"], "revisionHint": row["revision_hint"], **metadata})
            cached = chapters.get(row.get("chapter_id"))
            if row.get("chapter_id") is not None and (cached is None or cached["feed_id"] != feed["id"] or cached["source_key"] != row["source_key"] or cached["revision_hint"] != row["revision_hint"] or cached["policy_version"] != run["policy_version"]): fail("Ranobe checkpoint branch/source mismatch")
            if run["status"] == "ready" and cached is None: fail("Ready Ranobe run has an unprepared chapter")
        if hashlib.sha256(canonical_json(source).encode()).hexdigest() != run.get("inventory_sha256"): fail("Ranobe inventory hash differs")
        maps[run["id"]] = ordered
    pointers = {}
    for cached in chapters.values():
        if cached.get("feed_id") not in feeds or not SHA.fullmatch(str(cached.get("raw_sha256", ""))) or not SHA.fullmatch(str(cached.get("content_sha256", ""))) or type(cached.get("prepared_bytes")) is not int or not 1 <= cached["prepared_bytes"] <= 20 * 1024**2: fail("Invalid Ranobe checkpoint metadata")
        if cached.get("prepared_present") is True:
            if cached.get("book_id") is not None or cached.get("chapter_index") is not None or not SHA.fullmatch(str(cached.get("prepared_json_sha256", ""))): fail("Invalid prepared Ranobe checkpoint pointer")
        elif cached.get("prepared_present") is False:
            book = books.get(cached.get("book_id")); index = cached.get("chapter_index")
            if not book or book.get("security_state") != "passed" or not book.get("artifact_manifest") or not book.get("publication_manifest") or type(index) is not int or not 0 <= index < book["chapter_count"]: fail("Dangling/blocked Ranobe published checkpoint")
            pointers.setdefault(book["id"], []).append(cached)
        else: fail("Unknown Ranobe checkpoint storage state")
    validated_publications = {}
    def publication_fingerprints(book_id):
        if book_id not in validated_publications:
            content = ranobe_publication(books_root, books[book_id])
            validated_publications[book_id] = [chapter_fingerprint(content, i) for i in range(len(content["chapters"]))]
        return validated_publications[book_id]
    for book_id, references in pointers.items():
        fingerprints = publication_fingerprints(book_id)
        for row in references:
            if fingerprints[row["chapter_index"]] != row["content_sha256"]: fail("Published Ranobe chapter semantic hash differs")
    run_parts = {}
    for part in parts.values():
        run = runs.get(part.get("run_id")); keys = part.get("source_keys"); child = imports.get(part.get("import_id"))
        if not run or not child or not isinstance(keys, list) or not 1 <= len(keys) <= 50 or any(not isinstance(key, str) for key in keys) or len(set(keys)) != len(keys) or hashlib.sha256(canonical_json(keys).encode()).hexdigest() != part.get("keys_sha256"): fail("Invalid Ranobe part keys/hash/provenance")
        metadata = child.get("options", {}).get("ranobePart", {})
        if child.get("kind") != "ranobe-part" or metadata.get("parentId") != run["import_id"] or metadata.get("runId") != run["id"] or metadata.get("keys") != keys or child.get("requested_by") != imports[run["import_id"]]["requested_by"]: fail("Ranobe child import branch/run mismatch")
        ordinal = part.get("ordinal"); ordered = maps[run["id"]]
        if type(ordinal) is not int or ordinal < 0 or [row["source_key"] for row in ordered[ordinal:ordinal+len(keys)]] != keys: fail("Ranobe part range differs from snapshot")
        if part.get("status") == "ready":
            book = books.get(part.get("book_id"))
            if not book or book.get("security_state") != "passed" or not book.get("artifact_manifest") or not book.get("publication_manifest") or book.get("package_sha256") != part.get("package_sha256") or child.get("status") != "completed" or child.get("book_id") != book["id"] or book["chapter_count"] != len(keys): fail("Dangling/blocked/hash-mismatched Ranobe part")
            fingerprints = publication_fingerprints(book["id"])
            if any(chapters.get(ordered[ordinal+i].get("chapter_id"), {}).get("content_sha256") != fingerprints[i] for i in range(len(keys))): fail("Ranobe part contents differ from selected chapters")
        elif part.get("status") != "building" or part.get("book_id") is not None or part.get("package_sha256") is not None: fail("Invalid Ranobe building part")
        run_parts.setdefault(run["id"], []).append(part)
    for run in runs.values():
        covered = set()
        for part in sorted(run_parts.get(run["id"], []), key=lambda row: row["ordinal"]):
            interval = set(range(part["ordinal"], part["ordinal"] + len(part["source_keys"])))
            if covered & interval: fail("Overlapping Ranobe parts")
            covered |= interval
            if run["status"] == "ready" and part["status"] != "ready": fail("Ready Ranobe head contains building part")
        if run["status"] == "ready" and covered != set(range(run["chapter_count"])): fail("Ready Ranobe snapshot lacks readable parts")
    for request in requests.values():
        if request.get("feed_id") not in feeds or request.get("profile_id") not in profiles or request.get("import_id") not in imports or imports[request["import_id"]].get("options", {}).get("feedId") != request["feed_id"]: fail("Broken Ranobe request/initiator relationship")
        job, feed = imports[request["import_id"]], feeds[request["feed_id"]]
        result_id = request.get("result_run_id")
        if result_id is None and "result_run_id" not in request and job.get("status") == "completed":
            # Old 005 snapshots predate the explicit result pointer. Their
            # original parent import identifies the completed snapshot.
            legacy = [run for run in runs.values() if run["import_id"] == job["id"] and run["feed_id"] == feed["id"] and run["status"] == "ready"]
            if len(legacy) == 1: result_id = legacy[0]["id"]
        if result_id is not None:
            result = runs.get(result_id); options = job.get("options", {})
            branch = "default" if options.get("branch") is None else str(options["branch"])
            if not result or result["feed_id"] != feed["id"] or result["status"] != "ready" or job.get("status") != "completed" or job.get("security_state") != "passed" or job.get("kind") != "ranobe" or options.get("mode") != "full" or branch != feed["branch_key"] or options.get("language") != feed["language"]:
                fail("Invalid Ranobe request result snapshot/branch/state")
            result_parts = sorted(run_parts.get(result_id, []), key=lambda row: row["ordinal"])
            if not result_parts or job.get("book_id") != result_parts[0]["book_id"]: fail("Ranobe request result publication differs")
        elif job.get("status") == "completed":
            fail("Completed Ranobe request lacks a ready result snapshot")
    scratch_ids = set()
    for scratch in tables["ranobe_scratch"]:
        if not isinstance(scratch, dict) or not UUID.fullmatch(str(scratch.get("token", ""))) or scratch["token"] in scratch_ids or scratch.get("run_id") not in runs or scratch.get("parent_import_id") != runs[scratch["run_id"]]["import_id"] or scratch.get("source_key") not in {row["source_key"] for row in maps[scratch["run_id"]]}: fail("Broken Ranobe raw scratch provenance")
        scratch_ids.add(scratch["token"])
    prepared = checkpoint_records(checkpoint_path, chapters)
    return {"ranobeFeedsChecked": len(feeds), "ranobeRunsChecked": len(runs), "ranobePartsChecked": len(parts), "ranobeCheckpointsChecked": len(chapters), "ranobePreparedBlobsChecked": prepared, "ranobeScratchMetadataChecked": len(scratch_ids)}


def validate_library(books_root, inventory, checkpoint_path=None, metadata_path=None, expected_tables=None):
    tables = inventory.get("tables", {})
    profiles = rows_by_id(tables.get("profiles"), "profiles")
    imports = rows_by_id(tables.get("imports"), "imports")
    books = rows_by_id(tables.get("books"), "books")
    all_files = files_under(books_root)
    chapters_opened = assets_checked = historical_import_links = 0
    for row in imports.values():
        if row.get("requested_by") not in profiles or (row.get("approved_by") is not None and row["approved_by"] not in profiles):
            fail("Broken import/profile relationship")
        if row.get("book_id") is not None and row["book_id"] not in books:
            # Old imports retain historical IDs after deletion; this is not an FK.
            historical_import_links += 1
    for identity, row in books.items():
        if row.get("requested_by") not in profiles or row.get("import_id") not in imports:
            fail("Broken book provenance relationship")
        content_path = safe_path(books_root, identity + "/book.json")
        content = read_json(content_path)
        if "derivation" in content:
            validate_derivation_metadata(content["derivation"])
        chapters, assets = content.get("chapters"), content.get("assets")
        if not isinstance(content.get("title"), str) or not isinstance(chapters, list) or not chapters or len(chapters) != row.get("chapter_count") or not isinstance(assets, dict):
            fail("Book cannot be opened or chapter inventory differs")
        actual = file_record(content_path)
        if row.get("content_sha256") is not None and row["content_sha256"].lower() != actual["sha256"]:
            fail("Published book content hash differs")
        if row.get("content_bytes") is not None and row["content_bytes"] != actual["bytes"]:
            fail("Published book content size differs")
        expected_names = {"book.json"}
        for name, encoded in assets.items():
            if not ASSET.fullmatch(name) or not isinstance(encoded, str):
                fail("Invalid image reference")
            raw = base64.b64decode(encoded, validate=True)
            if not raw.startswith(PNG) or len(raw) > 20 * 1024 * 1024:
                fail("Invalid prepared image")
            image = safe_path(books_root, identity + "/" + name)
            if not image.is_file() or image.read_bytes() != raw:
                fail("Prepared image bytes differ from book package")
            expected_names.add(name)
            assets_checked += 1
        for chapter in chapters:
            if not isinstance(chapter, dict) or not isinstance(chapter.get("title"), str) or not isinstance(chapter.get("blocks"), list) or not chapter["blocks"]:
                fail("Invalid chapter structure")
            for block in chapter["blocks"]:
                if not isinstance(block, dict) or not isinstance(block.get("type"), str):
                    fail("Invalid inert content block")
                if block["type"] not in ("text", "paragraph", "heading", "image") or not isinstance(block.get("text"), str):
                    fail("Unsupported or unreadable inert content block")
                if block["type"] == "image" and block.get("asset") not in assets:
                    fail("Chapter references a missing image")
            chapters_opened += 1
        actual_names = {name.split("/", 1)[1] for name in all_files if name.startswith(identity + "/")}
        if actual_names != expected_names:
            fail("Unexpected or missing published book files")
        artifact = row.get("artifact_manifest")
        if artifact is not None:
            entries = artifact.get("files") if isinstance(artifact, dict) and artifact.get("schemaVersion") == 1 else None
            if not isinstance(entries, list):
                fail("Unsupported publication artifact manifest")
            seen = set()
            for entry in entries:
                name = relative_name(entry.get("path"))
                if name in seen or name not in expected_names:
                    fail("Invalid publication artifact member")
                seen.add(name)
                metadata = file_record(safe_path(books_root, identity + "/" + name))
                if metadata["bytes"] != entry.get("bytes") or metadata["sha256"] != str(entry.get("sha256", "")).lower():
                    fail("Publication artifact hash/size differs")
            if seen != expected_names:
                fail("Publication artifact manifest omits resources")
    checked_positions = 0
    for name in ("reading", "bookmarks"):
        for row in tables.get(name, []):
            book = books.get(row.get("book_id"))
            position = row.get("position")
            if row.get("profile_id") not in profiles or book is None or type(row.get("chapter")) is not int or not 0 <= row["chapter"] < book["chapter_count"]:
                fail("Broken reading/bookmark relationship or chapter")
            if type(position) not in (int, float) or not math.isfinite(position) or not 0 <= position <= 1:
                fail("Invalid reading/bookmark position")
            if name == "bookmarks" and not isinstance(row.get("note"), str):
                fail("Bookmark note was not restored")
            checked_positions += 1
    catalog_count = catalog_items = missing_server_entries = 0
    for row in tables.get("profile_catalogs", []):
        if row.get("profile_id") not in profiles or not isinstance(row.get("catalogs"), list):
            fail("Broken catalogue/profile relationship")
        catalogs = rows_by_id(row["catalogs"], "catalogs")
        for identity, catalog in catalogs.items():
            parent, seen = catalog.get("parent"), {identity}
            while parent:
                if parent in seen or parent not in catalogs:
                    fail("Broken/cyclic catalogue hierarchy")
                seen.add(parent)
                parent = catalogs[parent].get("parent")
            if not isinstance(catalog.get("title"), str) or not isinstance(catalog.get("items"), list):
                fail("Invalid catalogue content")
            for item in catalog["items"]:
                if not isinstance(item, dict) or item.get("scope") not in ("device", "server") or not UUID.fullmatch(str(item.get("id", ""))) or not isinstance(item.get("title"), str) or not isinstance(item.get("author"), str):
                    fail("Invalid catalogue book reference")
                missing_server_entries += item["scope"] == "server" and item["id"] not in books
                catalog_items += 1
            catalog_count += 1
    orphan_folders = {name.split("/", 1)[0] for name in all_files} - set(books)
    return {"books": len(books), "chaptersOpened": chapters_opened, "assetsChecked": assets_checked,
            "readingAndBookmarksChecked": checked_positions, "catalogsChecked": catalog_count,
            "catalogItemsChecked": catalog_items, "unavailableCatalogReferences": missing_server_entries,
            "historicalImportBookReferences": historical_import_links,
            "orphanBookFoldersPreserved": len(orphan_folders), **validate_ranobe(books_root, inventory, profiles, imports, books, checkpoint_path, metadata_path, expected_tables)}


DERIVED_TABLES = ("derived_recipes", "derived_sources", "derived_source_parts", "derived_jobs", "derived_requests",
                  "derived_idempotency", "derived_attempts", "derived_checkpoints", "derived_results")
DERIVED_METADATA_TABLES = DERIVED_TABLES + ("works", "expressions", "editions")
DERIVED_MAX_FILE = 24 * 1024**2


def derived_metadata(path):
    if path is None or not Path(path).is_file() or Path(path).stat().st_size > 256 * 1024**2:
        fail("Missing/oversized derivative metadata sidecar")
    if linked(Path(path)):
        fail("Derivative metadata sidecar is not a regular unlinked file")
    tables = {name: [] for name in DERIVED_METADATA_TABLES}
    count = 0
    with Path(path).open("rb") as stream:
        while line := stream.readline(20 * 1024**2 + 1):
            count += 1
            if len(line) > 20 * 1024**2 or count > 500000 or not line.endswith(b"\n"):
                fail("Unbounded or incomplete derivative metadata record")
            value = json.loads(line.decode("utf-8"))
            if not isinstance(value, dict) or set(value) != {"table", "row"} or value["table"] not in tables or not isinstance(value["row"], dict):
                fail("Unexpected derivative metadata table/record")
            tables[value["table"]].append(value["row"])
    return tables


def derived_pcm(raw, pcm):
    # Match the server's two allowed chunks. Both orders are safe; metadata and
    # non-PCM encodings are not accepted, and every byte is accounted for.
    if len(raw) < 46 or len(raw) > 12 * 1024**2 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        fail("Invalid derivative canonical WAV")
    if struct.unpack_from("<I", raw, 4)[0] != len(raw) - 8:
        fail("Invalid derivative RIFF length")
    offset, fmt, data = 12, None, None
    while offset + 8 <= len(raw):
        name, size = raw[offset:offset + 4], struct.unpack_from("<I", raw, offset + 4)[0]
        start, end = offset + 8, offset + 8 + size
        if end > len(raw): fail("Truncated derivative WAV chunk")
        if name == b"fmt ":
            if fmt is not None or size != 16: fail("Invalid derivative PCM format chunk")
            fmt = struct.unpack_from("<HHIIHH", raw, start)
        elif name == b"data":
            if data is not None: fail("Duplicate derivative PCM data")
            data = memoryview(raw)[start:end]
        else:
            fail("Unexpected derivative WAV metadata")
        offset = end + size % 2
    if offset != len(raw) or fmt is None or data is None or not data:
        fail("Incomplete derivative WAV")
    encoding, channels, rate, byte_rate, align, bits = fmt
    if encoding != 1 or channels != 1 or bits != 16 or rate != 22050 or align != 2 or byte_rate != 44100 or len(data) % align:
        fail("Invalid derivative PCM dimensions/length")
    frames = len(data) // align
    if not rate * 0.1 <= frames <= rate * 180 or not isinstance(pcm, dict) or pcm.get("frames") != frames or pcm.get("sampleRate") != rate or pcm.get("channels") != channels or pcm.get("sampleWidth") != 2:
        fail("Derivative PCM manifest differs from frames")
    duration = pcm.get("durationSeconds")
    if type(duration) not in (int, float) or not math.isfinite(duration) or abs(duration - frames / rate) > 1e-6:
        fail("Derivative PCM duration differs")
    nonzero = clipped = 0
    for sample, in struct.iter_unpack("<h", data):
        nonzero += sample != 0
        clipped += abs(sample) >= 32760
    if not nonzero or clipped / frames > 0.02:
        fail("Silent or excessively clipped derivative audio")


PACKED_AUDIO_SEGMENTATION = "audio-unicode-ranges-v2"
DERIVED_WHITESPACE = "\t\n\v\f\r \u00a0\u1680" + "".join(chr(value) for value in range(0x2000, 0x200b)) + "\u2028\u2029\u202f\u205f\u3000\ufeff"


def derived_selection(source, books_root=None):
    """Independently bind a v2 range to the complete immutable source manifest.

    v1 has whole-source semantics forever. v2 retains all physical source parts;
    only its explicitly pinned, consecutive chapter coverage is generated.
    """
    manifest = source.get("manifest")
    if not isinstance(manifest, dict) or type(manifest.get("schemaVersion")) is not int:
        fail("Invalid derivative source selection version")
    if manifest["schemaVersion"] == 1:
        if "selection" in manifest:
            fail("Legacy derivative source cannot hide a chapter selection")
        return None
    if manifest["schemaVersion"] != 2 or set(manifest) != {"schemaVersion", "sourceLanguage", "workId", "expressionId", "snapshotId", "parts", "selection"}:
        fail("Invalid derivative source selection manifest")
    parts, selection = manifest.get("parts"), manifest.get("selection")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 20000 or not isinstance(selection, dict) or set(selection) != {"schemaVersion", "start", "count", "total", "chapters"}:
        fail("Invalid derivative chapter selection")
    offsets, total, identities = [], 0, set()
    for ordinal, part in enumerate(parts):
        if not isinstance(part, dict) or set(part) != {"ordinal", "publicationId", "editionId", "publicationSha256", "packageSha256", "chapterCount"} or type(part.get("ordinal")) is not int or part["ordinal"] != ordinal or not UUID.fullmatch(str(part.get("publicationId", ""))) or part["publicationId"] in identities or type(part.get("chapterCount")) is not int or not 1 <= part["chapterCount"] <= 1000:
            fail("Invalid derivative chapter selection source parts")
        identities.add(part["publicationId"])
        offsets.append(total)
        total += part["chapterCount"]
    if total > 20000000 or type(selection.get("schemaVersion")) is not int or selection["schemaVersion"] != 1 or type(selection.get("total")) is not int or selection["total"] != total or type(selection.get("start")) is not int or selection["start"] < 1 or type(selection.get("count")) is not int or not 1 <= selection["count"] <= 50 or selection["start"] + selection["count"] - 1 > total or not isinstance(selection.get("chapters"), list) or len(selection["chapters"]) != selection["count"]:
        fail("Derivative chapter selection range differs from original source")
    cache = {}
    for index, chapter in enumerate(selection["chapters"]):
        if not isinstance(chapter, dict) or set(chapter) != {"ordinal", "partIndex", "publicationId", "chapterIndex", "chapterId"} or any(type(chapter.get(key)) is not int for key in ("ordinal", "partIndex", "chapterIndex")) or chapter["ordinal"] != selection["start"] - 1 + index or not 0 <= chapter["partIndex"] < len(parts):
            fail("Invalid derivative chapter selection locator/order")
        p, c = chapter["partIndex"], chapter["chapterIndex"]
        if not 0 <= c < parts[p]["chapterCount"] or chapter["publicationId"] != parts[p]["publicationId"] or chapter["ordinal"] != offsets[p] + c or not isinstance(chapter.get("chapterId"), str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}", chapter["chapterId"]):
            fail("Derivative chapter selection locator differs from original source")
        if books_root is not None:
            if p not in cache:
                book = read_json(safe_path(books_root, parts[p]["publicationId"] + "/book.json"))
                cache[p] = book.get("structure", {}).get("chapters", book["chapters"])
            chapters = cache[p]
            if len(chapters) != parts[p]["chapterCount"] or chapters[c].get("id", "c-" + str(c)) != chapter["chapterId"]:
                fail("Derivative selected chapter identity differs from original source")
    return selection


def derived_selected_indices(selection, part_index, count):
    return range(count) if selection is None else [chapter["chapterIndex"] for chapter in selection["chapters"] if chapter["partIndex"] == part_index]


def derived_uuid(value):
    digest = hashlib.sha256(value.encode()).hexdigest()
    return digest[:8] + "-" + digest[8:12] + "-5" + digest[13:16] + "-a" + digest[17:20] + "-" + digest[20:32]


def derived_packed_audio_plan(source, books_root):
    """Independent reconstruction of exact versioned source range coverage."""
    segments = []
    space = re.compile(r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]")
    nonblank = lambda value: any(not space.fullmatch(char) for char in value)
    selection = derived_selection(source, books_root)
    for p, part in enumerate(source["manifest"]["parts"]):
        if selection is not None and not any(chapter["partIndex"] == p for chapter in selection["chapters"]):
            continue
        book = read_json(safe_path(books_root, part["publicationId"] + "/book.json"))
        chapters = book.get("structure", {}).get("chapters", book["chapters"])
        for c in derived_selected_indices(selection, p, len(chapters)):
            chapter = chapters[c]
            blocks = chapter.get("blocks")
            if not isinstance(blocks, list) or any(block.get("type") in ("table", "ruby") or block.get("rows") is not None or any(span.get("kind") == "link" for span in block.get("spans", [])) for block in blocks):
                fail("Unsupported derivative source structure")
            ranges, pieces, characters = [], [], 0
            def flush():
                nonlocal ranges, pieces, characters
                if not ranges:
                    return
                text = "\n\n".join(pieces)
                if nonblank(text):
                    if len(text) > 700:
                        fail("Packed narration source exceeds character bound")
                    locator = {"partIndex": p, "publicationId": part["publicationId"], "chapterIndex": c, "ranges": ranges}
                    digest = hashlib.sha256((source["sha256"] + "|audio|" + PACKED_AUDIO_SEGMENTATION + "|" + canonical_json(locator)).encode()).hexdigest()
                    identity = digest[:8] + "-" + digest[8:12] + "-5" + digest[13:16] + "-a" + digest[17:20] + "-" + digest[20:32]
                    segments.append({**locator, "ordinal": len(segments), "id": identity, "sourceSha256": hashlib.sha256(text.encode()).hexdigest()})
                    if len(segments) > 50000:
                        fail("Unsupported derivative source coverage size")
                ranges, pieces, characters = [], [], 0
            for b, text in [(-1, chapter["title"])] + [(index, block["text"]) for index, block in enumerate(blocks)]:
                if not nonblank(text):
                    continue
                chars, start = list(text), 0
                while start < len(chars):
                    available = 700 - characters - (2 if ranges else 0)
                    if available <= 0 or available < 50 and len(chars) - start > available:
                        flush()
                        available = 700
                    end = min(start + available, len(chars))
                    if end < len(chars):
                        whitespace = -1
                        for candidate in range(end, start + available // 2, -1):
                            if space.fullmatch(chars[candidate - 1]):
                                if whitespace < 0:
                                    whitespace = candidate
                                j = candidate - 2
                                while j >= start and chars[j] in "\"'»”’)]":
                                    j -= 1
                                if j >= start and chars[j] in ".!?…":
                                    end = candidate
                                    break
                        else:
                            if whitespace > start:
                                end = whitespace
                    piece = "".join(chars[start:end])
                    ranges.append({"blockIndex": b, "start": start, "end": end, "sha256": hashlib.sha256(piece.encode()).hexdigest()})
                    pieces.append(piece)
                    characters += (2 if len(pieces) > 1 else 0) + end - start
                    start = end
                    if start < len(chars):
                        flush()
            flush()
    if not 1 <= len(segments) <= 50000:
        fail("Unsupported derivative source coverage size")
    manifest = {"schemaVersion": 1, "segmentationRevision": PACKED_AUDIO_SEGMENTATION, "sourceSha256": source["sha256"], "kind": "audio", "segments": segments}
    if len(canonical_json(manifest).encode()) > 14 * 1024**2:
        fail("Packed narration range plan exceeds memory bound")
    return manifest


def derived_plan(source, kind, books_root, segmentation_revision="derived-unicode-v1"):
    # Independent offline implementation of the versioned source coverage rule.
    # This verifies a checkpoint plan against original bytes, not just against
    # its own stored hash. The cross-language fixture pins the Node contract.
    if segmentation_revision == PACKED_AUDIO_SEGMENTATION and kind == "audio":
        return derived_packed_audio_plan(source, books_root)
    if segmentation_revision != "derived-unicode-v1":
        fail("Unknown or wrong-kind derivative segmentation revision")
    segments = []
    selection = derived_selection(source, books_root)
    space = re.compile(r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]")
    for p, part in enumerate(source["manifest"]["parts"]):
        if selection is not None and not any(chapter["partIndex"] == p for chapter in selection["chapters"]):
            continue
        book = read_json(safe_path(books_root, part["publicationId"] + "/book.json"))
        chapters = book.get("structure", {}).get("chapters", book["chapters"])
        for c in derived_selected_indices(selection, p, len(chapters)):
            chapter = chapters[c]
            blocks = chapter.get("blocks")
            if not isinstance(blocks, list) or any(block.get("type") in ("table", "ruby") or block.get("rows") is not None or any(span.get("kind") == "link" for span in block.get("spans", [])) for block in blocks):
                fail("Unsupported derivative source structure")
            for b, text in [(-1, chapter["title"])] + [(index, block["text"]) for index, block in enumerate(blocks)]:
                chars, start = list(text), 0
                while start < len(chars):
                    end = min(start + 700, len(chars))
                    if end < len(chars):
                        for candidate in range(end, start + 350, -1):
                            if space.fullmatch(chars[candidate - 1]):
                                end = candidate
                                break
                    value = "".join(chars[start:end])
                    if any(not space.fullmatch(char) for char in value):
                        locator = {"partIndex": p, "publicationId": part["publicationId"], "chapterIndex": c, "blockIndex": b, "start": start, "end": end}
                        digest = hashlib.sha256((source["sha256"] + "|" + kind + "|" + canonical_json(locator)).encode()).hexdigest()
                        identity = digest[:8] + "-" + digest[8:12] + "-5" + digest[13:16] + "-a" + digest[17:20] + "-" + digest[20:32]
                        segments.append({**locator, "ordinal": len(segments), "id": identity, "sourceSha256": hashlib.sha256(value.encode()).hexdigest()})
                    start = end
    if not 1 <= len(segments) <= 50000:
        fail("Unsupported derivative source coverage size")
    return {"schemaVersion": 1, "segmentationRevision": "derived-unicode-v1", "sourceSha256": source["sha256"], "kind": kind, "segments": segments}


def derived_compact_translations(source, plan, outputs, books_root, derivation):
    """Rebuild selected translated packages from original bytes + checkpoints.

    No execution of archived Node code is needed to validate a restoration.
    Unselected original chapters cannot appear under a Russian language label.
    """
    selection = derived_selection(source, books_root)
    if selection is None or len(outputs) != len(plan["segments"]):
        fail("Compact translation requires exact selected chapter coverage")
    copies, selected_by_part = {}, {}
    for p, part in enumerate(source["manifest"]["parts"]):
        selected = derived_selected_indices(selection, p, part["chapterCount"])
        if not selected:
            continue
        original = read_json(safe_path(books_root, part["publicationId"] + "/book.json"))
        structure = original.get("structure")
        if structure is None:
            structure = {"schemaVersion": 2, "warnings": ["LEGACY_STRUCTURE_ONLY"], "chapters": [
                {"id": "c-" + str(c), "revision": 1, "title": chapter["title"], "blocks": [
                    {"id": "c-" + str(c) + "-b-" + str(b), "type": "paragraph" if block["type"] == "text" else block["type"], "text": block["text"], **({"resource": block["asset"]} if block["type"] == "image" else {})}
                    for b, block in enumerate(chapter["blocks"])]} for c, chapter in enumerate(original["chapters"])]}
        copies[p] = {"title": original["title"], "author": original["author"], "language": "ru", "assets": copy.deepcopy(original["assets"]), "structure": copy.deepcopy(structure), "chapters": [], **({"derivation": copy.deepcopy(derivation)} if derivation is not None else {})}
        selected_by_part[p] = selected
    groups = {}
    for unit, output in zip(plan["segments"], outputs):
        key = unit["partIndex"], unit["chapterIndex"], unit["blockIndex"]
        groups.setdefault(key, []).append((unit, output.decode("utf-8") if isinstance(output, bytes) else output))
    for (p, c, b), units in groups.items():
        chapter = copies[p]["structure"]["chapters"][c]
        text = chapter["title"] if b == -1 else chapter["blocks"][b]["text"]
        end, chunks = 0, []
        for unit, translated in units:
            original = text[unit["start"]:unit["end"]]
            leading = original[:len(original) - len(original.lstrip(DERIVED_WHITESPACE))]
            trailing = original[len(original.rstrip(DERIVED_WHITESPACE)):]
            chunks.extend((text[end:unit["start"]], leading, translated.strip(DERIVED_WHITESPACE), trailing))
            end = unit["end"]
        chunks.append(text[end:])
        value = "".join(chunks)
        if b == -1:
            chapter["title"] = value
        else:
            chapter["blocks"][b]["text"] = value
    results = []
    for p, book in copies.items():
        book["structure"]["chapters"] = [book["structure"]["chapters"][c] for c in selected_by_part[p]]
        resources = {block["resource"] for chapter in book["structure"]["chapters"] for block in chapter["blocks"] if block["type"] == "image"}
        book["assets"] = {name: raw for name, raw in book["assets"].items() if name in resources}
        physical = [chapter for chapter in selection["chapters"] if chapter["partIndex"] == p]
        suffix = " — главы " + str(physical[0]["ordinal"] + 1) + "–" + str(physical[-1]["ordinal"] + 1) + " — машинный перевод"
        # Node's title budget is UTF-16 code units, while source locators use
        # Unicode code points. Do not split an astral character at the seam.
        title, units, limit = [], 0, 300 - len(suffix.encode("utf-16-le")) // 2
        for char in book["title"]:
            width = 2 if ord(char) > 0xffff else 1
            if units + width > limit:
                break
            title.append(char)
            units += width
        book["title"] = "".join(title) + suffix
        warnings = list(dict.fromkeys(book["structure"]["warnings"] + ["MACHINE_TRANSLATION_DRAFT"]))
        for chapter in book["structure"]["chapters"]:
            for block in chapter["blocks"]:
                if block.get("spans"):
                    del block["spans"]
                    if "MACHINE_TRANSLATION_INLINE_FORMATTING_OMITTED" not in warnings:
                        warnings.append("MACHINE_TRANSLATION_INLINE_FORMATTING_OMITTED")
        book["structure"]["warnings"] = warnings[:100]
        book["chapters"] = [{"title": chapter["title"], "blocks": [
            {"type": "image", "asset": block["resource"], "text": block["text"]} if block["type"] == "image" else {"type": "heading" if block["type"] == "heading" else "text", "text": block["text"]}
            for block in chapter["blocks"]]} for chapter in book["structure"]["chapters"]]
        results.append((p, book))
    return results


def validate_derived(root, inventory, metadata_path=None, expected_tables=None):
    root = Path(root)
    if not inventory.get("derivedSupported"):
        if expected_tables is not None and any(name in expected_tables for name in DERIVED_TABLES):
            fail("Derivative support flag omits fingerprinted tables")
        if root.exists() and files_under(root):
            fail("Unmarked derivative files in legacy snapshot")
        return {"derivedJobsChecked": 0, "derivedCheckpointsChecked": 0, "derivedResultsChecked": 0, "derivedOrphanFilesPreserved": 0}
    if inventory.get("derivedMetadataFormat") != "source-jsonl-v1":
        fail("Unsupported derivative metadata format")
    if any(name in inventory.get("tables", {}) for name in DERIVED_METADATA_TABLES):
        fail("Main inventory must not duplicate derivative metadata")
    tables = derived_metadata(metadata_path)
    if expected_tables is not None:
        for name in DERIVED_METADATA_TABLES:
            if name not in expected_tables or len(tables[name]) != expected_tables[name]["count"]:
                fail("Derivative metadata row count differs from fingerprint baseline: " + name)
    main = inventory.get("tables", {})
    profiles, books = rows_by_id(main.get("profiles"), "profiles"), rows_by_id(main.get("books"), "books")
    sealed_books = {}
    def sealed_book(row):
        if row["id"] not in sealed_books:
            if not row.get("artifact_manifest") or not row.get("publication_manifest"):
                fail("Unsealed derivative source/result publication")
            sealed_books[row["id"]] = ranobe_publication(root.parent / "books", row)
        return sealed_books[row["id"]]
    works, expressions, editions = [rows_by_id(tables[name], name) for name in ("works", "expressions", "editions")]
    jobs, requests = [rows_by_id(tables[name], name) for name in ("derived_jobs", "derived_requests")]
    def keyed(name, key):
        result = {}
        for row in tables[name]:
            identity = row.get(key)
            if not isinstance(identity, str) or identity in result:
                fail("Invalid/duplicate derivative metadata key: " + name)
            result[identity] = row
        return result
    recipes, sources = keyed("derived_recipes", "sha256"), keyed("derived_sources", "sha256")
    attempts, results = keyed("derived_attempts", "token"), keyed("derived_results", "job_id")
    for identity, recipe in recipes.items():
        if not re.fullmatch(r"[a-f0-9]{64}", identity) or recipe.get("kind") not in ("translation", "audio") or not isinstance(recipe.get("language"), str) or not isinstance(recipe.get("manifest"), dict):
            fail("Invalid derivative recipe")
        value = {key: recipe[key] for key in ("kind", "language", "manifest")}
        if hashlib.sha256(canonical_json(value).encode()).hexdigest() != identity:
            fail("Derivative recipe identity differs")
    for expression in expressions.values():
        if expression.get("work_id") not in works or expression.get("source_expression_id") is not None and (expression["source_expression_id"] not in expressions or expressions[expression["source_expression_id"]].get("work_id") != expression["work_id"]):
            fail("Broken derivative expression lineage")
    for edition in editions.values():
        if edition.get("expression_id") not in expressions:
            fail("Broken derivative edition lineage")
    parts = {}
    for part in tables["derived_source_parts"]:
        source_key, ordinal = part.get("source_sha256"), part.get("ordinal")
        if source_key not in sources or type(ordinal) is not int or ordinal < 0 or (source_key, ordinal) in parts:
            fail("Invalid/duplicate derivative source part")
        parts[source_key, ordinal] = part
    for identity, source in sources.items():
        manifest = source.get("manifest")
        if not re.fullmatch(r"[a-f0-9]{64}", identity) or not isinstance(manifest, dict) or hashlib.sha256(canonical_json(manifest).encode()).hexdigest() != identity or source.get("work_id") not in works or source.get("expression_id") not in expressions or expressions[source["expression_id"]].get("work_id") != source["work_id"]:
            fail("Invalid derivative source identity")
        selected = manifest.get("parts")
        if type(manifest.get("schemaVersion")) is not int or manifest.get("schemaVersion") not in (1, 2) or manifest.get("workId") != source["work_id"] or manifest.get("expressionId") != source["expression_id"] or manifest.get("snapshotId") != source.get("snapshot_id") or manifest.get("sourceLanguage") not in ("en", "ru") or not isinstance(selected, list) or not 1 <= len(selected) <= 20000:
            fail("Invalid derivative source manifest")
        if len([key for key in parts if key[0] == identity]) != len(selected):
            fail("Derivative source omits ordered parts")
        seen = set()
        for ordinal, entry in enumerate(selected):
            part = parts.get((identity, ordinal))
            book = books.get(entry.get("publicationId")) if isinstance(entry, dict) else None
            if not part or not book or book["id"] in seen or entry.get("ordinal") != ordinal or part.get("book_id") != book["id"] or part.get("expression_id") != source["expression_id"] or part.get("edition_id") != book.get("edition_id") or book.get("work_id") != source["work_id"] or book.get("expression_id") != source["expression_id"] or entry.get("editionId") != book.get("edition_id") or entry.get("chapterCount") != book.get("chapter_count"):
                fail("Broken derivative source part lineage/order")
            for camel, snake in (("publicationSha256", "publication_sha256"), ("packageSha256", "package_sha256")):
                if not re.fullmatch(r"[a-f0-9]{64}", str(book.get(snake, ""))) or entry.get(camel) != book.get(snake) or part.get(snake) != book.get(snake):
                    fail("Derivative source part hash differs")
            sealed_book(book)
            seen.add(book["id"])
        derived_selection(source, root.parent / "books")
        if source.get("snapshot_id") is not None:
            # A restore root contains copied publication trees and freshly
            # restored inventories, not source metadata sidecars. As with
            # validate_library, resolve the companion from the explicit,
            # hash-checked source metadata path rather than the copied tree.
            ranobe_path = Path(metadata_path).with_name("ranobe-metadata.jsonl") if metadata_path is not None else root.parent / "ranobe-metadata.jsonl"
            ranobe = main if "ranobe_runs" in main else ranobe_metadata(ranobe_path)
            run = next((row for row in ranobe.get("ranobe_runs", []) if row.get("id") == source["snapshot_id"]), None)
            run_parts = sorted((row for row in ranobe.get("ranobe_run_parts", []) if row.get("run_id") == source["snapshot_id"]), key=lambda row: row["ordinal"])
            if not run or run.get("status") != "ready" or not run_parts or any(part.get("status") != "ready" for part in run_parts) or [entry["publicationId"] for entry in selected] != [part.get("book_id") for part in run_parts]:
                fail("Derivative source omits the complete pinned Ranobe snapshot")
    identities = set()
    allowed_statuses = {"queued", "processing", "paused", "approval-required", "completed", "failed", "cancelled", "blocked"}
    for job in jobs.values():
        identity = (job.get("kind"), job.get("source_sha256"), job.get("recipe_sha256"))
        if identity in identities or identity[0] not in ("translation", "audio") or identity[1] not in sources or identity[2] not in recipes or recipes[identity[2]]["kind"] != identity[0] or job.get("status") not in allowed_statuses:
            fail("Invalid/duplicate derivative job identity")
        identities.add(identity)
        selection = derived_selection(sources[job["source_sha256"]])
        if selection is not None and job["kind"] == "translation" and selection["count"] > 5:
            fail("Translation chapter selection exceeds explicit batch policy")
        plan = job.get("plan")
        if plan is not None:
            if not isinstance(plan, dict) or not isinstance(plan.get("segments"), list) or len(plan["segments"]) != job.get("total_segments") or hashlib.sha256(canonical_json(plan).encode()).hexdigest() != job.get("plan_sha256") or any(not isinstance(segment, dict) or segment.get("ordinal") != i or not re.fullmatch(r"[a-f0-9]{64}", str(segment.get("sourceSha256", ""))) for i, segment in enumerate(plan["segments"])):
                fail("Invalid derivative committed plan")
            segmentation_revision = recipes[job["recipe_sha256"]]["manifest"].get("segmentationRevision")
            if plan != derived_plan(sources[job["source_sha256"]], job["kind"], root.parent / "books", segmentation_revision):
                fail("Derivative plan does not cover exact original source bytes")
        elif job.get("plan_sha256") is not None or job.get("total_segments") is not None or job.get("completed_segments") != 0:
            fail("Partial derivative plan metadata")
        token = job.get("attempt_token")
        if token is not None and (token not in attempts or attempts[token].get("job_id") != job["id"]):
            fail("Broken derivative active attempt")
        if job["status"] == "processing" and (token is None or job.get("lease_expires_at") is None):
            fail("Processing derivative has no lease")
    for attempt in attempts.values():
        if not UUID.fullmatch(str(attempt.get("token", ""))) or attempt.get("job_id") not in jobs or attempt.get("state") not in ("running", "finished", "failed", "interrupted", "paused", "cancelled"):
            fail("Broken derivative attempt relationship")
    for request in requests.values():
        if request.get("job_id") not in jobs or request.get("requested_by") not in profiles or request.get("approved_by") is not None and request["approved_by"] not in profiles or request.get("status") not in ("pending-approval", "active", "completed", "cancelled"):
            fail("Broken derivative request relationship")
        if request["status"] in ("active", "completed") and (request.get("approved_by") is None or request.get("decision_reason") not in ("role-auto-approval", "owner-approval")):
            fail("Derivative request lacks decision provenance")
        parent_id = request.get("parent_request_id")
        if parent_id is not None and (parent_id not in requests or requests[parent_id].get("requested_by") != request["requested_by"] or requests[parent_id].get("job_id") != request.get("parent_job_id")):
            fail("Broken derivative parent request")
    idempotency_keys = set()
    for row in tables["derived_idempotency"]:
        key = (row.get("profile_id"), row.get("key"))
        request = requests.get(row.get("request_id"))
        if key in idempotency_keys or not request or request.get("requested_by") != key[0] or not UUID.fullmatch(str(key[1])) or not re.fullmatch(r"[a-f0-9]{64}", str(row.get("body_sha256", ""))):
            fail("Broken derivative idempotency relationship")
        idempotency_keys.add(key)
    all_files, referenced, checkpoints = files_under(root), set(), {}
    for checkpoint in tables["derived_checkpoints"]:
        job_id, ordinal = checkpoint.get("job_id"), checkpoint.get("ordinal")
        job = jobs.get(job_id)
        manifest = checkpoint.get("manifest")
        if not job or type(ordinal) is not int or ordinal < 0 or (job_id, ordinal) in checkpoints or not job.get("plan") or ordinal >= len(job["plan"]["segments"]) or checkpoint.get("source_sha256") != job["plan"]["segments"][ordinal]["sourceSha256"] or checkpoint.get("attempt_token") not in attempts or attempts[checkpoint["attempt_token"]].get("job_id") != job_id or not isinstance(manifest, dict):
            fail("Broken derivative checkpoint relationship/plan")
        if manifest.get("schemaVersion") != 1 or manifest.get("jobId") != job_id or manifest.get("attemptId") != checkpoint["attempt_token"] or manifest.get("ordinal") != ordinal or manifest.get("kind") != job["kind"] or manifest.get("inputSha256") != checkpoint["source_sha256"] or manifest.get("recipeSha256") != job["recipe_sha256"] or not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("profileSha256", ""))):
            fail("Derivative checkpoint manifest identity differs")
        if manifest["profileSha256"] != recipes[job["recipe_sha256"]]["manifest"].get("profileSha256"):
            fail("Derivative checkpoint profile differs from immutable recipe")
        file = manifest.get("file")
        suffix, media = ("txt", "text/plain; charset=utf-8") if job["kind"] == "translation" else ("wav", "audio/wav")
        expected_path = checkpoint["attempt_token"] + "/" + str(ordinal).zfill(6) + "." + suffix
        limit = 32768 if job["kind"] == "translation" else 12 * 1024**2
        if not isinstance(file, dict) or file.get("path") != expected_path or file.get("sha256") != checkpoint.get("output_sha256") or file.get("bytes") != checkpoint.get("output_bytes") or type(file.get("bytes")) is not int or not 1 <= file["bytes"] <= limit or file.get("mediaType") != media:
            fail("Invalid derivative checkpoint artifact manifest")
        relative = job_id + "/" + expected_path
        location = safe_path(root, relative)
        actual = file_record(location)
        if actual["sha256"] != file["sha256"] or actual["bytes"] != file["bytes"]:
            fail("Derivative checkpoint file hash/size differs")
        scan = manifest.get("scan")
        if not isinstance(scan, dict) or scan.get("sha256") != file["sha256"] or not isinstance(scan.get("version"), str) or not scan["version"].strip() or len(scan["version"]) > 512 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", str(scan.get("checkedAt", ""))):
            fail("Derivative scan receipt differs")
        try:
            datetime.fromisoformat(scan["checkedAt"].replace("Z", "+00:00"))
        except ValueError:
            fail("Invalid derivative scan receipt timestamp")
        raw = location.read_bytes()
        if job["kind"] == "audio":
            if manifest.get("quality") != "technical-unlistened": fail("Invalid audio quality label")
            derived_pcm(raw, manifest.get("pcm"))
        else:
            text = raw.decode("utf-8")
            if not text.strip() or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text) or manifest.get("quality") != "machine-draft":
                fail("Invalid inert translated text/quality")
        referenced.add(relative)
        checkpoints[job_id, ordinal] = manifest
    for job in jobs.values():
        own = sorted(ordinal for identity, ordinal in checkpoints if identity == job["id"])
        if own != list(range(job.get("completed_segments", -1))):
            fail("Derivative accepted prefix differs from progress")
        if job["status"] == "completed" and (not job.get("total_segments") or len(own) != job["total_segments"] or job["id"] not in results):
            fail("Completed derivative is incomplete")
    for job_id, result in results.items():
        job = jobs.get(job_id)
        manifest = result.get("manifest")
        expression = expressions.get(result.get("expression_id"))
        edition = editions.get(result.get("edition_id"))
        if not job or job["status"] != "completed" or result.get("work_id") != sources[job["source_sha256"]]["work_id"] or not expression or expression.get("work_id") != result["work_id"] or not edition or edition.get("expression_id") != expression["id"] or not isinstance(manifest, dict):
            fail("Broken derivative result lineage/status")
        if job["kind"] == "translation" and (expression.get("kind") != "machine-translation" or expression.get("source_expression_id") != sources[job["source_sha256"]]["expression_id"]) or job["kind"] == "audio" and expression["id"] != sources[job["source_sha256"]]["expression_id"]:
            fail("Derivative result replaced or disconnected original")
        if manifest.get("schemaVersion") != 1 or manifest.get("jobId") != job_id or manifest.get("kind") != job["kind"] or manifest.get("quality") != ("machine-draft" if job["kind"] == "translation" else "technical-unlistened") or manifest.get("sourceSha256") != job["source_sha256"] or manifest.get("recipeSha256") != job["recipe_sha256"] or manifest.get("segments") != [checkpoints[job_id, i] for i in range(job["total_segments"])]:
            fail("Derivative result coverage/order differs")
        if job["kind"] == "translation":
            publications = manifest.get("publicationIds")
            if not isinstance(publications, list) or not publications or len(set(publications)) != len(publications) or any(identity not in books or books[identity].get("work_id") != result["work_id"] or books[identity].get("expression_id") != result["expression_id"] for identity in publications):
                fail("Broken translated publication lineage")
            expected_derivation = {"schemaVersion": 1, "kind": "machine-translation", "quality": "machine-draft", "sourceSha256": job["source_sha256"], "recipeSha256": job["recipe_sha256"], "jobId": job_id}
            for identity in publications:
                translated = sealed_book(books[identity])
                if validate_derivation_metadata(translated.get("derivation")) != expected_derivation:
                    fail("Translated package provenance differs from committed result")
            source = sources[job["source_sha256"]]
            if derived_selection(source) is not None:
                outputs = [safe_path(root, job_id + "/" + checkpoint["file"]["path"]).read_bytes() for checkpoint in manifest["segments"]]
                expected = derived_compact_translations(source, job["plan"], outputs, root.parent / "books", expected_derivation)
                if publications != [derived_uuid("translated-book|" + job_id + "|" + str(p)) for p, _ in expected]:
                    fail("Compact translated publication coverage/order differs from selected source parts")
                for identity, (p, content) in zip(publications, expected):
                    if books[identity].get("edition_id") != derived_uuid("translated-edition|" + job_id + "|" + str(p)) or sealed_book(books[identity]) != content:
                        fail("Compact translation does not reconstruct exact selected chapter output")
        relative = job_id + "/manifest.json"
        location = safe_path(root, relative)
        record = file_record(location)
        if record["sha256"] != result.get("sha256") or record["bytes"] != result.get("bytes") or read_json(location) != manifest:
            fail("Derivative result manifest file/hash differs")
        referenced.add(relative)
    for source in sources.values():
        if expressions[source["expression_id"]].get("kind") == "machine-translation":
            origins = [result for result in results.values() if result.get("expression_id") == source["expression_id"] and jobs[result["job_id"]]["kind"] == "translation" and all(part["publicationId"] in result["manifest"].get("publicationIds", []) for part in source["manifest"]["parts"])]
            if len(origins) != 1:
                fail("Missing/ambiguous source machine translation provenance")
    return {"derivedJobsChecked": len(jobs), "derivedCheckpointsChecked": len(checkpoints), "derivedResultsChecked": len(results),
            "derivedOrphanFilesPreserved": len(set(all_files) - referenced), "derivedReferencedBytes": sum(all_files[name].stat().st_size for name in referenced)}


def preflight(backup, candidate=None):
    backup = Path(backup).resolve()
    manifest = candidate if candidate is not None else read_json(backup / "manifest.json")
    version = manifest.get("version")
    if version not in (1, 2) or (version == 2 and manifest.get("status") != "ready"):
        fail("Backup is incomplete or manifest version is unsupported")
    if not isinstance(manifest.get("files"), list) or len(manifest["files"]) > MAX_FILES:
        fail("Invalid backup manifest")
    expected, folded = set(), set()
    for item in manifest["files"]:
        name = relative_name(item.get("path"), legacy=version == 1)
        if name.casefold() in folded or name == "manifest.json":
            fail("Duplicate or reserved manifest path")
        folded.add(name.casefold()); expected.add(name)
        size = item.get("bytes", item.get("size"))
        if type(size) is not int or size < 0 or not SHA.fullmatch(str(item.get("sha256", ""))):
            fail("Invalid file hash/size record")
        record = file_record(safe_path(backup, name))
        if record["bytes"] != size or record["sha256"] != item["sha256"].lower():
            fail("Backup file hash/size differs: " + name)
    actual = set(files_under(backup)) - {"manifest.json"}
    permitted_extra = {"README.md"} if version == 1 else set()
    if not expected.issubset(actual) or actual - expected - permitted_extra:
        fail("Unlisted/missing backup files")
    if "database.dump" not in expected or "source.tar.gz" not in expected:
        fail("Backup lacks required database/source inputs")
    if version == 2 and not {"db-inventory.json", "db-table-fingerprints.jsonl", "snapshot-metadata.json"}.issubset(expected):
        fail("Backup lacks consistent baseline inventory")
    check_source_archive(backup / "source.tar.gz", legacy=version == 1)
    validation = None
    if version == 2:
        fingerprints = table_fingerprints(backup / "db-table-fingerprints.jsonl")
        inventory = read_json(backup / "db-inventory.json")
        validation = validate_library(backup / "books", inventory, backup / "ranobe-checkpoints.jsonl", expected_tables=fingerprints)
        validation.update(validate_derived(backup / "derived", inventory, backup / "derived-metadata.jsonl", fingerprints))
        validation.update(validate_reader(backup / "books", inventory, backup / "reader-metadata.jsonl", fingerprints))
    return {"version": version, "integrityValidated": True, "legacyBaselineUnavailable": version == 1,
            "filesChecked": len(expected), "library": validation}


def finalize(backup):
    backup = Path(backup).resolve()
    inventory = read_json(backup / "db-inventory.json")
    fingerprints = table_fingerprints(backup / "db-table-fingerprints.jsonl")
    validation = validate_library(backup / "books", inventory, backup / "ranobe-checkpoints.jsonl", expected_tables=fingerprints)
    validation.update(validate_derived(backup / "derived", inventory, backup / "derived-metadata.jsonl", fingerprints))
    validation.update(validate_reader(backup / "books", inventory, backup / "reader-metadata.jsonl", fingerprints))
    metadata = read_json(backup / "snapshot-metadata.json")
    if metadata.get("handlersRestored") is not True or metadata.get("snapshotProtocol") != "pg-exported-repeatable-read":
        fail("Snapshot protocol/handler restoration was not confirmed")
    image_ids = list(metadata.get("sourceContainerImages", {}).values())
    if metadata.get("sourceDatabaseImage") is not None:
        image_ids.append(metadata["sourceDatabaseImage"])
    if any(not isinstance(image, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", image) for image in image_ids):
        fail("Invalid captured runtime image identity")
    if metadata.get("runtimeImagesIncluded") and not (backup / "runtime-images.tar").is_file():
        fail("Requested runtime image archive is missing")
    files = []
    for name, path in sorted(files_under(backup).items()):
        if name == "manifest.json":
            continue
        record = file_record(path); record["path"] = name; files.append(record)
    check_source_archive(backup / "source.tar.gz")
    manifest = {"version": 2, "status": "ready", "createdAt": datetime.now(timezone.utc).isoformat(),
                "files": files, "validation": validation, "databaseTables": len(fingerprints),
                "integrityValidated": True, "restoreVerified": False,
                "sourceArchiveScope": metadata.get("sourceArchiveScope", "Workspace source/config; not proof of deployed revision"),
                "runtime": {"databaseImageId": metadata.get("sourceDatabaseImage"), "containerImageIds": metadata.get("sourceContainerImages", {}),
                            "imagesArchived": metadata.get("runtimeImagesIncluded", False)},
                "sensitiveData": "Private library and password hashes; owner/SYSTEM ACL required. Runtime .env and session rows excluded.",
                "excluded": ["quarantine", "unfinished parser jobs", "sessions data", "runtime secrets", "model packages", "host inference spool"],
                "derivedIncluded": bool(inventory.get("derivedSupported")),
                "readerIncluded": bool(inventory.get("readerSupported")),
                "recovery": "Restore isolated/paused. Committed derivative checkpoints are retained; unfinished model calls may repeat. Unfinished uploaded inputs may require reupload. Recovery keys/models are separate."}
    # Validate the candidate while the on-disk marker still says building.
    checked = preflight(backup, candidate=manifest)
    atomic_json(backup / "manifest.json", manifest)
    return checked


def compare_restore(backup, restored, books):
    before = preflight(backup)
    restored = Path(restored)
    actual = read_json(restored / "db-inventory.json")
    actual_tables = table_fingerprints(restored / "db-table-fingerprints.jsonl")
    baseline_tables = None
    if before["version"] == 2:
        if actual.get("sessionRows") != 0:
            fail("Session credentials unexpectedly restored from v2 backup")
        expected = read_json(Path(backup) / "db-inventory.json")
        if actual.get("tables") != expected.get("tables") or actual.get("catalogsSupported") != expected.get("catalogsSupported"):
            fail("Restored inventory differs from the consistent snapshot")
        if bool(actual.get("ranobeSupported")) != bool(expected.get("ranobeSupported")) or actual.get("ranobeMetadataFormat") != expected.get("ranobeMetadataFormat"):
            fail("Restored Ranobe metadata/support flags differ")
        if bool(actual.get("derivedSupported")) != bool(expected.get("derivedSupported")) or actual.get("derivedMetadataFormat") != expected.get("derivedMetadataFormat"):
            fail("Restored derivative metadata/support flags differ")
        if bool(actual.get("readerSupported")) != bool(expected.get("readerSupported")) or actual.get("readerMetadataFormat") != expected.get("readerMetadataFormat") or actual.get("readerBudget") != expected.get("readerBudget"):
            fail("Restored reader metadata/support flags differ")
        baseline_tables = table_fingerprints(Path(backup) / "db-table-fingerprints.jsonl")
        if actual_tables != baseline_tables:
            fail("Restored database table counts/fingerprints differ")
        original = {name[len("books/"):]: file_record(path) for name, path in files_under(backup).items() if name.startswith("books/")}
        restored_files = {name: file_record(path) for name, path in files_under(books).items()}
        if original != restored_files:
            fail("Restored published files differ")
        if expected.get("derivedSupported"):
            original_derived = {name[len("derived/"):]: file_record(path) for name, path in files_under(backup).items() if name.startswith("derived/")}
            restored_derived = {name: file_record(path) for name, path in files_under(restored / "derived").items()}
            if original_derived != restored_derived:
                fail("Restored derivative/checkpoint files differ")
    # Source-only 005 sidecars are safe to use only after the complete restored
    # row fingerprints (including metadata and prepared blobs) match the source.
    validation = validate_library(books, actual, Path(backup) / "ranobe-checkpoints.jsonl", expected_tables=baseline_tables)
    validation.update(validate_derived(restored / "derived", actual, Path(backup) / "derived-metadata.jsonl", baseline_tables))
    validation.update(validate_reader(books, actual, Path(backup) / "reader-metadata.jsonl", baseline_tables))
    return {"status": "validated", "databaseTablesCompared": len(actual_tables) if before["version"] == 2 else 0,
            "legacyBaselineUnavailable": before["version"] == 1, "library": validation,
            "scope": "Isolated PostgreSQL restore plus files/relationships/chapters/notes/catalogues; not production switch-over"}


def cleanup_check(root, token):
    root = Path(root)
    if not re.fullmatch(r"[a-f0-9]{32}", token) or linked(root):
        fail("Invalid restore cleanup ownership")
    marker = read_json(root / "restore-owner.json")
    if marker.get("token") != token or os.path.normcase(str(root.resolve())) != os.path.normcase(marker.get("root", "")):
        fail("Restore cleanup ownership differs")
    files_under(root)  # Refuse every nested symlink/junction before recursive removal.
    return {"cleanupAllowed": True}


def ranobe_metadata_selections():
    selections = {}
    for name in ("ranobe_feeds", "ranobe_feed_requests", "ranobe_runs"):
        selections[name] = f"SELECT to_jsonb(t) AS row FROM {name} t ORDER BY id"
    selections["ranobe_chapters"] = """SELECT to_jsonb(t)-'prepared_book'||jsonb_build_object(
'prepared_present',prepared_book IS NOT NULL,
'prepared_json_sha256',CASE WHEN prepared_book IS NOT NULL THEN encode(sha256(convert_to(prepared_book::text,'UTF8')),'hex') END,
'prepared_json_bytes',CASE WHEN prepared_book IS NOT NULL THEN octet_length(prepared_book::text) END) AS row FROM ranobe_chapters t ORDER BY id"""
    selections["ranobe_run_chapters"] = "SELECT to_jsonb(t) AS row FROM ranobe_run_chapters t ORDER BY run_id,ordinal"
    selections["ranobe_run_parts"] = "SELECT to_jsonb(t) AS row FROM ranobe_run_parts t ORDER BY run_id,ordinal"
    selections["ranobe_scratch"] = "SELECT to_jsonb(t)||jsonb_build_object('parent_import_id',a.import_id) AS row FROM ranobe_scratch t JOIN import_attempts a ON a.token=t.parent_attempt ORDER BY t.token"
    return selections


def inventory_query(catalogs=True, ranobe=False, derived=False, reader=False, reader_journal=False):
    selections = {
        "profiles": "SELECT to_jsonb(t)-'password' AS row FROM profiles t ORDER BY id",
        "imports": "SELECT to_jsonb(t) AS row FROM imports t ORDER BY id",
        "books": "SELECT to_jsonb(t) AS row FROM books t ORDER BY id",
        "reading": "SELECT to_jsonb(t) AS row FROM reading t ORDER BY profile_id,book_id",
        "bookmarks": "SELECT to_jsonb(t) AS row FROM bookmarks t ORDER BY id",
        "settings": "SELECT to_jsonb(t) AS row FROM settings t ORDER BY id",
    }
    if catalogs:
        selections["profile_catalogs"] = "SELECT to_jsonb(t) AS row FROM profile_catalogs t ORDER BY profile_id"
    pairs = ["'%s', COALESCE((SELECT json_agg(row) FROM (%s) ordered_rows),'[]'::json)" % (name, sql) for name, sql in selections.items()]
    if not catalogs:
        pairs.append("'profile_catalogs', '[]'::json")
    reader_budget = "(SELECT json_build_object('format','exact-jsonl-v1','rows',rows,'bytes',bytes,'maxRows',250000,'maxBytes',100663296) FROM public.reader_journal_budget WHERE singleton)" if reader_journal else "NULL"
    reader_format = "'source-jsonl-v2'" if reader_journal else "'source-jsonl-v1'" if reader else "NULL"
    return "SELECT json_build_object('schemaVersion',1,'sessionRows',(SELECT count(*) FROM sessions),'catalogsSupported',%s,'ranobeSupported',%s,'ranobeMetadataFormat',%s,'derivedSupported',%s,'derivedMetadataFormat',%s,'readerSupported',%s,'readerMetadataFormat',%s,'readerBudget',%s,'tables',json_build_object(%s));" % ("true" if catalogs else "false", "true" if ranobe else "false", "'source-jsonl-v1'" if ranobe else "NULL", "true" if derived else "false", "'source-jsonl-v1'" if derived else "NULL", "true" if reader else "false", reader_format, reader_budget, ",\n".join(pairs))


def reader_budget_assertion_sql():
    """Recompute exact serialized bytes; physical/TOAST sizes cannot prove this."""
    lines = "\nUNION ALL\n".join("SELECT json_build_object('table','" + name + "','row',to_jsonb(t))::text AS line FROM public." + name + " t" for name in READER_TABLES)
    return """WITH measured AS (
SELECT count(*) AS rows,COALESCE(sum(octet_length(line)+1),0) AS bytes,
COALESCE(max(octet_length(line)+1),0) AS max_line FROM (
%s
) exact_lines)
SELECT (count(*)=1 AND COALESCE(bool_and(b.singleton AND b.rows=m.rows AND b.bytes=m.bytes
AND b.rows<=250000 AND b.bytes<=100663296 AND m.max_line<=131072),false)) AS gargantua_reader_budget_ok
FROM public.reader_journal_budget b CROSS JOIN measured m \\gset
\\if :gargantua_reader_budget_ok
\\else
SELECT 1/0;
\\endif
""" % lines


def reader_preflight_sql():
    # No paths, dump, staging writes, or service mutation. The production app
    # remains online while this independent read-only snapshot checks its bound.
    legacy_lines = "\nUNION ALL\n".join("SELECT json_build_object('table','" + name + "','row',to_jsonb(t))::text AS line FROM public." + name + " t" for name in READER_TABLES)
    legacy_guard = "SELECT count(*)<=500000 AND COALESCE(sum(octet_length(line)+1),0)<=134217728 AND COALESCE(max(octet_length(line)+1),0)<=131072 AS gargantua_reader_legacy_ok FROM (\n" + legacy_lines + ") legacy_lines \\gset\n\\if :gargantua_reader_legacy_ok\nSELECT json_build_object('supported',false,'legacyReaderChecked',true);\n\\else\nSELECT 1/0;\n\\endif\n"
    return "\\set ON_ERROR_STOP on\n\\pset tuples_only on\n\\pset format unaligned\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout='45s';\nSET LOCAL lock_timeout='5s';\nSET LOCAL TIME ZONE 'UTC';\nSET LOCAL DateStyle TO 'ISO, YMD';\nSELECT to_regclass('public.reader_journal_budget') IS NOT NULL AS has_reader_journal,to_regclass('public.reader_profiles') IS NOT NULL AS has_reader \\gset\n\\if :has_reader_journal\n" + reader_budget_assertion_sql() + "SELECT json_build_object('supported',true,'rows',rows,'bytes',bytes,'maxRows',250000,'maxBytes',100663296) FROM public.reader_journal_budget WHERE singleton;\n\\else\n\\if :has_reader\n" + legacy_guard + "\\else\nSELECT json_build_object('supported',false);\n\\endif\n\\endif\nCOMMIT;\n"


def bounded_sidecar_sql(remote, name, queries, line_limit, total_limit, extra_guard="true"):
    # Byte bounds precede filesystem output: TOAST/dump compression must not
    # turn a small physical relation estimate into unbounded staging writes.
    lines = "\nUNION ALL\n".join("SELECT (value)::text AS line FROM (" + query + ") bounded_rows(value)" for query in queries)
    sql = "SELECT COALESCE(sum(octet_length(line)+1),0)<=%d AND COALESCE(max(octet_length(line)+1),0)<=%d AND count(*)<=500000 AND (%s) AS gargantua_sidecar_ok FROM (\n%s\n) bounded_lines \\gset\n\\if :gargantua_sidecar_ok\n" % (total_limit, line_limit, extra_guard, lines)
    sql += "\\o " + remote + "/" + name + "\n"
    sql += "\n".join(query + ";" for query in queries) + "\n\\o\n\\else\nSELECT 1/0;\n\\endif\n"
    return sql


def inventory_sql(remote, snapshot=False):
    if not re.fullmatch(r"/tmp/gargantua-(snapshot|verify)-[a-f0-9]{32}", remote):
        fail("Invalid private database staging path")
    sql = "\\set ON_ERROR_STOP on\n\\pset tuples_only on\n\\pset format unaligned\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL TIME ZONE 'UTC';\nSET LOCAL DateStyle TO 'ISO, YMD';\n"
    sql += "SELECT to_regclass('public.reader_journal_budget') IS NOT NULL AS has_reader_journal \\gset\n\\if :has_reader_journal\n" + reader_budget_assertion_sql() + "\\endif\n"
    if snapshot:
        sql += "SELECT pg_export_snapshot() AS gargantua_snapshot \\gset\n\\setenv GARGANTUA_SNAPSHOT :gargantua_snapshot\n"
        sql += '\\! pg_dump -U cotology_app -d library -Fc --no-owner --no-acl --exclude-table-data=public.sessions --snapshot="$GARGANTUA_SNAPSHOT" -f ' + remote + "/database.dump\n"
        # psql 17 has no numeric argument for \\quit. A deliberate SQL error
        # under ON_ERROR_STOP produces exit 3 if pg_dump's shell exit failed.
        sql += "\\if :SHELL_ERROR\nSELECT 1/0;\n\\endif\n"
    sql += "SELECT to_regclass('public.profile_catalogs') IS NOT NULL AS has_catalogs, to_regclass('public.ranobe_feeds') IS NOT NULL AS has_ranobe, to_regclass('public.derived_jobs') IS NOT NULL AS has_derived, to_regclass('public.reader_profiles') IS NOT NULL AS has_reader \\gset\n\\o " + remote + "/db-inventory.json\n"
    def branches(options, selected=()):
        if not options:
            return inventory_query(*selected) + "\n"
        return "\\if :" + options[0] + "\n" + branches(options[1:], selected + (True,)) + "\\else\n" + branches(options[1:], selected + (False,)) + "\\endif\n"
    sql += branches(("has_catalogs", "has_ranobe", "has_derived", "has_reader", "has_reader_journal")) + "\\o\n"
    if snapshot:
        # Source-only streaming sidecar. The main 32 MiB inventory never embeds
        # the <=64 MiB cache. Restored full-row fingerprints prove the blob bytes
        # without writing/transferring another large sidecar inside restore tmpfs.
        sql += "\\if :has_ranobe\n"
        sql += bounded_sidecar_sql(remote, "ranobe-checkpoints.jsonl", ["SELECT json_build_object('id',id,'prepared_book',prepared_book) FROM public.ranobe_chapters WHERE prepared_book IS NOT NULL ORDER BY id"], 22 * 1024**2, 96 * 1024**2,
                                   "(SELECT COALESCE(sum(prepared_bytes),0)<=67108864 FROM public.ranobe_chapters WHERE prepared_book IS NOT NULL)")
        metadata_queries = []
        for name, selection in ranobe_metadata_selections().items():
            metadata_queries.append("SELECT json_build_object('table','" + name + "','row',row) FROM (" + selection + ") metadata_rows")
        sql += bounded_sidecar_sql(remote, "ranobe-metadata.jsonl", metadata_queries, 1024**2, 256 * 1024**2)
        sql += "\\endif\n"
        sql += "\\if :has_derived\n"
        queries = ["SELECT json_build_object('table','" + name + "','row',to_jsonb(t)) FROM public." + name + " t ORDER BY " +
                   ("source_sha256,ordinal" if name == "derived_source_parts" else "job_id,ordinal" if name == "derived_checkpoints" else "profile_id,key" if name == "derived_idempotency" else "token" if name == "derived_attempts" else "sha256" if name in ("derived_sources", "derived_recipes") else "job_id" if name == "derived_results" else "id") for name in DERIVED_METADATA_TABLES]
        sql += bounded_sidecar_sql(remote, "derived-metadata.jsonl", queries, 20 * 1024**2, 256 * 1024**2)
        sql += "\\endif\n"
        sql += "\\if :has_reader\n"
        reader_order = {"reader_profiles": "profile_id", "reader_devices": "profile_id,device_id", "reader_entities": "profile_id,entity_type,entity_id", "reader_mutations": "profile_id,device_id,counter", "reader_changes": "profile_id,change_revision"}
        sql += "\\if :has_reader_journal\n"
        for columns, terminator in ((READER_COLUMNS_V2, "\\else\n"), (READER_COLUMNS, "\\endif\n")):
            queries = ["SELECT json_build_object('table','" + name + "','row',jsonb_build_object(" + ",".join("'" + column + "',t." + column for column in sorted(columns[name])) + ")) FROM public." + name + " t ORDER BY " + reader_order[name] for name in READER_TABLES]
            sql += bounded_sidecar_sql(remote, "reader-metadata.jsonl", queries, 128 * 1024, READER_METADATA_LIMIT) + terminator
        sql += "\\endif\n"
    sql += "\\o " + remote + "/db-table-fingerprints.jsonl\n"
    # V2 folds sorted fixed-width row hashes incrementally. PostgreSQL's sort
    # can spill under work_mem; no aggregate builds the whole table in memory.
    # The legacy branch is required to restore snapshots from older schemas.
    sql += """SELECT to_regprocedure('public.gargantua_table_fingerprint_v2(regclass)') IS NOT NULL AS has_fingerprint_v2 \\gset
\\if :has_fingerprint_v2
SELECT format('SELECT jsonb_build_object(''table'',%L)||public.gargantua_table_fingerprint_v2(%L::regclass)::jsonb;',tablename,format('%I.%I',schemaname,tablename))
FROM pg_tables WHERE schemaname='public' AND tablename<>'sessions' ORDER BY tablename
\\gexec
\\else
SELECT format('SELECT json_build_object(''table'',%L,''count'',count(*),''fingerprint'',md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'''' ORDER BY md5(to_jsonb(t)::text)),''''))) FROM %I.%I t;', tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname='public' AND tablename<>'sessions' ORDER BY tablename
\\gexec
\\endif
\\o
COMMIT;
"""
    return sql


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    source = sub.add_parser("source"); source.add_argument("--project", type=Path, required=True); source.add_argument("--output", type=Path, required=True)
    estimate = sub.add_parser("source-estimate"); estimate.add_argument("--project", type=Path, required=True)
    sub.add_parser("reader-preflight-sql")
    sql = sub.add_parser("inventory-sql"); sql.add_argument("--remote", required=True); sql.add_argument("--snapshot", action="store_true"); sql.add_argument("--output", type=Path, required=True)
    for command in ("preflight", "finalize"):
        item = sub.add_parser(command); item.add_argument("--backup", type=Path, required=True); item.add_argument("--report", type=Path)
    compare = sub.add_parser("compare"); compare.add_argument("--backup", type=Path, required=True); compare.add_argument("--restored", type=Path, required=True); compare.add_argument("--books", type=Path, required=True); compare.add_argument("--report", type=Path, required=True)
    clean = sub.add_parser("cleanup-check"); clean.add_argument("--root", type=Path, required=True); clean.add_argument("--token", required=True)
    args = parser.parse_args()
    if args.command == "reader-preflight-sql":
        print(reader_preflight_sql(), end="")
        return
    if args.command == "inventory-sql":
        args.output.write_text(inventory_sql(args.remote, args.snapshot), encoding="utf-8", newline="\n")
        return
    if args.command == "source-estimate":
        print(json.dumps(source_estimate(args.project)))
        return
    if args.command == "source":
        result = source_archive(args.project, args.output)
    elif args.command == "cleanup-check": result = cleanup_check(args.root, args.token)
    elif args.command == "preflight": result = preflight(args.backup)
    elif args.command == "finalize": result = finalize(args.backup)
    else: result = compare_restore(args.backup, args.restored, args.books)
    if getattr(args, "report", None): atomic_json(args.report, result)
    # Counts/status only. Never print titles, private notes, SQL rows or credentials.
    print(json.dumps({"operation": args.command, "status": "ok"}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError, tarfile.TarError) as error:
        print("Snapshot validation failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
