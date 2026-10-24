"""Synthetic restore data and assertions. Standard library only; never opens Docker.

All generated files must be placed by the orchestrator in its new owned test root.
No production fixture, password, URL, title, note or catalogue is read here.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import struct
import zlib


def identity(number):
    return f"00000000-0000-4000-8000-{number:012x}"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sql_value(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (dict, list)):
        return "'" + json.dumps(value, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    return "'" + str(value).replace("'", "''") + "'"


def insert(table, rows):
    if not rows:
        return ""
    keys = list(rows[0])
    require(all(set(row) == set(keys) for row in rows), "Fixture insert columns differ")
    return f"INSERT INTO {table}({','.join(keys)}) VALUES\n" + ",\n".join(
        "(" + ",".join(sql_value(row[key]) for key in keys) + ")" for row in rows
    ) + ";\n"


def red_png():
    def chunk(name, data):
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff")) + chunk(b"IEND", b"")


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def chapter_hash(book, index):
    def normalize(value):
        if isinstance(value, list): return [normalize(item) for item in value]
        if isinstance(value, dict):
            return {key: "sha256:" + hashlib.sha256(base64.b64decode(book["assets"][item])).hexdigest()
                    if key in ("asset", "resource") and isinstance(item, str) and item in book["assets"] else normalize(item) for key, item in value.items()}
        return value
    return hashlib.sha256(canonical(normalize({"chapter": book["chapters"][index], "structure": book.get("structure", {}).get("chapters", [None] * len(book["chapters"]))[index]})).encode()).hexdigest()


def ranobe_fixture(owners, books, contents, png, now, moment, import_rows, attempts, package_sha256):
    feeds, runs = [identity(n) for n in (1101, 1102)], [identity(n) for n in (1201, 1202, 1203)]
    parents, children = [identity(n) for n in (1301, 1302, 1303)], [identity(n) for n in (1401, 1402, 1403)]
    policy = "synthetic-ranobe-full-v1"
    keys = ["v1:n" + str(n) for n in range(1, 6)]
    maps, cached, parts, requests, run_rows, feed_rows = [], [], [], [], [], []
    for index in range(3):
        feed_index = 1 if index == 2 else 0
        actor, branch = owners[feed_index], "42" if feed_index else "default"
        active = index == 1
        parent_options = {"mode": "full", "branch": None if branch == "default" else branch, "language": "ru", "force": False, "feedId": feeds[feed_index]}
        child_keys = [keys[3]] if active else keys[:3]
        for is_child, ident in ((False, parents[index]), (True, children[index])):
            token = identity(1501 + index * 2 + int(is_child))
            options = {"ranobePart": {"parentId": parents[index], "runId": runs[index], "keys": child_keys, "title": "Синтетическая часть"}} if is_child else parent_options
            import_rows.append({"id": ident, "requested_by": actor, "kind": "ranobe-part" if is_child else "ranobe", "filename": "Synthetic full Ranobe checkpoint",
                                "source_url": None if is_child else "https://ranobelib.me/ru/book/123456--synthetic-fixture", "status": "processing" if active else "completed",
                                "stage": "Synthetic full feed: never execute", "security_state": "scanning" if active else "passed", "report": {"synthetic": True, "feedId": feeds[feed_index]},
                                "error": None, "book_id": None if active else books[0], "approved_by": owners[0], "decision_reason": "owner-approval", "created_at": moment,
                                "updated_at": moment, "options": options, "attempt_number": 1, "attempt_token": token,
                                "lease_expires_at": (now + timedelta(hours=1)).isoformat() if active else None, "cleanup_pending": False, "cleanup_error": None})
            attempts.append({"token": token, "import_id": ident, "number": 1, "book_id": identity(1601 + index * 2 + int(is_child)),
                             "state": "running" if active else "reused" if is_child else "published", "artifact_manifest": None, "error": None, "cleanup_error": None,
                             "cleanup_checked_at": None, "started_at": moment, "ended_at": None if active else moment, "reused_book_id": books[0] if is_child and not active else None})
        requests.append({"id": identity(1701 + index), "feed_id": feeds[feed_index], "profile_id": actor, "idempotency_key": identity(1801 + index),
                         "body_sha256": hashlib.sha256(("synthetic-full-request-" + str(index)).encode()).hexdigest(), "import_id": parents[index], "result_run_id": None if active else runs[index], "created_at": moment})
        items = [{"key": key, "revisionHint": "r1", "title": contents[0]["chapters"][i]["title"] if i < 3 else "Новая глава " + str(i+1), "volume": "1", "number": str(i+1)} for i, key in enumerate(keys[:5 if active else 3])]
        run_rows.append({"id": runs[index], "feed_id": feeds[feed_index], "import_id": parents[index], "previous_head_id": runs[0] if active else None,
                         "inventory_sha256": hashlib.sha256(canonical(items).encode()).hexdigest(), "chapter_count": len(items), "policy_version": policy,
                         "force_revalidate": False, "status": "building" if active else "ready", "created_at": moment, "activated_at": None if active else moment})
        for ordinal, item in enumerate(items):
            checkpoint_id = identity(1901 + feed_index * 10 + ordinal) if ordinal < 4 else None
            maps.append({"run_id": runs[index], "feed_id": feeds[feed_index], "ordinal": ordinal, "source_key": item["key"], "revision_hint": item["revisionHint"],
                         "metadata": {key: item[key] for key in ("title", "volume", "number")}, "chapter_id": checkpoint_id})
        parts.append({"id": identity(2001 + index), "run_id": runs[index], "ordinal": 3 if active else 0, "keys_sha256": hashlib.sha256(canonical(child_keys).encode()).hexdigest(),
                      "source_keys": child_keys, "import_id": children[index], "book_id": None if active else books[0], "package_sha256": None if active else package_sha256,
                      "status": "building" if active else "ready", "created_at": moment})
    # Another reader's same-branch request shares the original import without
    # changing the initiator or the immutable publication's provenance.
    requests.append({**requests[0], "id": identity(1704), "profile_id": owners[2], "idempotency_key": identity(1804)})
    # A later no-change update records a new initiative, but no new immutable
    # run, chapter map or part. Its result belongs to the prior parent import.
    previous_parent = next(row for row in import_rows if row["id"] == parents[0])
    no_change = {**previous_parent, "id": identity(1304), "requested_by": owners[2], "attempt_token": identity(1507),
                 "stage": "Synthetic no-change update", "report": {"synthetic": True, "feedId": feeds[0], "runId": runs[0], "unchanged": True}}
    import_rows.append(no_change)
    attempts.append({"token": identity(1507), "import_id": no_change["id"], "number": 1, "book_id": identity(1607), "state": "reused", "artifact_manifest": None,
                     "error": None, "cleanup_error": None, "cleanup_checked_at": None, "started_at": moment, "ended_at": moment, "reused_book_id": books[0]})
    requests.append({"id": identity(1705), "feed_id": feeds[0], "profile_id": owners[2], "idempotency_key": identity(1805),
                     "body_sha256": hashlib.sha256(b"synthetic-no-change-request").hexdigest(), "import_id": no_change["id"], "result_run_id": runs[0], "created_at": moment})
    prepared = {"title": "Тестовая серия — полная подписка", "author": "Вымышленный автор", "language": "ru",
                "chapters": [{"title": "Новая глава 4", "blocks": [{"type": "text", "text": "Сохранённый проверенный checkpoint 🌌"}, {"type": "image", "asset": "image-0.png", "text": "Карта"}]}],
                "assets": {"image-0.png": base64.b64encode(png).decode()},
                "structure": {"schemaVersion": 2, "warnings": [], "chapters": [{"id": "feed-1-chapter-4", "revision": 1, "title": "Новая глава 4", "blocks": [
                    {"id": "feed-1-chapter-4-text", "type": "paragraph", "text": "Сохранённый проверенный checkpoint 🌌"},
                    {"id": "feed-1-chapter-4-image", "type": "image", "text": "Карта", "resource": "image-0.png"}]}]}}
    for feed_index in range(2):
        feed_rows.append({"id": feeds[feed_index], "provider": "ranobelib", "remote_id": "123456", "slug": "123456--synthetic-fixture", "branch_key": "42" if feed_index else "default",
                          "language": "ru", "title": prepared["title"], "author": prepared["author"], "requested_by": owners[feed_index], "approved_by": owners[0],
                          "auto_update": True, "update_interval_hours": 6, "next_check_at": (now + timedelta(hours=6)).isoformat(), "revision": 3,
                          "active_import_id": parents[1] if feed_index == 0 else None, "head_run_id": runs[2] if feed_index else runs[0], "created_at": moment, "updated_at": moment})
        for ordinal in range(4 if feed_index == 0 else 3):
            is_prepared = ordinal == 3
            content = prepared if is_prepared else contents[0]
            cached.append({"id": identity(1901 + feed_index * 10 + ordinal), "feed_id": feeds[feed_index], "source_key": keys[ordinal], "revision_hint": "r1", "policy_version": policy,
                           "raw_sha256": hashlib.sha256(("synthetic-raw-" + str(ordinal)).encode()).hexdigest(), "content_sha256": chapter_hash(content, 0 if is_prepared else ordinal),
                           "prepared_book": prepared if is_prepared else None, "prepared_bytes": len(canonical(content).encode()), "scanner_version": "Synthetic fixture — no scanner claim",
                           "parser_version": policy, "book_id": None if is_prepared else books[0], "chapter_index": None if is_prepared else ordinal, "created_at": moment})
    scratch = [{"token": identity(2101), "parent_attempt": identity(1503), "run_id": runs[1], "source_key": keys[4], "raw_sha256": None, "created_at": moment}]
    # Store ready snapshots as building until their immutable children exist.
    sql = insert("ranobe_feeds", [{**row, "head_run_id": None} for row in feed_rows]) + insert("ranobe_chapters", cached)
    for index, row in enumerate(run_rows):
        sql += insert("ranobe_runs", [{**row, "status": "building", "activated_at": None}])
        sql += insert("ranobe_run_chapters", [item for item in maps if item["run_id"] == row["id"]])
        sql += insert("ranobe_run_parts", [item for item in parts if item["run_id"] == row["id"]])
        if row["status"] == "ready":
            sql += "UPDATE ranobe_runs SET status='ready',activated_at=" + sql_value(moment) + " WHERE id=" + sql_value(row["id"]) + ";\n"
        if index == 0:
            sql += "UPDATE ranobe_feeds SET head_run_id=" + sql_value(row["id"]) + " WHERE id=" + sql_value(feeds[0]) + ";\n"
    sql += "UPDATE ranobe_feeds SET head_run_id=" + sql_value(runs[2]) + " WHERE id=" + sql_value(feeds[1]) + ";\n"
    sql += insert("ranobe_feed_requests", requests) + insert("ranobe_scratch", scratch)
    return {"ranobe_feeds": feed_rows, "ranobe_feed_requests": requests, "ranobe_runs": run_rows, "ranobe_chapters": cached,
            "ranobe_run_chapters": maps, "ranobe_run_parts": parts, "ranobe_scratch": scratch}, sql


def build(root):
    root = root.resolve()
    require(root.is_dir() and not root.is_symlink(), "Fixture target must already be an owned directory")
    require(not (root / "expected.json").exists(), "Refusing to overwrite a fixture")
    now = datetime.now(timezone.utc)
    moment = "2024-01-02T03:04:05+00:00"
    owners = [identity(n) for n in (1, 2, 3)]
    books = [identity(n) for n in (101, 102)]
    requests = [identity(n) for n in range(201, 211)]
    tokens = [identity(n) for n in range(301, 308)]
    profiles = [{"id": ident, "login": "fixture_" + role.replace("-", "_"), "password": "fixture-disabled-login-" + role,
                 "role": role, "created_at": moment} for ident, role in zip(owners, ("owner", "reader", "trusted-import"))]
    png = red_png()
    contents = [
        {"title": "Тестовая серия — том 1", "author": "Вымышленный автор", "language": "ru", "chapters": [
            {"title": "Начало", "blocks": [{"type": "heading", "text": "Синтетическая книга"}, {"type": "text", "text": "Эти данные созданы только для проверки восстановления."}]},
            {"title": "Карта", "blocks": [{"type": "image", "asset": "image-0.png", "text": "Тестовый красный пиксель"}, {"type": "text", "text": "Подпись сохраняется вместе с иллюстрацией."}]},
            {"title": "Финал", "blocks": [{"type": "text", "text": "Конец первой тестовой книги."}]}
        ], "assets": {"image-0.png": base64.b64encode(png).decode("ascii")}},
        {"title": "Тестовая серия — том 2", "author": "Вымышленный автор", "language": "ru", "chapters": [
            {"title": "Продолжение", "blocks": [{"type": "text", "text": "Вторая отдельная публикация."}]},
            {"title": "Последняя глава", "blocks": [{"type": "text", "text": "Порядок томов в каталоге задаётся вручную."}]}
        ], "assets": {}}
    ]
    publications = []
    for index, (ident, content) in enumerate(zip(books, contents)):
        directory = root / "books" / ident
        directory.mkdir(parents=True)
        raw = json.dumps(content, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        (directory / "book.json").write_bytes(raw)
        files = [{"path": "book.json", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}]
        if content["assets"]:
            (directory / "image-0.png").write_bytes(png)
            files.append({"path": "image-0.png", "bytes": len(png), "sha256": hashlib.sha256(png).hexdigest()})
        manifest = {"schemaVersion": 1, "files": sorted(files, key=lambda value: value["path"])}
        package = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
        publications.append({"id": ident, "title": content["title"], "author": content["author"], "language": "ru",
                             "chapter_count": len(content["chapters"]), "sha256": hashlib.sha256(("synthetic-source-" + str(index)).encode()).hexdigest(),
                             "import_id": requests[index], "requested_by": owners[index], "security_state": "passed", "created_at": moment,
                             "content_sha256": hashlib.sha256(raw).hexdigest(), "content_bytes": len(raw), "package_sha256": package,
                             "artifact_manifest": manifest})
    statuses = ("completed", "completed", "processing", "processing", "processing", "queued", "uploading", "pending-approval", "error", "completed")
    import_rows = []
    for index, (ident, status) in enumerate(zip(requests, statuses)):
        attempt_index = index if index < 5 else 5 if index == 8 else 6 if index == 9 else None
        active = status == "processing"
        import_rows.append({"id": ident, "requested_by": owners[index % 3], "kind": "upload", "filename": f"synthetic-{index+1}.epub",
                            "source_url": None, "status": status, "stage": "Synthetic fixture: never execute", "security_state": "passed" if status == "completed" else "pending",
                            "report": {"synthetic": True, "case": index + 1}, "error": "Synthetic failed attempt" if status == "error" else None,
                            "book_id": books[index] if index < 2 else books[0] if index == 9 else None, "approved_by": owners[0], "decision_reason": "synthetic-fixture",
                            "created_at": moment, "updated_at": moment, "options": {"synthetic": True}, "attempt_number": 1 if attempt_index is not None else 0,
                            "attempt_token": tokens[attempt_index] if attempt_index is not None else None,
                            "lease_expires_at": (now + timedelta(hours=-1 if index == 3 else 1)).isoformat() if active else None,
                            "cleanup_pending": index == 0, "cleanup_error": "Synthetic cleanup marker" if index == 0 else None})
    attempts = []
    for index, (request_index, state) in enumerate(zip((0, 1, 2, 3, 4, 8, 9), ("published", "published", "running", "prepared", "placed", "failed", "reused"))):
        attempts.append({"token": tokens[index], "import_id": requests[request_index], "number": 1,
                         "book_id": books[index] if index < 2 else identity(400 + index), "state": state,
                         "artifact_manifest": publications[index % 2]["artifact_manifest"] if state in ("published", "prepared", "placed", "reused") else None,
                         "error": "Synthetic failed attempt" if state == "failed" else None, "cleanup_error": None, "cleanup_checked_at": None,
                         "started_at": moment, "ended_at": moment if state in ("published", "failed", "reused") else None,
                         "reused_book_id": books[0] if state == "reused" else None})
    reading = [{"profile_id": owners[0], "book_id": books[0], "chapter": 1, "position": 0.375, "shelf": "reading", "updated_at": moment},
               {"profile_id": owners[1], "book_id": books[1], "chapter": 0, "position": 0.125, "shelf": "reading", "updated_at": moment}]
    marks = [{"id": identity(500+i), "profile_id": owners[i % 2], "book_id": books[i % 2], "chapter": i % 2, "position": 0.25 * (i+1),
              "note": ["Карта: вернуться к иллюстрации", "Заметка читателя 🌌", "Не потерять эту цитату"][i], "created_at": moment} for i in range(3)]
    def item(ident, index=0, scope="server"):
        return {"id": ident, "scope": scope, "title": contents[index]["title"] if ident in books else "Отсутствующий или локальный тестовый том", "author": "Вымышленный автор"}
    catalog_ids = [identity(n) for n in range(601, 606)]
    catalogs = [{"profile_id": owners[0], "revision": 7, "updated_at": moment, "catalogs": [
        {"id": catalog_ids[0], "title": "Серии", "parent": None, "items": []},
        {"id": catalog_ids[1], "title": "Тестовая серия: ручной порядок", "parent": catalog_ids[0], "items": [item(books[1], 1), item(books[0])]},
        {"id": catalog_ids[2], "title": "Подцикл", "parent": catalog_ids[1], "items": [item(books[0]), item(identity(701)), item(identity(702), scope="device")]}
    ]}, {"profile_id": owners[1], "revision": 3, "updated_at": moment, "catalogs": [
        {"id": catalog_ids[3], "title": "Личные серии знакомого", "parent": None, "items": [item(books[1], 1)]},
        {"id": catalog_ids[4], "title": "Перечитать", "parent": catalog_ids[3], "items": [item(books[0])]}
    ]}]
    sessions = [{"token_hash": hashlib.sha256(("fixture-session-"+str(i)).encode()).hexdigest(), "profile_id": owner, "csrf": "synthetic-only-"+str(i),
                 "expires_at": (now+timedelta(days=1)).isoformat(), "created_at": moment} for i, owner in enumerate(owners)]
    discovery_statuses = ("pending-approval", "queued", "processing", "needs-review", "selected", "acquiring", "book-ready", "cancelled", "error")
    discovery_rows, discovery_attempts, discovery_keys = [], [], []
    attempt_states = {2: "running", 3: "finished", 5: "running", 6: "finished", 7: "interrupted", 8: "failed"}
    linked_imports = {5: 2, 6: 0, 7: 8}
    for index, status in enumerate(discovery_statuses):
        request_id = identity(801 + index)
        linked = import_rows[linked_imports[index]] if index in linked_imports else None
        requester = linked["requested_by"] if linked else owners[index % 3]
        inputs = {"query": f"Тестовая серия — том 1: синтетический запрос {index+1}", "intent": "book", "language": "ru", "audio": index % 2 == 0, "allowOriginal": False}
        body_hash = hashlib.sha256(json.dumps(inputs, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        candidate_id, remote_id = "fixture_book_1", "990001"
        title, author = contents[0]["title"], contents[0]["author"]
        original_url = f"https://www.gutenberg.org/cache/epub/{remote_id}/pg{remote_id}-images.epub"
        mirror_url = f"https://gutenberg.pglaf.org/cache/epub/{remote_id}/pg{remote_id}-images.epub"
        expected_source = {"provider": "gutenberg", "remoteId": remote_id, "title": title, "authors": [author], "language": "ru", "languages": ["ru"]}
        candidate = {"id": candidate_id, "kind": "book", "title": title, "authors": [{"name": author, "remoteId": None}], "languages": ["ru"],
                     "identity": {"provider": "gutendex", "remoteId": remote_id}, "availability": "fetchable", "eligibleForAcquisition": True,
                     "sourceBinding": {"provider": "gutenberg", "remoteId": remote_id, "copyright": False},
                     "downloadSelections": [{"url": mirror_url, "originalUrl": original_url, "extension": "epub", "mimeType": "application/epub+zip",
                                             "maxRedirects": 0, "requiresQuarantine": True, "expected": expected_source}]}
        plan = {"query": inputs["query"], "intent": "book", "language": "ru", "allowOriginal": False, "metadataOnly": True,
                "candidates": [candidate], "selectedCandidateId": candidate_id if index >= 4 else None, "status": "resolved", "synthetic": True} if index >= 3 else None
        outputs = {"book": {"status": "ready" if status == "book-ready" else status},
                   "translation": {"status": "not-required" if status == "book-ready" else "pending-provider", "language": "ru"},
                   "audio": {"status": "pending-provider" if inputs["audio"] else "not-requested"}}
        if linked:
            outputs["book"]["importId"] = linked["id"]
            linked["kind"], linked["filename"], linked["source_url"] = "file", f"gutenberg-{remote_id}.epub", mirror_url
            linked["options"]["discovery"] = {"requestId": request_id, "planRevision": 1, "candidateId": candidate_id, "expected": expected_source,
                                                  "download": {"url": mirror_url, "originalUrl": original_url, "mimeType": "application/epub+zip", "maxRedirects": 0},
                                                  "sourceIdentity": {"provider": "gutenberg", "remoteId": remote_id, "variant": f"gutenberg:{remote_id}:ru", "kind": "unclassified"}}
        if status == "book-ready":
            outputs["book"]["publicationId"] = books[0]
        token = identity(901 + index) if index in attempt_states else None
        phase = "acquisition" if index >= 4 else "discovery" if token else None
        discovery_rows.append({"id": request_id, "requested_by": requester, "body_hash": body_hash, "input": inputs, "query_text": inputs["query"],
                               "status": status, "revision": 4, "approved_by": None if index == 0 else owners[0], "decision_reason": None if index == 0 else "owner-approval",
                               "plan": plan, "plan_revision": 1 if plan else 0, "selected_candidate_id": candidate_id if plan and index >= 4 else None,
                               "outputs": outputs, "import_id": linked["id"] if linked else None, "phase": phase, "attempt_number": 1 if token else 0,
                               "attempt_token": token, "lease_expires_at": (now + timedelta(hours=1 if index == 2 else -1)).isoformat() if index in (2, 5) else None,
                               "error": "Synthetic discovery failure" if status == "error" else None,
                               "retry_count": 2 if index == 1 else 0, "next_attempt_at": (now + timedelta(minutes=2)).isoformat() if index == 1 else None,
                               "acquisition_key": hashlib.sha256(canonical({"policy": "gutenberg-exact-file-v1", "provider": "gutenberg", "remoteId": remote_id,
                                   "url": mirror_url, "originalUrl": original_url, "extension": "epub", "mimeType": "application/epub+zip", "expected": expected_source}).encode()).hexdigest() if linked else None,
                               "created_at": moment, "updated_at": moment})
        if token:
            state = attempt_states[index]
            discovery_attempts.append({"token": token, "request_id": request_id, "number": 1, "phase": phase, "state": state,
                                       "error": "Synthetic prior discovery failure" if state in ("failed", "interrupted") else None,
                                       "started_at": moment, "ended_at": None if state == "running" else moment})
        discovery_keys.append({"profile_id": requester, "key": identity(1001 + index), "body_hash": body_hash, "request_id": request_id, "created_at": moment})
    ranobe, ranobe_sql = ranobe_fixture(owners, books, contents, png, now, moment, import_rows, attempts, publications[0]["package_sha256"])
    before = "BEGIN;\nDO $$ BEGIN IF EXISTS(SELECT 1 FROM profiles) OR EXISTS(SELECT 1 FROM imports) OR EXISTS(SELECT 1 FROM books) THEN RAISE EXCEPTION 'Fixture database is not fresh'; END IF; END $$;\n"
    before += insert("profiles", profiles) + insert("imports", import_rows) + insert("import_attempts", [row for row in attempts if row["reused_book_id"] is None]) + "COMMIT;\n"
    # The reuse attempt references a published book and therefore follows book insertion.
    after = "BEGIN;\n" + insert("import_attempts", [row for row in attempts if row["reused_book_id"] is not None]) + insert("reading", reading) + insert("bookmarks", marks) + insert("profile_catalogs", catalogs) + insert("sessions", sessions)
    # Requests and attempts have a circular ownership FK. Insert nonprocessing,
    # token-free requests first, then bind their final claims in this transaction.
    initial_discovery = [{**row, "status": "queued" if row["status"] == "processing" else row["status"], "attempt_token": None} for row in discovery_rows]
    after += insert("discovery_requests", initial_discovery) + insert("discovery_attempts", discovery_attempts) + insert("discovery_idempotency", discovery_keys)
    for row in discovery_rows:
        if row["attempt_token"]:
            after += "UPDATE discovery_requests SET status=" + sql_value(row["status"]) + ",attempt_token=" + sql_value(row["attempt_token"]) + " WHERE id=" + sql_value(row["id"]) + ";\n"
    after += ranobe_sql
    after += "INSERT INTO audit(actor,action,target,details) VALUES (NULL,'fixture.seeded','synthetic','{\"synthetic\":true}');\n"
    after += "INSERT INTO system_status(name,value) VALUES('fixture','{\"synthetic\":true}');\nCOMMIT;\n"
    (root / "seed-before-books.sql").write_text(before, encoding="utf-8", newline="\n")
    (root / "seed-after-books.sql").write_text(after, encoding="utf-8", newline="\n")
    write_json(root / "books.json", publications)
    tables = ("profiles", "imports", "books", "reading", "bookmarks", "profile_catalogs", "import_attempts", "settings", "works", "work_sources", "expressions", "editions", "discovery_requests", "discovery_attempts", "discovery_idempotency", *ranobe)
    pairs = []
    for table in tables:
        expression = "to_jsonb(t)-'password'" if table == "profiles" else "to_jsonb(t)"
        order = "profile_id" if table in ("reading", "profile_catalogs") else "token" if table in ("import_attempts", "discovery_attempts", "ranobe_scratch") else "run_id,ordinal" if table == "ranobe_run_chapters" else "profile_id,key" if table == "discovery_idempotency" else "provider,remote_id" if table == "work_sources" else "id"
        pairs.append(f"'{table}',COALESCE((SELECT jsonb_agg(row) FROM (SELECT {expression} AS row FROM public.{table} t ORDER BY {order}) s),'[]'::jsonb)")
    state_sql = "SET TIME ZONE 'UTC';\nSELECT json_build_object('sessionRows',(SELECT count(*) FROM sessions),'tables',json_build_object(" + ",".join(pairs) + "));\n"
    (root / "state.sql").write_text(state_sql, encoding="utf-8", newline="\n")
    expected = {"synthetic": True, "profiles": profiles, "imports": import_rows, "attempts": attempts, "books": publications,
                "discoveryRequests": discovery_rows, "discoveryAttempts": discovery_attempts, "discoveryIdempotency": discovery_keys, "ranobeTables": ranobe,
                "reading": reading, "bookmarks": marks, "catalogs": catalogs, "sessionRows": 3,
                "tableCounts": {"profiles": 3, "imports": len(import_rows), "books": 2, "import_attempts": len(attempts), "reading": 2, "bookmarks": 3, "profile_catalogs": 2,
                                "works": 2, "work_sources": 2, "expressions": 2, "editions": 2, "discovery_requests": 9, "discovery_attempts": 6, "discovery_idempotency": 9,
                                **{name: len(rows) for name, rows in ranobe.items()}},
                "libraryCounts": {"books": 2, "chaptersOpened": 5, "assetsChecked": 1, "readingAndBookmarksChecked": 5, "catalogsChecked": 5, "catalogItemsChecked": 7, "unavailableCatalogReferences": 1}}
    write_json(root / "expected.json", expected)
    return {"status": "BUILT_NOT_EXECUTED", "synthetic": True, "books": 2, "attempts": len(attempts), "discoveryRequests": 9, "discoveryAttempts": 6, "ranobeFeeds": 2, "ranobeRuns": 3}


def fingerprints(path):
    return {item["table"]: item for item in (json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip())}


def by(rows, key):
    return {row[key]: row for row in rows}


def assert_before(seed, snapshot, restored, source_state):
    expected = read_json(seed / "expected.json")
    original = fingerprints(snapshot / "db-table-fingerprints.jsonl")
    actual = fingerprints(restored / "db-table-fingerprints.jsonl")
    require(actual == original, "A restored public table differs before recovery hold")
    for name, count in expected["tableCounts"].items():
        require(original.get(name, {}).get("count") == count, "Synthetic source table count differs: " + name)
    source = read_json(source_state)
    require(source["sessionRows"] == 3, "Source did not contain synthetic sessions")
    source_core, restored_core = read_json(snapshot / "db-inventory.json"), read_json(restored / "db-inventory.json")
    require(source_core["sessionRows"] == 3, "Snapshot did not observe source sessions")
    require(restored_core["sessionRows"] == 0, "V2 dump restored session credentials")
    require(source_core.get("ranobeMetadataFormat") == restored_core.get("ranobeMetadataFormat") == "source-jsonl-v1", "Source-only Ranobe metadata protocol was not used")
    source_names = set(expected["ranobeTables"])
    require(not source_names.intersection(source_core["tables"]) and not source_names.intersection(restored_core["tables"]), "005 source arrays leaked into the bounded core inventory")
    counts = {name: 0 for name in source_names}
    with (snapshot / "ranobe-metadata.jsonl").open(encoding="utf-8") as stream:
        for line in stream:
            value = json.loads(line)
            require(set(value) == {"table", "row"} and value["table"] in counts, "Synthetic metadata sidecar record is invalid")
            counts[value["table"]] += 1
    require(counts == {name: len(rows) for name, rows in expected["ranobeTables"].items()}, "Synthetic metadata sidecar omitted source rows")
    require(not (restored / "ranobe-metadata.jsonl").exists() and not (restored / "ranobe-checkpoints.jsonl").exists(), "Restore duplicated source-only sidecars into tmpfs/restore output")
    require({row["role"] for row in source["tables"]["profiles"]} == {"owner", "reader", "trusted-import"}, "Source role coverage is incomplete")
    require({row["state"] for row in source["tables"]["import_attempts"]} == {"published", "running", "prepared", "placed", "failed", "reused"}, "Source attempt-state coverage is incomplete")
    leases = [datetime.fromisoformat(row["lease_expires_at"]) for row in source["tables"]["imports"] if row["lease_expires_at"]]
    require(len(leases) == sum(bool(row["lease_expires_at"]) for row in expected["imports"]) and min(leases) < datetime.now(timezone.utc) < max(leases), "Source did not cover expired and live leases")
    validation = read_json(restored / "library-validation.json")
    require(validation["status"] == "validated", "Existing backup comparator did not validate restore")
    for name, count in expected["libraryCounts"].items():
        require(validation["library"].get(name) == count, "Library validation coverage differs: " + name)
    require(all(row.get("publication_manifest") and row.get("publication_sha256") for row in source["tables"]["books"]), "Source publication revisions were not sealed")
    discoveries = source["tables"]["discovery_requests"]
    require(sum(row.get("retry_count") == 2 and row.get("next_attempt_at") is not None for row in discoveries) == 1, "Durable retry clock was not restored")
    require(sum(row.get("acquisition_key") is not None for row in discoveries) >= 2, "Exact-source acquisition provenance was not restored")
    require({row["status"] for row in discoveries} == {"pending-approval", "queued", "processing", "needs-review", "selected", "acquiring", "book-ready", "cancelled", "error"}, "Source discovery-status coverage is incomplete")
    require({row["state"] for row in source["tables"]["discovery_attempts"]} == {"running", "finished", "failed", "interrupted"}, "Source discovery attempt-state coverage is incomplete")
    discovery_leases = [datetime.fromisoformat(row["lease_expires_at"]) for row in discoveries if row["lease_expires_at"]]
    require(len(discovery_leases) == 2 and min(discovery_leases) < datetime.now(timezone.utc) < max(discovery_leases), "Source discovery leases do not cover live and expired claims")
    require(len(source["tables"]["ranobe_feeds"]) == 2 and {row["branch_key"] for row in source["tables"]["ranobe_feeds"]} == {"default", "42"}, "Ranobe branch fixture coverage is incomplete")
    require(sum(row["status"] == "ready" for row in source["tables"]["ranobe_runs"]) == 2 and sum(row["status"] == "building" for row in source["tables"]["ranobe_runs"]) == 1, "Ranobe ready/previous-head/building coverage differs")
    require(sum(row["prepared_book"] is not None for row in source["tables"]["ranobe_chapters"]) == 1 and len(source["tables"]["ranobe_scratch"]) == 1, "Ranobe sanitized/raw tracker checkpoint coverage differs")
    require(validation["library"].get("ranobePreparedBlobsChecked") == 1 and validation["library"].get("ranobePartsChecked") == 3, "Ranobe checkpoint/part semantic validation was not performed")
    source_runs = by(source["tables"]["ranobe_runs"], "id")
    source_imports = by(source["tables"]["imports"], "id")
    no_change_requests = [row for row in source["tables"]["ranobe_feed_requests"] if row.get("result_run_id") and source_runs[row["result_run_id"]]["import_id"] != row["import_id"]]
    require(len(no_change_requests) == 1, "No-change update did not reuse the old immutable snapshot")
    result = source_runs[no_change_requests[0]["result_run_id"]]
    require(result["status"] == "ready" and source_imports[no_change_requests[0]["import_id"]]["status"] == "completed" and source_imports[result["import_id"]]["requested_by"] != no_change_requests[0]["profile_id"], "No-change update lost its separate initiator/completed result")
    return {"status": "PASS", "phase": "before-recovery-hold", "synthetic": True, "allPublicTablesCompared": len(actual),
            "nonemptyAttemptRowsCompared": len(expected["attempts"]), "discoveryRequestsCompared": len(discoveries), "discoveryAttemptRowsCompared": 6, "discoveryIdempotencyRowsCompared": 9,
            "ranobeFeedsCompared": 2, "ranobeSnapshotsCompared": 3, "ranobeSanitizedCheckpointsCompared": 1,
            "ranobeNoChangeResultsCompared": len(no_change_requests),
            "ranobeMetadataFormat": "source-jsonl-v1", "ranobeMetadataRecordsCompared": sum(counts.values()),
            "library": validation["library"], "sourceSessions": 3, "restoredSessions": 0,
            "sessionHandling": "V2 excludes session rows before the explicit recovery revocation"}


def assert_after(seed, snapshot, post_root, source_state, post_state):
    expected = read_json(seed / "expected.json")
    before = read_json(source_state)
    after = read_json(post_state)
    require(after["sessionRows"] == 0, "Recovery retained sessions")
    settings = after["tables"]["settings"]
    require(len(settings) == 1 and settings[0]["imports_paused"] and settings[0]["serving_paused"], "Recovery did not pause imports and serving")
    original = fingerprints(snapshot / "db-table-fingerprints.jsonl")
    actual = fingerprints(post_root / "db-table-fingerprints.jsonl")
    changed = {"imports", "settings", "import_attempts", "discovery_requests", "discovery_attempts", "ranobe_feeds", "ranobe_runs", "ranobe_scratch"}
    require(set(actual) == set(original), "Recovery changed the public table set")
    for name in set(actual) - changed:
        require(actual[name] == original[name], "Recovery changed an unrelated table: " + name)
    source_imports = by(before["tables"]["imports"], "id")
    restored_imports = by(after["tables"]["imports"], "id")
    require(set(source_imports) == set(restored_imports), "Recovery removed or added an import")
    mutable = {"status", "security_state", "stage", "error", "lease_expires_at", "attempt_token"}
    for ident, row in restored_imports.items():
        old = source_imports[ident]
        require(row.get("lease_expires_at") is None and row.get("attempt_token") is None, "Recovery retained an import lease/token")
        require({key: value for key, value in row.items() if key not in mutable} == {key: value for key, value in old.items() if key not in mutable}, "Recovery changed import provenance/history")
        if old["status"] in ("uploading", "queued", "processing"):
            require(row["status"] == "error" and row["security_state"] == "error" and row["error"], "Unfinished import was not held")
        else:
            require(all(row[key] == old[key] for key in mutable - {"lease_expires_at", "attempt_token"}), "Recovery changed a finished or pending-approval import")
    old_attempts = by(before["tables"]["import_attempts"], "token")
    attempts = by(after["tables"]["import_attempts"], "token")
    require(set(attempts) == set(old_attempts), "Recovery lost attempt history")
    interrupted = 0
    for token, row in attempts.items():
        old = old_attempts[token]
        if old["state"] in ("running", "prepared", "placed"):
            require(row["state"] == "interrupted" and row["ended_at"] and row["error"], "Active attempt was not interrupted by recovery")
            require({k: v for k, v in row.items() if k not in {"state", "ended_at", "error"}} == {k: v for k, v in old.items() if k not in {"state", "ended_at", "error"}}, "Recovery changed attempt identity/artifacts")
            interrupted += 1
        else:
            require(row == old, "Recovery changed a published/reused/failed attempt")
    require(interrupted == sum(row["state"] in ("running", "prepared", "placed") for row in expected["attempts"]) and len(attempts) == len(expected["attempts"]), "Recovery attempt coverage differs")
    old_requests = by(before["tables"]["discovery_requests"], "id")
    discoveries = by(after["tables"]["discovery_requests"], "id")
    require(set(discoveries) == set(old_requests), "Recovery lost discovery requests")
    active_statuses = {"pending-approval", "queued", "processing", "needs-review", "selected", "acquiring"}
    changed_request_fields = {"status", "revision", "approved_by", "decision_reason", "error", "attempt_token", "lease_expires_at"}
    held = 0
    for ident, row in discoveries.items():
        old = old_requests[ident]
        require(row["attempt_token"] is None and row["lease_expires_at"] is None, "Recovery retained a discovery claim")
        require({k: v for k, v in row.items() if k not in changed_request_fields} == {k: v for k, v in old.items() if k not in changed_request_fields}, "Recovery changed discovery plan/input/output/provenance/import links")
        if old["status"] in active_statuses:
            require(row["status"] == "pending-approval" and row["revision"] == old["revision"] + 1 and row["approved_by"] is None and row["decision_reason"] is None and row["error"], "Active discovery was not fenced for new approval")
            held += 1
        else:
            require(all(row[k] == old[k] for k in changed_request_fields - {"attempt_token", "lease_expires_at"}), "Recovery changed a terminal discovery outcome")
    require(held == 6 and len(discoveries) == 9, "Recovery discovery request coverage differs")
    old_discovery_attempts = by(before["tables"]["discovery_attempts"], "token")
    discovery_attempts = by(after["tables"]["discovery_attempts"], "token")
    require(set(discovery_attempts) == set(old_discovery_attempts), "Recovery lost discovery attempt history")
    discovery_interrupted = 0
    for token, row in discovery_attempts.items():
        old = old_discovery_attempts[token]
        if old["state"] == "running":
            require(row["state"] == "interrupted" and row["ended_at"] and row["error"], "Recovery retained an active discovery attempt")
            require({k: v for k, v in row.items() if k not in {"state", "ended_at", "error"}} == {k: v for k, v in old.items() if k not in {"state", "ended_at", "error"}}, "Recovery changed discovery attempt identity")
            discovery_interrupted += 1
        else:
            require(row == old, "Recovery changed terminal discovery attempt history")
    require(discovery_interrupted == 2 and len(discovery_attempts) == 6, "Recovery discovery attempt coverage differs")
    require(before["tables"]["discovery_idempotency"] == after["tables"]["discovery_idempotency"], "Recovery changed discovery idempotency/provenance")
    old_feeds = by(before["tables"]["ranobe_feeds"], "id")
    new_feeds = by(after["tables"]["ranobe_feeds"], "id")
    require(set(old_feeds) == set(new_feeds), "Recovery changed Ranobe feed identities")
    mutable_feed = {"auto_update", "active_import_id", "revision", "updated_at"}
    for ident, row in new_feeds.items():
        old = old_feeds[ident]
        require(not row["auto_update"] and row["active_import_id"] is None and row["revision"] == old["revision"] + 1, "Recovery retained Ranobe automatic work")
        require({k: v for k, v in row.items() if k not in mutable_feed} == {k: v for k, v in old.items() if k not in mutable_feed}, "Recovery changed Ranobe previous head/branch/provenance")
    old_runs = by(before["tables"]["ranobe_runs"], "id")
    new_runs = by(after["tables"]["ranobe_runs"], "id")
    require(set(old_runs) == set(new_runs), "Recovery lost Ranobe snapshot history")
    for ident, row in new_runs.items():
        old = old_runs[ident]
        require(row == ({**old, "status": "abandoned"} if old["status"] == "building" else old), "Recovery changed a Ranobe ready snapshot/inventory or retained a building run")
    for table in ("ranobe_feed_requests", "ranobe_chapters", "ranobe_run_chapters", "ranobe_run_parts"):
        require(before["tables"][table] == after["tables"][table], "Recovery changed safe Ranobe checkpoints/parts/request history: " + table)
    require(after["tables"]["ranobe_scratch"] == [], "Recovery retained a tracker for excluded raw quarantine")
    require(len(after["tables"]["books"]) == expected["tableCounts"]["books"], "Recovery lost published books")
    return {"status": "PASS", "phase": "after-recovery-hold", "synthetic": True, "sessions": 0, "activeLeases": 0, "activeAttemptTokens": 0,
            "activeAttempts": 0, "interruptedAttempts": interrupted, "attemptHistoryRows": len(attempts),
            "discoveryRequestsHeld": held, "discoveryRequestsPreserved": len(discoveries), "discoveryAttemptsInterrupted": discovery_interrupted,
            "discoveryAttemptHistoryRows": len(discovery_attempts), "discoveryIdempotencyRowsPreserved": len(after["tables"]["discovery_idempotency"]),
            "ranobeSubscriptionsDisabled": len(new_feeds), "ranobeReadyHeadsPreserved": 2, "ranobeBuildingRunsAbandoned": 1,
            "ranobeSafeCheckpointsPreserved": len(after["tables"]["ranobe_chapters"]), "ranobeRawTrackersCleared": len(before["tables"]["ranobe_scratch"]),
            "ranobeNoChangeResultsPreserved": sum(bool(row.get("result_run_id")) and old_runs[row["result_run_id"]]["import_id"] != row["import_id"] for row in after["tables"]["ranobe_feed_requests"]),
            "unchangedTableFingerprints": len(actual) - len(changed), "importsPaused": True, "servingPaused": True,
            "queueExecution": "No app, worker, parser, translator or TTS process was created"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("build"); create.add_argument("--root", type=Path, required=True)
    before = sub.add_parser("assert-before"); after = sub.add_parser("assert-after")
    for command in (before, after):
        command.add_argument("--seed", type=Path, required=True); command.add_argument("--snapshot", type=Path, required=True)
        command.add_argument("--source-state", type=Path, required=True); command.add_argument("--report", type=Path, required=True)
    before.add_argument("--restored", type=Path, required=True)
    after.add_argument("--post-root", type=Path, required=True); after.add_argument("--post-state", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "build":
        result = build(args.root)
    elif args.command == "assert-before":
        result = assert_before(args.seed, args.snapshot, args.restored, args.source_state)
    else:
        result = assert_after(args.seed, args.snapshot, args.post_root, args.source_state, args.post_state)
    if hasattr(args, "report"):
        write_json(args.report, result)
    print(json.dumps({"operation": args.command, "status": result["status"], "synthetic": True}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        raise SystemExit("Synthetic restore fixture failed: " + str(error))
