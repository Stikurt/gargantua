"""Small real filesystem/SQLite crash probe; never opens application storage.

Process termination is tested, not power failure or PostgreSQL/client durability.
Every child is confined to a fresh .local/temp/storage-durability-probe-* tree.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
TEMP = ROOT / ".local" / "temp"
PREFIX = "storage-durability-probe-"
REPORT = ROOT / "docs/gargantua/research/storage-durability-results.json"
PAYLOAD = ("Глава 1. Надёжность проверяется чтением сохранённых байтов.\n" * 37).encode("utf-8")
CRASHPOINTS = (
    "before_staging", "after_partial_staging", "after_fsynced_staging",
    "after_atomic_rename", "before_db_commit", "after_db_commit",
    "before_cleanup", "after_cleanup",
)
COMMITTED_POINTS = {"after_db_commit", "before_cleanup", "after_cleanup"}
SCOPE = "NOT_PRODUCTION_POSTGRES_OR_CLIENT"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def bounded(path: Path) -> Path:
    """Reject paths outside a probe-owned, direct child of the workspace temp root."""
    resolved = path.resolve()
    base = TEMP.resolve()
    relative = resolved.relative_to(base)
    if not relative.parts or not relative.parts[0].startswith(PREFIX):
        raise ValueError("not a probe-owned workspace temp path")
    # A substituted temp parent must not allow deleting/writing outside workspace.
    base.relative_to(ROOT.resolve())
    if not resolved.is_relative_to(base / relative.parts[0]):
        raise ValueError("probe boundary escaped")
    return resolved


def cleanup_run(path: Path) -> None:
    target = bounded(path)
    if target.parent != TEMP.resolve() or not target.name.startswith(PREFIX):
        raise ValueError("cleanup must name one complete probe run")
    shutil.rmtree(target)


def new_run() -> Path:
    TEMP.mkdir(parents=True, exist_ok=True)
    TEMP.resolve().relative_to(ROOT.resolve())
    return bounded(Path(tempfile.mkdtemp(prefix=PREFIX, dir=TEMP)))


@contextmanager
def connect(case: Path):
    case = bounded(case)
    db = sqlite3.connect(case / "index.sqlite", timeout=5)
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        with db:
            yield db
    finally:
        db.close()


def initialize(case: Path) -> None:
    case = bounded(case)
    for directory in ("staging", "blobs", "attempts", "rejected"):
        (case / directory).mkdir(parents=True, exist_ok=True)
    with connect(case) as db:
        db.executescript("""
          CREATE TABLE IF NOT EXISTS commands (
            id TEXT PRIMARY KEY, publication_id TEXT UNIQUE NOT NULL,
            expected_sha TEXT NOT NULL, status TEXT NOT NULL
              CHECK(status IN ('planned','ready','blocked')));
          CREATE TABLE IF NOT EXISTS blobs (
            sha TEXT PRIMARY KEY, size INTEGER NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('valid','invalid')));
          CREATE TABLE IF NOT EXISTS refs (
            publication_id TEXT PRIMARY KEY, sha TEXT NOT NULL REFERENCES blobs(sha));
          CREATE TABLE IF NOT EXISTS cursors (
            profile_id TEXT NOT NULL, publication_id TEXT NOT NULL,
            locator TEXT NOT NULL, revision INTEGER NOT NULL,
            PRIMARY KEY(profile_id,publication_id));
        """)


def prepare(case: Path, command: str = "request-1", publication: str = "book-1",
            expected_sha: str | None = None) -> None:
    if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", command):
        raise ValueError("unsafe command id")
    expected_sha = expected_sha or digest(PAYLOAD)
    with connect(case) as db:
        previous = db.execute("SELECT publication_id,expected_sha FROM commands WHERE id=?", (command,)).fetchone()
        if previous and previous != (publication, expected_sha):
            raise ValueError("idempotency key reused for different input")
        db.execute("INSERT OR IGNORE INTO commands VALUES(?,?,?,'planned')", (command, publication, expected_sha))


def crash(point: str, selected: str | None) -> None:
    if point == selected:
        os._exit(80 + CRASHPOINTS.index(point))


def write_synced(path: Path, content: bytes) -> None:
    with path.open("wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def read_publication(case: Path, publication: str = "book-1") -> bytes:
    with connect(case) as db:
        row = db.execute("""SELECT b.sha,b.size FROM refs r
          JOIN blobs b ON b.sha=r.sha JOIN commands c ON c.publication_id=r.publication_id
          WHERE r.publication_id=? AND c.status='ready' AND b.state='valid'""", (publication,)).fetchone()
    if not row:
        raise LookupError("publication is not committed and valid")
    data = (bounded(case) / "blobs" / row[0]).read_bytes()
    if len(data) != row[1] or digest(data) != row[0]:
        raise ValueError("stored blob hash or length mismatch; fail closed")
    return data


def publish(case: Path, command: str = "request-1", selected: str | None = None) -> None:
    case = bounded(case)
    with connect(case) as db:
        row = db.execute("SELECT publication_id,expected_sha,status FROM commands WHERE id=?", (command,)).fetchone()
    if not row:
        raise ValueError("unknown command")
    publication, sha, status = row
    if status == "ready":
        if read_publication(case, publication) != PAYLOAD:
            raise ValueError("committed content differs")
        return
    if status != "planned" or digest(PAYLOAD) != sha:
        raise ValueError("input identity/hash check failed")
    crash("before_staging", selected)
    receipt = case / "attempts" / (command + ".json")
    write_synced(receipt, json.dumps({"command": command, "sha": sha}).encode())
    staging = case / "staging" / (command + ".part")
    with staging.open("wb") as stream:
        split = len(PAYLOAD) // 2
        stream.write(PAYLOAD[:split])
        stream.flush()
        os.fsync(stream.fileno())
        crash("after_partial_staging", selected)
        stream.write(PAYLOAD[split:])
        stream.flush()
        os.fsync(stream.fileno())
    if digest(staging.read_bytes()) != sha:
        raise ValueError("staging verification failed")
    crash("after_fsynced_staging", selected)
    destination = case / "blobs" / sha
    if destination.exists():
        if digest(destination.read_bytes()) != sha:
            raise ValueError("existing content-addressed blob is corrupt")
        staging.unlink()
    else:
        os.replace(staging, destination)
    crash("after_atomic_rename", selected)
    with connect(case) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("INSERT OR IGNORE INTO blobs VALUES(?,?,'valid')", (sha, len(PAYLOAD)))
        existing = db.execute("SELECT size,state FROM blobs WHERE sha=?", (sha,)).fetchone()
        if existing != (len(PAYLOAD), "valid"):
            raise ValueError("blob index conflict")
        db.execute("INSERT INTO refs VALUES(?,?)", (publication, sha))
        db.execute("UPDATE commands SET status='ready' WHERE id=? AND status='planned'", (command,))
        crash("before_db_commit", selected)
        db.commit()
    crash("after_db_commit", selected)
    write_synced(receipt, json.dumps({"command": command, "sha": sha, "committed": True}).encode())
    crash("before_cleanup", selected)
    receipt.unlink(missing_ok=True)
    crash("after_cleanup", selected)


def inspect(case: Path) -> dict:
    case = bounded(case)
    files = {}
    for directory in ("staging", "blobs", "attempts", "rejected"):
        files[directory] = [{"name": p.name, "bytes": p.stat().st_size, "sha256": digest(p.read_bytes())}
                            for p in sorted((case / directory).iterdir()) if p.is_file()]
    with connect(case) as db:
        commands = [{"id": r[0], "publication": r[1], "sha": r[2], "status": r[3]}
                    for r in db.execute("SELECT * FROM commands ORDER BY id")]
        blobs = [{"sha": r[0], "bytes": r[1], "state": r[2]} for r in db.execute("SELECT * FROM blobs ORDER BY sha")]
        refs = list(db.execute("SELECT * FROM refs ORDER BY publication_id"))
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        foreign_keys = list(db.execute("PRAGMA foreign_key_check"))
    visible = {}
    for item in commands:
        try:
            data = read_publication(case, item["publication"])
            visible[item["publication"]] = {"readable": True, "bytes": len(data), "sha256": digest(data)}
        except (LookupError, ValueError, FileNotFoundError) as error:
            visible[item["publication"]] = {"readable": False, "reason": type(error).__name__}
    return {"files": files, "commands": commands, "blob_rows": blobs, "refs": refs,
            "visible": visible, "sqlite_integrity": integrity, "foreign_key_errors": foreign_keys}


def reconcile(case: Path) -> dict:
    case = bounded(case)
    actions = {"removed_staging": [], "removed_attempts": [], "removed_orphans": [], "invalidated": []}
    with connect(case) as db:
        indexed = {r[0] for r in db.execute("SELECT sha FROM blobs")}
        for sha, size in list(db.execute("SELECT sha,size FROM blobs")):
            path = case / "blobs" / sha
            valid = path.is_file() and path.stat().st_size == size and digest(path.read_bytes()) == sha
            if not valid:
                db.execute("UPDATE blobs SET state='invalid' WHERE sha=?", (sha,))
                db.execute("UPDATE commands SET status='blocked' WHERE publication_id IN (SELECT publication_id FROM refs WHERE sha=?)", (sha,))
                actions["invalidated"].append(sha)
        for path in (case / "blobs").iterdir():
            if path.name not in indexed:
                # Uncommitted outputs never become visible merely because files exist.
                path.unlink()
                actions["removed_orphans"].append(path.name)
    for directory, key in (("staging", "removed_staging"), ("attempts", "removed_attempts")):
        for path in (case / directory).iterdir():
            path.unlink()
            actions[key].append(path.name)
    return actions


def child(case: Path, selected: str | None = None, command: str = "request-1") -> subprocess.CompletedProcess:
    args = [sys.executable, str(Path(__file__).resolve()), "--child", str(bounded(case)), "--command", command]
    if selected:
        args += ["--crash", selected]
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", timeout=20)


def require(condition: bool, description: str, assertions: list[str]) -> None:
    if not condition:
        raise AssertionError(description)
    assertions.append(description)


def crash_case(case: Path, selected: str | None) -> dict:
    initialize(case)
    prepare(case)
    result = child(case, selected)
    before = inspect(case)
    checks: list[str] = []
    require(result.returncode == (80 + CRASHPOINTS.index(selected) if selected else 0), "child reached the requested termination point", checks)
    committed = selected in COMMITTED_POINTS or selected is None
    require(before["visible"]["book-1"]["readable"] is committed, "only a committed index permits content reads before reconciliation", checks)
    require(len(before["refs"]) == (1 if committed else 0), "SQLite rollback/commit is observed through a fresh connection", checks)
    if selected == "after_partial_staging":
        partial = before["files"]["staging"]
        require(len(partial) == 1 and 0 < partial[0]["bytes"] < len(PAYLOAD) and partial[0]["sha256"] != digest(PAYLOAD), "partial staging bytes really exist and fail the full content hash", checks)
    if selected == "after_fsynced_staging":
        require(before["files"]["staging"][0]["sha256"] == digest(PAYLOAD) and not before["files"]["blobs"], "complete fsynced staging exists without a final blob", checks)
    if selected in {"after_atomic_rename", "before_db_commit"}:
        require(len(before["files"]["blobs"]) == 1 and not before["refs"], "rename without committed index leaves an unreadable orphan", checks)
    actions = reconcile(case)
    retry = child(case)
    after = inspect(case)
    again = child(case)
    repeated = inspect(case)
    require(retry.returncode == 0 and again.returncode == 0, "recovery retry and repeated command both complete", checks)
    require(read_publication(case) == PAYLOAD, "recovered content matches the actual source bytes", checks)
    require(len(after["refs"]) == len(after["blob_rows"]) == len(after["commands"]) == 1, "retries create exactly one command, reference and blob", checks)
    require(after == repeated, "idempotent retry leaves the inspected durable state unchanged", checks)
    require(not after["files"]["staging"] and not after["files"]["attempts"], "reconciliation and retry remove stale staging and receipts", checks)
    require(after["sqlite_integrity"] == "ok" and not after["foreign_key_errors"], "SQLite integrity and foreign key checks pass", checks)
    return {"case": selected or "normal", "child_returncode": result.returncode,
            "retry_returncodes": [retry.returncode, again.returncode], "before_reconciliation": before,
            "reconciliation": actions, "after_retry": after, "asserted_observations": checks}


def extra_cases(run: Path) -> list[dict]:
    results = []
    case = run / "corrupt-committed"
    initialize(case); prepare(case)
    result = child(case)
    with connect(case) as db:
        sha = db.execute("SELECT sha FROM blobs").fetchone()[0]
    write_synced(case / "blobs" / sha, b"corrupted after commit")
    before = inspect(case)
    actions = reconcile(case)
    after = inspect(case)
    checks: list[str] = []
    require(result.returncode == 0 and not before["visible"]["book-1"]["readable"], "read checks actual blob bytes even before reconciliation", checks)
    require(after["commands"][0]["status"] == "blocked" and after["blob_rows"][0]["state"] == "invalid", "reconciliation blocks committed corruption", checks)
    require(child(case).returncode != 0, "idempotent retry cannot silently approve a corrupt blob", checks)
    results.append({"case": "corrupt-committed", "before": before, "after": after, "reconciliation": actions, "asserted_observations": checks})

    case = run / "wrong-expected-hash"
    initialize(case); prepare(case, expected_sha="0" * 64)
    result = child(case)
    observed = inspect(case)
    checks = []
    require(result.returncode != 0 and not observed["refs"] and not observed["files"]["blobs"] and not observed["files"]["staging"], "input hash mismatch is rejected before staging or indexing", checks)
    results.append({"case": "wrong-expected-hash", "child_returncode": result.returncode, "observed": observed, "asserted_observations": checks})

    case = run / "shared-blob"
    initialize(case); prepare(case)
    first = child(case)
    prepare(case, "request-2", "book-2")
    second = child(case, command="request-2")
    before = inspect(case)
    with connect(case) as db:
        db.execute("DELETE FROM refs WHERE publication_id='book-1'")
        db.execute("DELETE FROM commands WHERE id='request-1'")
    actions = reconcile(case)
    after = inspect(case)
    checks = []
    require(first.returncode == second.returncode == 0 and len(before["refs"]) == 2 and len(before["blob_rows"]) == 1, "two publications share one real content-addressed blob", checks)
    require(read_publication(case, "book-2") == PAYLOAD and len(after["files"]["blobs"]) == 1 and not actions["removed_orphans"], "removing one reference preserves the other publication's blob", checks)
    results.append({"case": "shared-blob", "child_returncodes": [first.returncode, second.returncode], "before": before, "after": after, "asserted_observations": checks})

    case = run / "offline-cursor"
    initialize(case); prepare(case)
    published = child(case)
    # Separate process commits cursor, then exits without normal interpreter cleanup.
    cursor_args = [sys.executable, str(Path(__file__).resolve()), "--cursor-child", str(case)]
    cursor_children = [subprocess.run(cursor_args, capture_output=True, timeout=20),
                       subprocess.run(cursor_args, capture_output=True, timeout=20),
                       subprocess.run(cursor_args + ["--cursor-revision", "0", "--cursor-locator", "chapter-1:paragraph-1"], capture_output=True, timeout=20)]
    with connect(case) as db:
        cursor = db.execute("SELECT locator,revision FROM cursors WHERE profile_id='guest' AND publication_id='book-1'").fetchone()
        cursor_count = db.execute("SELECT COUNT(*) FROM cursors").fetchone()[0]
    checks = []
    require(published.returncode == 0 and all(c.returncode == 91 for c in cursor_children), "offline cursor children exit abruptly after initial save, same-command retry and stale-revision retry", checks)
    require(cursor == ('chapter-1:paragraph-7', 1) and read_publication(case) == PAYLOAD, "a new connection reads the committed cursor and book without any server/network API", checks)
    require(cursor_count == 1, "repeated cursor save creates one row and an older revision cannot roll progress back", checks)
    results.append({"case": "offline-cursor", "child_returncodes": [c.returncode for c in cursor_children], "observed_cursor": {"locator": cursor[0], "revision": cursor[1], "rows": cursor_count}, "asserted_observations": checks})
    return results


def run_suite(keep: bool = False) -> dict:
    run = new_run()
    try:
        cases = [crash_case(run / point, point) for point in CRASHPOINTS]
        cases.append(crash_case(run / "normal", None))
        cases.extend(extra_cases(run))
        recorded_codes = []
        for case in cases:
            if "child_returncode" in case:
                recorded_codes.append(case["child_returncode"])
            recorded_codes.extend(case.get("child_returncodes", []))
            recorded_codes.extend(case.get("retry_returncodes", []))
        abrupt_codes = [code for code in recorded_codes if code in set(range(80, 88)) | {91}]
        return {"generated_at": datetime.now(timezone.utc).isoformat(), "scope": SCOPE,
                "protocol": "real child processes + same-filesystem rename + SQLite WAL/FULL + fresh-connection inspection",
                "cleanup_boundary": str(TEMP.resolve() / (PREFIX + "*")), "run_path": str(run),
                "temporary_artifacts_retained": keep,
                "limitations": ["Process death only: no physical power-loss or storage-controller fault experiment.",
                                "File fsync does not establish directory-entry durability on Windows; no cross-platform power-loss guarantee.",
                                "SQLite demonstration does not verify production PostgreSQL, deployed server or APK/EXE storage.",
                                "Single writer, bounded fixtures; no concurrent writers, antivirus, source parsing, migration or hostile symlink tests.",
                                "No sockets or server API are used by this probe; offline cursor is a storage demonstration only."],
                "counts": {"cases": len(cases), "crashpoints": len(CRASHPOINTS),
                           "abrupt_child_terminations": len(abrupt_codes),
                           "asserted_observations": sum(len(c["asserted_observations"]) for c in cases)},
                "abrupt_child_returncodes": abrupt_codes,
                "passed": True, "cases": cases}
    finally:
        if not keep:
            cleanup_run(run)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--child", type=Path)
    parser.add_argument("--cursor-child", type=Path)
    parser.add_argument("--cursor-revision", type=int, default=1)
    parser.add_argument("--cursor-locator", default="chapter-1:paragraph-7")
    parser.add_argument("--command", default="request-1")
    parser.add_argument("--crash", choices=CRASHPOINTS)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    if args.child:
        try:
            publish(args.child, args.command, args.crash)
        except (ValueError, LookupError, OSError, sqlite3.Error) as error:
            print(type(error).__name__ + ": " + str(error), file=sys.stderr)
            return 2
        return 0
    if args.cursor_child:
        with connect(args.cursor_child) as db:
            current = db.execute("SELECT locator,revision FROM cursors WHERE profile_id='guest' AND publication_id='book-1'").fetchone()
            if current and current[1] == args.cursor_revision and current[0] != args.cursor_locator:
                raise ValueError("same cursor revision cannot have two values")
            db.execute("""INSERT INTO cursors VALUES('guest','book-1',?,?)
                ON CONFLICT(profile_id,publication_id) DO UPDATE SET
                locator=excluded.locator,revision=excluded.revision
                WHERE excluded.revision > cursors.revision""", (args.cursor_locator, args.cursor_revision))
            db.commit()
            os._exit(91)
    report = run_suite(args.keep)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(REPORT), "scope": SCOPE, "counts": report["counts"], "passed": report["passed"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
