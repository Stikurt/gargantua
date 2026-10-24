"""Explicit real PostgreSQL backup acceptance. No production or external network.

Run directly; it deliberately is not part of the offline unittest discovery.
"""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
TOKEN = secrets.token_hex(16)
RUN = ROOT / ".local/test-results" / ("reader-journal-backup-" + TOKEN)
RUN.mkdir(parents=True)
DOCKER = Path(os.environ["LOCALAPPDATA"]) / "Programs/DockerDesktop/resources/bin/docker.exe"
NODE = ROOT / "node_modules/.bin/node.exe"
if not NODE.is_file():
    NODE = Path(os.environ["USERPROFILE"]) / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"
ENV = dict(os.environ, DOCKER_CONTEXT="desktop-linux")
for key in ("DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
    ENV.pop(key, None)
LABEL = "gargantua.reader-journal-backup-test"
NAMES = ["gargantua-reader-journal-source-" + TOKEN, "gargantua-reader-journal-restore-" + TOKEN]
PROFILE = "10000000-0000-4000-8000-000000000001"
IMPORT = "20000000-0000-4000-8000-000000000002"
BOOK = "30000000-0000-4000-8000-000000000003"
MARK = "40000000-0000-4000-8000-000000000004"
DEVICE = "70000000-0000-4000-8000-000000000007"
NEWMARK = "80000000-0000-4000-8000-000000000008"
FIRST = "90000000-0000-4000-8000-000000000009"
SECOND = "a0000000-0000-4000-8000-00000000000a"
V2MARK = "b0000000-0000-4000-8000-00000000000b"
V2DEVICE = "c0000000-0000-4000-8000-00000000000c"
STAMP = "2026-10-23T12:00:00.000Z"
spec = importlib.util.spec_from_file_location("backup_artifacts", ROOT / "scripts/backup-artifacts.py")
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
created = []
report = {"scope": "REAL_POSTGRESQL_NETWORK_NONE_SAME_SNAPSHOT_DUMP_PLUS_SECOND_DATABASE_RESTORE", "productionDatabaseUsed": False,
          "externalNetwork": False, "status": "running", "createdAt": datetime.now(timezone.utc).isoformat(), "checks": []}
SOURCES = ["scripts/backup-artifacts.py", "scripts/backup.ps1", "scripts/backup-space.ps1", "tests/reader-backup.acceptance.py",
           "server/migrations/001-baseline.sql", "server/migrations/009-reader-data.sql", "server/migrations/010-reader-journal-retention.sql"]
report["sourceSha256"] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}
backup.atomic_json(RUN / "test-owner.json", {"token": TOKEN, "root": str(RUN)})


def command(args, data=None, timeout=90, allow_failure=False):
    result = subprocess.run([str(DOCKER), *args], input=data if isinstance(data, bytes) else data.encode("utf-8") if data is not None else None,
                            capture_output=True, env=ENV, cwd=ROOT, timeout=timeout)
    if result.returncode and not allow_failure:
        raise RuntimeError("Owned Docker operation failed: " + args[0] + " " + result.stderr.decode("utf-8", errors="replace")[-1200:])
    return result if allow_failure else result.stdout.decode("utf-8", errors="strict").strip()


def psql(name, sql, timeout=90, allow_failure=False):
    return command(["exec", "-i", name, "psql", "-h", "127.0.0.1", "-X", "-qAt", "-U", "cotology_app", "-d", "library", "-v", "ON_ERROR_STOP=1"], sql, timeout, allow_failure)


def q(value):
    return "'" + str(value).replace("'", "''") + "'"


def js(value):
    return q(json.dumps(value, ensure_ascii=False)) + "::jsonb"


def check(name, condition=True):
    if not condition:
        raise AssertionError(name)
    report["checks"].append(name)


def make_database(name, image):
    created.append(name)
    identity = command(["run", "-d", "--pull", "never", "--name", name, "--label", LABEL + "=" + TOKEN,
                        "--network", "none", "--read-only", "--tmpfs", "/var/lib/postgresql/data:size=256m", "--tmpfs", "/var/run/postgresql",
                        "--tmpfs", "/tmp:size=128m,mode=1777", "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
                        "-e", "POSTGRES_USER=cotology_app", "-e", "POSTGRES_DB=library", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", image])
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            if psql(name, "SELECT 1;", 10) == "1":
                return identity
        except RuntimeError:
            pass
        time.sleep(.5)
    raise RuntimeError("Owned PostgreSQL readiness deadline")


def copy_from(name, remote, destination):
    size = int(command(["exec", name, "stat", "-c", "%s", "--", remote]))
    if not 0 <= size <= 8 * 1024**2:
        raise RuntimeError("Synthetic fixture transfer exceeds explicit 8 MiB bound")
    raw = base64.b64decode(command(["exec", name, "base64", "--wrap=0", remote]), validate=True)
    if len(raw) != size:
        raise RuntimeError("Fixture transfer byte count differs")
    Path(destination).write_bytes(raw)


def canon(body):
    code = "import{canonicalJson}from'./server/publication-model.mjs';import{createHash}from'node:crypto';const body=JSON.parse(process.argv[1]),canonical=canonicalJson(body);console.log(JSON.stringify({canonical,sha256:createHash('sha256').update(canonical).digest('hex')}));"
    return json.loads(subprocess.check_output([str(NODE), "--input-type=module", "-e", code, json.dumps(body, ensure_ascii=False)], cwd=ROOT, text=True, encoding="utf-8"))


def snapshot_database(source, destination, image, expectation):
    destination.mkdir()
    bookdir = destination / "books" / BOOK
    bookdir.mkdir(parents=True)
    backup.atomic_json(bookdir / "book.json", book)
    remote = "/tmp/gargantua-snapshot-" + secrets.token_hex(16)
    command(["exec", source, "mkdir", "-m", "700", remote])
    sql = backup.inventory_sql(remote, True)
    (destination / "source-inventory.sql").write_text(sql, encoding="utf-8", newline="\n")
    psql(source, sql, 120)
    for name in ("database.dump", "db-inventory.json", "db-table-fingerprints.jsonl", "reader-metadata.jsonl"):
        copy_from(source, remote + "/" + name, destination / name)
    expected_hash = command(["exec", source, "sha256sum", "--", remote + "/reader-metadata.jsonl"]).split()[0]
    check(expectation + ": source metadata SHA256 matches copied bytes", hashlib.sha256((destination / "reader-metadata.jsonl").read_bytes()).hexdigest() == expected_hash)
    with tarfile.open(destination / "source.tar.gz", "w:gz") as archive:
        member = tarfile.TarInfo("compose.yaml")
        data = b"# Synthetic acceptance fixture, not deployment source\nservices: {}\n"
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    backup.atomic_json(destination / "snapshot-metadata.json", {"handlersRestored": True, "snapshotProtocol": "pg-exported-repeatable-read",
                       "sourceDatabaseImage": image, "sourceArchiveScope": "SYNTHETIC ACCEPTANCE FIXTURE, NOT DEPLOYMENT SOURCE"})
    finalized = backup.finalize(destination)
    check(expectation + ": source SQL metadata passes full semantic validation")
    return finalized


def restore_database(snapshot, restored, image, expectation):
    make_database(restored, image)
    command(["exec", "-i", restored, "pg_restore", "-U", "cotology_app", "-d", "library", "--no-owner", "--no-acl", "--single-transaction", "--exit-on-error"], (snapshot / "database.dump").read_bytes(), 120)
    restored_root = snapshot.parent / (snapshot.name + "-restored")
    restored_root.mkdir()
    bookdir = restored_root / "books" / BOOK
    bookdir.mkdir(parents=True)
    backup.atomic_json(bookdir / "book.json", book)
    remote = "/tmp/gargantua-verify-" + secrets.token_hex(16)
    command(["exec", restored, "mkdir", "-m", "700", remote])
    psql(restored, backup.inventory_sql(remote, False), 120)
    for name in ("db-inventory.json", "db-table-fingerprints.jsonl"):
        copy_from(restored, remote + "/" + name, restored_root / name)
    compared = backup.compare_restore(snapshot, restored_root, restored_root / "books")
    check(expectation + ": restored data and all table fingerprints match source", compared["databaseTablesCompared"] >= 14)
    return compared


def remove_owned(name):
    owner = command(["inspect", "--format", '{{index .Config.Labels "' + LABEL + '"}}', name])
    if owner != TOKEN:
        raise RuntimeError("Owned test container label mismatch")
    command(["rm", "-f", name])
    created.remove(name)


try:
    image = command(["image", "inspect", "--format", "{{.Id}}", "postgres:17-bookworm"])
    report["postgresImageId"] = image
    source, restored = NAMES
    make_database(source, image)
    book = {"title": "Исходная книга — 日本語", "author": "Тестовый автор", "language": "ru", "chapters": [{"title": "Глава", "blocks": [{"type": "text", "text": "Безопасный текст для проверки восстановления."}]}], "assets": {}}
    legacy = "\n".join([
        f"INSERT INTO profiles(id,login,password) VALUES({q(PROFILE)},'reader-backup-fixture','synthetic-not-a-real-password');",
        f"INSERT INTO sessions(token_hash,profile_id,csrf,expires_at) VALUES('synthetic-session',{q(PROFILE)},'synthetic-csrf',now()+interval '1 day');",
        f"INSERT INTO imports(id,requested_by,kind,status,book_id) VALUES({q(IMPORT)},{q(PROFILE)},'upload','completed',{q(BOOK)});",
        f"INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by) VALUES({q(BOOK)},{q(book['title'])},{q(book['author'])},'ru',1,{'0'*64!r},{q(IMPORT)},{q(PROFILE)});",
        f"INSERT INTO reading(profile_id,book_id,chapter,position,shelf) VALUES({q(PROFILE)},{q(BOOK)},0,0.25,'reading');",
        f"INSERT INTO bookmarks(id,profile_id,book_id,chapter,position,note) VALUES({q(MARK)},{q(PROFILE)},{q(BOOK)},0,0.5,'Прежняя метка — 日本語');",
        f"INSERT INTO profile_catalogs(profile_id,revision,catalogs) VALUES({q(PROFILE)},0,'[]');"])
    psql(source, "BEGIN;\n" + (ROOT / "server/migrations/001-baseline.sql").read_text(encoding="utf-8") + "\n" + legacy + "\n" + (ROOT / "server/migrations/009-reader-data.sql").read_text(encoding="utf-8") + "\nCOMMIT;")
    payload = {"publicationId": BOOK, "publicationRevision": 1, "locator": {"type": "legacy", "chapter": 0, "position": 1e-7}, "note": "Новая метка — 日本語"}
    first = {"mutationId": FIRST, "deviceId": DEVICE, "counter": 1, "entityType": "bookmark", "entityId": NEWMARK, "baseRevision": 0, "operation": "upsert", "payload": payload}
    second = {**first, "mutationId": SECOND, "counter": 2, "payload": {**payload, "note": "Конфликт сохранён отдельно"}}
    entity = {"entityType": "bookmark", "entityId": NEWMARK, "revision": 1, "deleted": False, "payload": payload, "updatedAt": STAMP}
    fixture = [f"UPDATE reader_profiles SET revision=1 WHERE profile_id={q(PROFILE)};", f"INSERT INTO reader_devices(profile_id,device_id,last_counter) VALUES({q(PROFILE)},{q(DEVICE)},2);",
               f"INSERT INTO reader_entities(profile_id,entity_type,entity_id,revision,deleted,payload,legacy_id) VALUES({q(PROFILE)},'bookmark',{q(NEWMARK)},1,false,{js(payload)},{q(NEWMARK)});",
               f"INSERT INTO bookmarks(id,profile_id,book_id,chapter,position,note) VALUES({q(NEWMARK)},{q(PROFILE)},{q(BOOK)},0,0.0000001,{q(payload['note'])});",
               f"INSERT INTO reader_changes(profile_id,change_revision,entity_type,entity_id,record) VALUES({q(PROFILE)},1,'bookmark',{q(NEWMARK)},{js(entity)});"]
    for body, result in ((first, {"mutationId": FIRST, "status": "accepted", "entity": entity}), (second, {"mutationId": SECOND, "status": "conflict", "code": "REVISION_CONFLICT", "current": entity, "proposed": second})):
        receipt = canon(body)
        fixture.append(f"INSERT INTO reader_mutations(profile_id,mutation_id,device_id,counter,body_sha256,canonical_body,body,result) VALUES({q(PROFILE)},{q(body['mutationId'])},{q(DEVICE)},{body['counter']},{q(receipt['sha256'])},{q(receipt['canonical'])},{js(body)},{js(result)});")
    psql(source, "BEGIN;\n" + "\n".join(fixture) + "\nCOMMIT;")
    check("legacy reader exact-byte preflight passes before migration", json.loads(psql(source, backup.reader_preflight_sql()))["legacyReaderChecked"])
    old_snapshot = RUN / "v1-snapshot"
    report["v1SourceValidation"] = snapshot_database(source, old_snapshot, image, "legacy v1")
    report["v1RestoreValidation"] = restore_database(old_snapshot, restored, image, "legacy v1")
    check("legacy snapshots use their original MD5 fingerprint format", all("algorithm" not in row for row in backup.table_fingerprints(old_snapshot / "db-table-fingerprints.jsonl").values()))
    remove_owned(restored)
    psql(source, "BEGIN;\n" + (ROOT / "server/migrations/010-reader-journal-retention.sql").read_text(encoding="utf-8") + "\nCOMMIT;")
    denied = psql(source, "CREATE ROLE reader_fingerprint_limited NOLOGIN NOSUPERUSER; SET ROLE reader_fingerprint_limited; SELECT public.gargantua_table_fingerprint_v2('profiles'::regclass);", allow_failure=True)
    check("streaming fingerprint function preserves caller permissions", denied.returncode != 0 and b"permission denied" in denied.stderr)
    functions = json.loads(psql(source, "SELECT json_build_object('securityDefiner',p.prosecdef,'volatility',p.provolatile) FROM pg_proc p WHERE p.oid='public.gargantua_table_fingerprint_v2(regclass)'::regprocedure;"))
    check("streaming fingerprint is stable and invokes with caller permissions", functions == {"securityDefiner": False, "volatility": "s"})
    ordered = psql(source, "BEGIN; CREATE TEMP TABLE fingerprint_fixture(value text); INSERT INTO fingerprint_fixture VALUES('日本語'),('a'),('a'); SELECT public.gargantua_table_fingerprint_v2('fingerprint_fixture'::regclass); TRUNCATE fingerprint_fixture; INSERT INTO fingerprint_fixture VALUES('a'),('日本語'),('a'); SELECT public.gargantua_table_fingerprint_v2('fingerprint_fixture'::regclass); ROLLBACK;")
    first_hash, reordered_hash = [json.loads(line) for line in ordered.splitlines()]
    check("streaming fingerprint preserves duplicate multiplicity and ignores insertion order", first_hash == reordered_hash and first_hash["count"] == 3)
    compacted = {"mutationId": FIRST, "status": "accepted", "compacted": True, "entityType": "bookmark", "entityId": NEWMARK, "revision": 1, "snapshotRequired": True}
    psql(source, f"UPDATE reader_mutations SET compacted=true,body=NULL,canonical_body=NULL,result={js(compacted)} WHERE mutation_id={q(FIRST)};")
    v2_body = {"mutationId": backup.reader_mutation_id(PROFILE, V2DEVICE, 2), "deviceId": V2DEVICE, "counter": 2, "entityType": "bookmark", "entityId": V2MARK, "baseRevision": 1, "operation": "delete", "protocolVersion": 2}
    v2_payload = {**payload, "note": "Текст удалённой метки сохранён — 日本語"}
    v2_first = {"entityType": "bookmark", "entityId": V2MARK, "revision": 1, "deleted": False, "payload": v2_payload, "updatedAt": STAMP}
    v2_deleted = {**v2_first, "revision": 2, "deleted": True}
    receipt = canon(v2_body)
    modern = [f"UPDATE reader_profiles SET revision=3 WHERE profile_id={q(PROFILE)};",
              f"INSERT INTO reader_devices(profile_id,device_id,last_counter,protocol_version,compacted_through,compacted_accepted,compaction_sha256) VALUES({q(PROFILE)},{q(V2DEVICE)},2,2,1,1,{'a'*64!r});",
              f"INSERT INTO reader_entities(profile_id,entity_type,entity_id,revision,deleted,payload,modern_write) VALUES({q(PROFILE)},'bookmark',{q(V2MARK)},2,true,{js(v2_payload)},true);",
              f"INSERT INTO reader_changes(profile_id,change_revision,entity_type,entity_id,record) VALUES({q(PROFILE)},2,'bookmark',{q(V2MARK)},{js(v2_first)}),({q(PROFILE)},3,'bookmark',{q(V2MARK)},{js(v2_deleted)});",
              f"INSERT INTO reader_mutations(profile_id,mutation_id,device_id,counter,body_sha256,canonical_body,body,result,entity_type,entity_id,accepted_revision) VALUES({q(PROFILE)},{q(v2_body['mutationId'])},{q(V2DEVICE)},2,{q(receipt['sha256'])},{q(receipt['canonical'])},{js(v2_body)},{js({'mutationId':v2_body['mutationId'],'status':'accepted','entity':v2_deleted})},'bookmark',{q(V2MARK)},2);"]
    psql(source, "BEGIN;\n" + "\n".join(modern) + "\nCOMMIT;")
    probe = json.loads(psql(source, backup.reader_preflight_sql()))
    check("new exact budget preflight passes before any staging", probe["supported"] and probe["rows"] > 0 and probe["bytes"] > 0)
    # Corrupt only this owned fixture. The before-stop probe must detect drift.
    psql(source, "UPDATE reader_journal_budget SET bytes=bytes+1 WHERE singleton;")
    denied = psql(source, backup.reader_preflight_sql(), allow_failure=True)
    check("accounting drift is rejected by real read-only preflight", denied.returncode != 0)
    psql(source, "UPDATE reader_journal_budget SET (rows,bytes)=(SELECT rows,bytes FROM reader_journal_measure()) WHERE singleton;")
    check("repaired exact reader budget agrees independently", json.loads(psql(source, backup.reader_preflight_sql()))["bytes"] == probe["bytes"])
    snapshot = RUN / "v2-snapshot"
    report["v2SourceValidation"] = snapshot_database(source, snapshot, image, "journal v2")
    check("new snapshots use named SHA256 streaming fingerprints for every table", all(row.get("algorithm") == "sha256-sorted-fold-v2" and len(row["fingerprint"]) == 64 for row in backup.table_fingerprints(snapshot / "db-table-fingerprints.jsonl").values()))
    checked = report["v2SourceValidation"]["library"]
    check("v2 source checks compacted legacy receipt, pruned accepted fence and retained full conflict", checked["readerCompactedReceiptsChecked"] == 1 and checked["readerPrunedAcceptedChecked"] == 1 and checked["readerReceiptsChecked"] == 3)
    command(["stop", "--time", "10", source])
    report["v2RestoreValidation"] = restore_database(snapshot, restored, image, "journal v2")
    check("v2 restored receipt retains the exact protocol integer and bound device version", psql(restored, f"SELECT (m.body->>'protocolVersion')='2' AND jsonb_typeof(m.body->'protocolVersion')='number' AND d.protocol_version=2 AND m.body_sha256={q(receipt['sha256'])} FROM reader_mutations m JOIN reader_devices d USING(profile_id,device_id) WHERE m.mutation_id={q(v2_body['mutationId'])};") == "t")
    check("v2 restored sessions are empty", psql(restored, "SELECT count(*) FROM sessions;") == "0")
    check("v2 restored conflict retains full proposed private note", psql(restored, f"SELECT result->'proposed'->'payload'->>'note' FROM reader_mutations WHERE mutation_id={q(SECOND)};") == "Конфликт сохранён отдельно")
    check("v2 restored compacted legacy identity retains exact original hash", psql(restored, f"SELECT body_sha256 FROM reader_mutations WHERE mutation_id={q(FIRST)};") == canon(first)["sha256"])
    # Audit is intentionally absent from the bounded semantic main inventory.
    # Its full streaming table fingerprint must still detect a changed row.
    psql(restored, f"INSERT INTO audit(actor,action,target,details) VALUES({q(PROFILE)},'synthetic.mutation','fixture','{{}}');")
    changed_remote = "/tmp/gargantua-verify-" + secrets.token_hex(16)
    command(["exec", restored, "mkdir", "-m", "700", changed_remote])
    psql(restored, backup.inventory_sql(changed_remote, False), 120)
    restored_root = snapshot.parent / (snapshot.name + "-restored")
    for name in ("db-inventory.json", "db-table-fingerprints.jsonl"):
        copy_from(restored, changed_remote + "/" + name, restored_root / name)
    try:
        backup.compare_restore(snapshot, restored_root, restored_root / "books")
    except ValueError as error:
        check("changed audit row is detected by the full streaming table fingerprint", "fingerprints differ" in str(error))
    else:
        raise AssertionError("Changed restored audit row escaped its fingerprint")
    check("source bytes unchanged throughout acceptance", all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == value for name, value in report["sourceSha256"].items()))
    report["status"] = "passed"
except Exception as error:
    report["status"] = "failed"
    report["error"] = str(error)
finally:
    errors = []
    for name in reversed(list(created)):
        try:
            remove_owned(name)
        except Exception as error:
            errors.append(str(error))
    report["cleanupErrors"] = errors
    if errors:
        report["status"] = "failed"
    report["completedAt"] = datetime.now(timezone.utc).isoformat()
    backup.atomic_json(RUN / "report.json", report)
    print(json.dumps({"status": report["status"], "checks": len(report["checks"]), "report": str(RUN / "report.json"), "error": report.get("error"), "cleanupErrors": errors}, ensure_ascii=False))
if report["status"] != "passed":
    sys.exit(1)
