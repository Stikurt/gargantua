#!/usr/bin/env python3
"""Bounded, metadata-only Open Library catalog pilot. No book downloads."""
from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import hashlib
import html
import json
import math
import os
from pathlib import Path
import random
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://openlibrary.org"
MAX_RESPONSE = 8 * 1024 * 1024
MAX_CACHE_BYTES = 64 * 1024 * 1024
MAX_CACHE_FILES = 128
FIELDS = "key,title,subtitle,author_name,author_key,first_publish_year,edition_count,language,subject"
PRIMARY_DOCS = [BASE + "/developers/api", BASE + "/dev/docs/api/search", BASE + "/dev/docs/api/authors"]


class DiscoveryError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalized(value):
    value = unicodedata.normalize("NFKC", str(value)).casefold().replace("ё", "е")
    return " ".join(re.findall(r"[^\W_]+", value, re.UNICODE))


def bounded_text(value, limit=500):
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def identifier(value, kind):
    if not isinstance(value, str):
        return None
    value = value.rsplit("/", 1)[-1]
    return value if re.fullmatch(r"OL[0-9]+" + kind, value) else None


def safe_url(value):
    if not isinstance(value, str) or len(value) > 2000 or any(ord(c) < 32 for c in value):
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and parsed.port in (None, 443):
            return value
    except ValueError:
        pass
    return None


def solr_phrase(value):
    # Literal phrase, never user-supplied Solr operators/fields.
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def publication_year(doc):
    year = doc.get("first_publish_year")
    if isinstance(year, int) and not isinstance(year, bool) and 1 <= year <= 9999:
        return year
    raw = doc.get("first_publish_date")
    if isinstance(raw, str):
        found = re.findall(r"(?<!\d)([1-2]\d{3})(?!\d)", raw)
        if len(found) == 1:
            return int(found[0])
    return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise DiscoveryError("UNEXPECTED_REDIRECT", "Metadata API redirected; no alternate host was contacted")


class MetadataClient:
    """Fixed host/endpoints, 1 request/second, bounded retries and persistent JSON cache."""
    def __init__(self, cache_dir, *, timeout=15, max_requests=10, cache_hours=24,
                 offline=False, contact=None, opener=None, sleep=time.sleep, clock=time.monotonic):
        self.cache_dir = Path(cache_dir)
        self.timeout = timeout
        self.max_requests = max_requests
        self.cache_hours = cache_hours
        self.offline = offline
        self.user_agent = "GargantuaMetadataPilot/0.1" + (f" ({contact})" if contact else " (personal catalog lookup)")
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.sleep, self.clock = sleep, clock
        self.last_request = None
        self.requests = 0
        self.provenance = []
        self.warnings = []

    def get(self, path, params=None):
        if not re.fullmatch(r"/(?:search(?:/authors)?\.json|authors/OL\d+A(?:/works)?\.json|works/OL\d+W\.json)", path):
            raise DiscoveryError("UNSUPPORTED_ENDPOINT", "Only fixed Open Library metadata endpoints are permitted")
        url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
        key = hashlib.sha256(url.encode()).hexdigest()
        cache_file = self.cache_dir / (key + ".json")
        cached = None
        try:
            if cache_file.stat().st_size <= MAX_RESPONSE + 65536:
                cached = json.loads(cache_file.read_text(encoding="utf-8"))
                if not isinstance(cached, dict) or cached.get("url") != url or not isinstance(cached.get("body"), dict):
                    cached = None
        except (OSError, ValueError, TypeError):
            cached = None
        if cached:
            try:
                fetched = dt.datetime.fromisoformat(cached["fetchedAt"].replace("Z", "+00:00"))
                age = (dt.datetime.now(dt.timezone.utc) - fetched).total_seconds()
                fresh = 0 <= age <= self.cache_hours * 3600
            except (KeyError, ValueError, TypeError, AttributeError):
                fresh = False
            if fresh or self.offline:
                self.provenance.append({"url": url, "fetchedAt": cached.get("fetchedAt"), "usedAt": now_iso(), "cache": True, "stale": not fresh})
                return cached["body"]
        if self.offline:
            raise DiscoveryError("CACHE_MISS", "No cached metadata for this exact request; offline mode makes no network requests")
        for attempt in range(3):
            if self.requests >= self.max_requests:
                raise DiscoveryError("REQUEST_BUDGET", "Maximum network request budget reached (retries included)")
            current = self.clock()
            if self.last_request is not None:
                self.sleep(max(0, 1.05 - (current - self.last_request)))
            self.last_request = self.clock()
            self.requests += 1
            request = urllib.request.Request(url, headers={"User-Agent": self.user_agent, "Accept": "application/json", "Accept-Encoding": "identity"})
            retry_after = 0
            deadline = self.clock() + self.timeout
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    if response.status != 200:
                        raise DiscoveryError("SOURCE_HTTP", f"Metadata API returned HTTP {response.status}")
                    if response.headers.get("Content-Encoding", "identity").lower() not in ("", "identity"):
                        raise DiscoveryError("UNEXPECTED_ENCODING", "Compressed metadata response was not requested")
                    if "application/json" not in response.headers.get("Content-Type", "").lower():
                        raise DiscoveryError("SOURCE_FORMAT", "Metadata API returned a non-JSON response")
                    length = response.headers.get("Content-Length")
                    if length and (not length.isdigit() or int(length) > MAX_RESPONSE):
                        raise DiscoveryError("RESPONSE_LIMIT", "Metadata response exceeds the size limit")
                    chunks, received = [], 0
                    while True:
                        if self.clock() >= deadline:
                            raise TimeoutError("Metadata response deadline exceeded")
                        chunk = response.read1(min(65536, MAX_RESPONSE + 1 - received))
                        if not chunk:
                            break
                        chunks.append(chunk)
                        received += len(chunk)
                        if received > MAX_RESPONSE:
                            raise DiscoveryError("RESPONSE_LIMIT", "Metadata response exceeds the size limit")
                    data = b"".join(chunks)
                body = json.loads(data)
                if not isinstance(body, dict):
                    raise DiscoveryError("SOURCE_FORMAT", "Metadata response must be an object")
                fetched_at = now_iso()
                self.provenance.append({"url": url, "fetchedAt": fetched_at, "usedAt": fetched_at, "cache": False, "stale": False})
                envelope = {"url": url, "fetchedAt": fetched_at, "body": body}
                try:
                    self.cache_dir.mkdir(parents=True, exist_ok=True)
                    encoded = json.dumps(envelope, ensure_ascii=False).encode("utf-8")
                    count, occupied = 0, 0
                    for entry in self.cache_dir.iterdir():
                        if re.fullmatch(r"[0-9a-f]{64}\.json", entry.name) and entry != cache_file:
                            count += 1
                            occupied += entry.stat().st_size
                            if count >= MAX_CACHE_FILES or occupied + len(encoded) > MAX_CACHE_BYTES:
                                break
                    if count < MAX_CACHE_FILES and occupied + len(encoded) <= MAX_CACHE_BYTES:
                        atomic_write(cache_file, encoded)
                    else:
                        self.warnings.append("Metadata cache capacity reached (128 files / 64 MiB); existing files were retained, new response not cached")
                except OSError:
                    self.warnings.append("Cache could not be written; metadata results are still usable")
                return body
            except urllib.error.HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504):
                    raise DiscoveryError("SOURCE_HTTP", f"Metadata API returned HTTP {exc.code}") from exc
                raw_delay = exc.headers.get("Retry-After", "")
                if raw_delay.isdigit():
                    retry_after = int(raw_delay)
                elif raw_delay:
                    try:
                        retry_after = max(0, (email.utils.parsedate_to_datetime(raw_delay) - dt.datetime.now(dt.timezone.utc)).total_seconds())
                    except (TypeError, ValueError):
                        pass
                exc.close()
                if retry_after > 30:
                    raise DiscoveryError("RATE_LIMITED", "Source requests a longer wait; retry later instead of bypassing Retry-After")
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if attempt == 2:
                    raise DiscoveryError("SOURCE_UNAVAILABLE", "Metadata API unavailable after bounded retries") from exc
            except (ValueError, UnicodeError) as exc:
                raise DiscoveryError("SOURCE_FORMAT", "Metadata response is not valid UTF-8 JSON") from exc
            if attempt == 2:
                raise DiscoveryError("SOURCE_UNAVAILABLE", "Metadata API unavailable after bounded retries")
            self.sleep(max(retry_after, (2 ** attempt) + random.uniform(0, 0.25)))
        raise AssertionError("Unreachable")


def atomic_write(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def author_candidate(doc):
    aid = identifier(doc.get("key"), "A")
    if not aid:
        return None
    return {"id": aid, "name": bounded_text(doc.get("name"), 300),
            "alternateNames": [bounded_text(x, 300) for x in doc.get("alternate_names", [])[:20] if isinstance(x, str)],
            "birthDate": bounded_text(doc.get("birth_date"), 80),
            "deathDate": bounded_text(doc.get("death_date"), 80),
            "topWork": bounded_text(doc.get("top_work"), 300),
            "workCount": doc.get("work_count") if isinstance(doc.get("work_count"), int) else None,
            "url": BASE + "/authors/" + aid}


def choose_author(query, docs, total):
    candidates = list({candidate["id"]: candidate for doc in docs if (candidate := author_candidate(doc))}.values())
    exact = [c for c in candidates if normalized(query) in [normalized(c["name"]), *map(normalized, c["alternateNames"])]]
    # Relevance ranking and the first page do not establish a person's identity.
    selected = exact[0] if total == 1 and len(candidates) == 1 and len(exact) == 1 else None
    return selected, candidates


def normalize_work(doc, selected_author=None):
    wid = identifier(doc.get("key"), "W")
    if not wid:
        return None
    keys = [identifier(x, "A") for x in doc.get("author_key", []) if isinstance(x, str)]
    names = [bounded_text(x, 300) for x in doc.get("author_name", []) if isinstance(x, str)]
    if not keys and isinstance(doc.get("authors"), list):
        for entry in doc["authors"]:
            if isinstance(entry, dict):
                ref = entry.get("author", entry)
                if isinstance(ref, dict):
                    keys.append(identifier(ref.get("key"), "A"))
    keys = list(dict.fromkeys(x for x in keys if x))
    if selected_author and selected_author["id"] in keys and not names:
        names = [selected_author["name"]]
    year = publication_year(doc)
    return {"id": wid, "title": bounded_text(doc.get("title"), 500) or "[Untitled metadata record]",
            "subtitle": bounded_text(doc.get("subtitle"), 500), "authorIds": keys, "authorNames": names,
            "firstPublicationYear": year, "yearSource": "provider-metadata" if year else "unknown",
            "languages": [bounded_text(x, 35) for x in doc.get("language", [])[:40] if isinstance(x, str)],
            "subjects": [bounded_text(x, 250) for x in doc.get("subject", doc.get("subjects", []))[:100] if isinstance(x, str)],
            "editionCount": doc.get("edition_count") if isinstance(doc.get("edition_count"), int) else None,
            "url": BASE + "/works/" + wid, "seriesMembership": "unverified", "seriesEvidence": []}


def collect_pages(client, path, params, *, limit, page_size, selected_author=None):
    works, seen, offset, total, duplicates, skipped = [], set(), 0, None, 0, 0
    issue, exhausted = None, False
    max_pages = min(20, math.ceil(limit / page_size) + 3)
    for _ in range(max_pages):
        requested = min(page_size, limit - len(works))
        if requested <= 0:
            break
        try:
            response = client.get(path, {**params, "offset": offset, "limit": requested})
        except DiscoveryError as exc:
            issue = {"code": exc.code, "message": str(exc)}
            break
        raw = response.get("entries" if path.endswith("/works.json") else "docs")
        if not isinstance(raw, list) or len(raw) > requested:
            issue = {"code": "SOURCE_FORMAT", "message": "Unexpected metadata page shape/size"}
            break
        reported = response.get("size", response.get("numFound", response.get("num_found")))
        if isinstance(reported, int) and not isinstance(reported, bool) and reported >= 0:
            total = reported
        if not raw:
            exhausted = total is None or offset >= total
            if not exhausted:
                issue = {"code": "INCOMPLETE_PAGE", "message": "API returned an empty page before its reported total"}
            break
        new_count = 0
        for doc in raw:
            work = normalize_work(doc, selected_author) if isinstance(doc, dict) else None
            if not work:
                skipped += 1
            elif work["id"] in seen:
                duplicates += 1
            else:
                seen.add(work["id"])
                works.append(work)
                new_count += 1
        offset += len(raw)
        if total is not None and offset >= total:
            exhausted = True
            break
        if total is None and len(raw) < requested:
            exhausted = True
            break
        if not new_count:
            issue = {"code": "REPEATED_PAGE", "message": "Page contained no new valid work IDs; stopped instead of looping"}
            break
    if not exhausted and not issue and len(works) < limit:
        issue = {"code": "PAGE_BUDGET", "message": "Bounded page budget reached"}
    return works, {"returned": len(works), "providerTotal": total, "exhaustedPages": exhausted,
                   "hitLimit": len(works) >= limit and not exhausted, "nextOffset": offset,
                   "duplicatesById": duplicates, "skippedInvalidRecords": skipped,
                   "completeBibliography": False, "issue": issue}


def load_curated_order(path):
    path = Path(path)
    if path.stat().st_size > 512 * 1024:
        raise DiscoveryError("CURATED_LIMIT", "Curated order file exceeds 512 KiB")
    doc = json.loads(path.read_text(encoding="utf-8-sig"))
    allowed_types = ("official-cycle-order", "publication-order", "chronological-order", "recommended-order", "custom-order")
    if not isinstance(doc, dict) or doc.get("schemaVersion") != 1 or doc.get("orderType") not in allowed_types:
        raise DiscoveryError("CURATED_FORMAT", "Expected curated order schemaVersion 1 and an explicit orderType")
    items, evidence = doc.get("items"), doc.get("evidence")
    if not isinstance(items, list) or not 1 <= len(items) <= 50 or not isinstance(evidence, list) or not evidence:
        raise DiscoveryError("CURATED_FORMAT", "Curated order needs 1–50 items and source evidence")
    for source in evidence:
        if not isinstance(source, dict) or not safe_url(source.get("url")) or not isinstance(source.get("checkedAt"), str):
            raise DiscoveryError("CURATED_FORMAT", "Evidence needs a safe HTTPS URL and checkedAt")
    ids, positions = set(), set()
    for item in items:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].startswith("curated:")
                or not isinstance(item.get("sequence"), int) or isinstance(item["sequence"], bool) or item["sequence"] < 1
                or not bounded_text(item.get("title")) or not bounded_text(item.get("author"))):
            raise DiscoveryError("CURATED_FORMAT", "Curated entries need own curated: IDs, sequence, title and author")
        if item["id"] in ids or item["sequence"] in positions:
            raise DiscoveryError("CURATED_FORMAT", "Duplicate curated entry ID or position")
        ids.add(item["id"])
        positions.add(item["sequence"])
        aliases = item.get("searchAliases", [])
        if not isinstance(aliases, list) or len(aliases) > 10 or any(not isinstance(x, str) or len(x) > 500 for x in aliases):
            raise DiscoveryError("CURATED_FORMAT", "Invalid curated search aliases")
    return doc


def series_evidence(work, aliases):
    needles = {normalized(x) for x in aliases}
    evidence = []
    for field in ("title", "subtitle"):
        text = normalized(work[field])
        if any(needle and (text == needle or text.startswith(needle + " ")) for needle in needles):
            evidence.append({"kind": field + "-alias", "value": work[field], "strength": "candidate"})
    for subject in work["subjects"]:
        text = normalized(subject)
        if any(needle and (text == needle or text.startswith(needle + " ")) for needle in needles):
            evidence.append({"kind": "subject-alias", "value": subject, "strength": "candidate"})
    return evidence


def attach_curated(works, curated):
    entries = []
    for item in sorted(curated["items"], key=lambda x: x["sequence"]):
        titles = {normalized(x) for x in [item["title"], *item.get("searchAliases", [])]}
        author = normalized(item["author"])
        candidates = [work for work in works if normalized(work["title"]) in titles and author in map(normalized, work["authorNames"])]
        for work in candidates:
            work["seriesEvidence"].append({"kind": "curated-title-and-author-match", "curatedId": item["id"], "strength": "candidate"})
            work["seriesMembership"] = "candidate-match-needs-verification"
        entries.append({"id": item["id"], "sequence": item["sequence"], "title": item["title"], "author": item["author"],
                        "candidateWorkIds": [w["id"] for w in candidates],
                        "matchStatus": "unresolved" if not candidates else "ambiguous-candidates" if len(candidates) > 1 else "candidate-needs-verification"})
    return {"kind": curated["orderType"], "scope": bounded_text(curated.get("scope"), 250),
            "title": bounded_text(curated.get("title"), 500), "evidence": curated["evidence"],
            "items": entries, "note": "Curated entry order is source-backed; Open Library matches remain candidates, including possible graphic adaptations. Not a complete franchise list."}


def build_report(args, client):
    query = bounded_text(args.query, 500)
    report = {"schemaVersion": 1, "generatedAt": now_iso(), "metadataOnly": True, "provider": "Open Library",
              "mode": args.mode, "query": query, "status": "candidates", "selectedAuthor": None,
              "authorCandidates": [], "works": [], "coverage": {}, "readingOrder": {"kind": "unknown", "items": []},
              "displayOrder": args.sort, "provenance": client.provenance, "warnings": client.warnings,
              "primaryDocumentation": PRIMARY_DOCS,
              "limitations": ["Metadata records do not grant access to full text or confirm a downloadable file.",
                              "Open Library may contain omissions, duplicate work records and incorrect metadata; IDs are not merged by title.",
                              "Publication-year display sorting is not recommended reading order or story chronology.",
                              "Pagination is bounded and not a promise of a complete author bibliography or franchise."]}
    selected = None
    if args.author_id:
        aid = identifier(args.author_id, "A")
        if not aid or aid != args.author_id:
            raise DiscoveryError("AUTHOR_ID", "Use an author ID such as OL2623461A, without URL/path")
        selected = author_candidate(client.get(f"/authors/{aid}.json"))
        if not selected or selected["id"] != aid:
            raise DiscoveryError("AUTHOR_ID", "Provider returned a different author")
        report["selectedAuthor"] = {**selected, "selection": "explicit-id"}
    if args.mode == "author" and not selected:
        response = client.get("/search/authors.json", {"q": query, "limit": min(30, args.limit), "offset": 0})
        docs = response.get("docs")
        total = response.get("numFound", response.get("num_found"))
        if not isinstance(docs, list) or not isinstance(total, int):
            raise DiscoveryError("SOURCE_FORMAT", "Unexpected author search metadata")
        selected, candidates = choose_author(query, docs, total)
        report["authorCandidates"] = candidates
        report["authorSearchCoverage"] = {"returned": len(candidates), "providerTotal": total, "truncated": total > len(docs)}
        if not selected:
            report["status"] = "needs-clarification" if candidates else "not-found"
            report["nextAction"] = "Choose the person by ID, dates and known work; repeat author with --author-id ID. No bibliography was chosen automatically."
            return report
        report["selectedAuthor"] = {**selected, "selection": "sole-exact-metadata-match"}
    if args.mode == "author":
        works, coverage = collect_pages(client, f"/authors/{selected['id']}/works.json", {}, limit=args.limit, page_size=args.page_size, selected_author=selected)
        report["status"] = "resolved-author"
        report["warnings"].append("Author works metadata may omit first publication dates; missing years remain unknown. Authorship includes catalogued collaborations, collections and adaptations, not only solo novels.")
    else:
        curated = load_curated_order(args.curated_order) if args.curated_order else None
        aliases = list(dict.fromkeys([query, *args.alias]))
        if curated:
            terms = []
            for item in curated["items"]:
                titles = [item["title"], *item.get("searchAliases", [])]
                title_query = " OR ".join("title:" + solr_phrase(title) for title in titles)
                terms.append("((" + title_query + ") AND author:" + solr_phrase(item["author"]) + ")")
            solr = "(" + " OR ".join(terms) + ")"
            report["searchScope"] = "curated-seed-candidates-only"
        else:
            solr = "(" + " OR ".join(solr_phrase(alias) for alias in aliases) + ")"
            report["searchScope"] = "literal-metadata-query-candidates"
        if selected:
            solr += " AND author_key:" + selected["id"]
        if len(solr) > 12000:
            raise DiscoveryError("QUERY_LIMIT", "Curated query too large; split into smaller cycles")
        works, coverage = collect_pages(client, "/search.json", {"q": solr, "fields": FIELDS}, limit=args.limit, page_size=args.page_size, selected_author=selected)
        if args.mode == "series":
            for work in works:
                work["seriesEvidence"] = series_evidence(work, aliases)
                work["seriesMembership"] = "candidate-match-needs-verification" if work["seriesEvidence"] else "unverified-search-hit"
            if curated:
                report["readingOrder"] = attach_curated(works, curated)
            else:
                report["readingOrder"]["note"] = "No verified series order supplied; metadata search hits alone are not series membership. Use --curated-order with source evidence."
        if not works:
            report["status"] = "not-found"
    if args.sort == "publication":
        works.sort(key=lambda work: (work["firstPublicationYear"] is None, work["firstPublicationYear"] or 0, normalized(work["title"]), work["id"]))
    elif args.sort == "title":
        works.sort(key=lambda work: (normalized(work["title"]), work["id"]))
    report["works"], report["coverage"] = works, coverage
    if coverage.get("issue"):
        report["status"] = "partial" if works else "error"
    return report


def markdown_text(value):
    text = html.escape(str(value), quote=False).replace("\\", "\\\\")
    for token in ("|", "[", "]", "*", "_", "`", "#"):
        text = text.replace(token, "\\" + token)
    return " ".join(text.split())


def markdown_url(value):
    # Parentheses/brackets/angle brackets can terminate a Markdown link even
    # when the underlying URL has an allowed HTTPS scheme.
    if not safe_url(value):
        raise DiscoveryError("EXPORT_URL", "Invalid metadata source URL")
    return urllib.parse.quote(value, safe=":/?&=+%#@;,$!~*'_-.")


def render_markdown(report):
    esc = markdown_text
    lines = ["# Gargantua — каталог метаданных", "", f"Запрос: **{esc(report['query'])}** · Режим: {esc(report['mode'])} · Статус: {esc(report['status'])}",
             f"Собрано: {esc(report['generatedAt'])}. Только метаданные; тексты книг не скачивались.", ""]
    if report.get("nextAction"):
        lines.extend([esc(report["nextAction"]), ""])
    if report["authorCandidates"]:
        lines += ["## Кандидаты автора — выберите личность", "", "| ID | Имя | Даты | Известная работа |", "|---|---|---|---|"]
        for candidate in report["authorCandidates"]:
            lines.append(f"| {candidate['id']} | {esc(candidate['name'])} | {esc(candidate['birthDate'])} — {esc(candidate['deathDate'])} | {esc(candidate['topWork'])} |")
        lines.append("")
    order = report["readingOrder"]
    lines += [f"## Порядок чтения: {esc(order['kind'])}", "", esc(order.get("note", "Не установлен; сортировка годов не является порядком чтения.")), ""]
    if order["items"]:
        lines += ["| Порядок | Название | Сопоставление с Open Library |", "|---|---|---|"]
        for item in order["items"]:
            lines.append(f"| {item['sequence']} | {esc(item['title'])} | {esc(item['matchStatus'])}: {esc(', '.join(item['candidateWorkIds']))} |")
        lines.extend(["", "Область: " + esc(order.get("scope", "unknown")), ""])
    lines += ["## Найденные произведения / кандидаты", "", f"Показано: {len(report['works'])}; сортировка: {esc(report['displayOrder'])}.", "", "| ID | Название | Авторы | Первый год из metadata | Принадлежность серии |", "|---|---|---|---|---|"]
    for work in report["works"]:
        lines.append(f"| [{work['id']}]({markdown_url(work['url'])}) | {esc(work['title'])} | {esc(', '.join(work['authorNames']))} | {work['firstPublicationYear'] or 'неизвестен'} | {esc(work['seriesMembership'])} |")
    lines += ["", "## Ограничения", "", *["- " + esc(x) for x in [*report["limitations"], *report["warnings"]]], "", "## Источники и даты", ""]
    for item in report["provenance"]:
        url = item["url"]
        lines.append(f"- [Open Library metadata]({markdown_url(url)}): {esc(item.get('fetchedAt'))}; cache={item['cache']}; stale={item['stale']}")
    for item in order.get("evidence", []):
        lines.append(f"- [Источник порядка]({markdown_url(item['url'])}): {esc(item.get('checkedAt'))}; {esc(item.get('role', ''))}")
    if report.get("error"):
        lines.extend(["", "Ошибка: " + esc(report["error"])])
    if report.get("coverage", {}).get("issue"):
        lines.extend(["", "Частичный результат: " + esc(report["coverage"]["issue"])])
    return "\n".join(lines) + "\n"


def render_html(report):
    esc = lambda value: html.escape(str(value), quote=True)
    rows = []
    for work in report["works"]:
        rows.append(f'<tr><td><a href="{esc(work["url"])}" rel="noreferrer">{esc(work["id"])}</a></td><td>{esc(work["title"])}</td><td>{esc(", ".join(work["authorNames"]))}</td><td>{work["firstPublicationYear"] or "неизвестен"}</td><td>{esc(work["seriesMembership"])}</td></tr>')
    authors = "".join(f'<li><b>{esc(c["id"])} — {esc(c["name"])}</b>; {esc(c["birthDate"])} — {esc(c["deathDate"])}; известная работа: {esc(c["topWork"])}</li>' for c in report["authorCandidates"])
    order = report["readingOrder"]
    ordered = "".join(f'<li value="{item["sequence"]}">{esc(item["title"])} — {esc(item["matchStatus"])}; кандидаты: {esc(", ".join(item["candidateWorkIds"]))}</li>' for item in order["items"])
    sources = "".join(f'<li><a href="{esc(item["url"])}" rel="noreferrer">Open Library metadata</a>; {esc(item.get("fetchedAt"))}; cache={item["cache"]}; stale={item["stale"]}</li>' for item in report["provenance"])
    sources += "".join(f'<li><a href="{esc(item["url"])}" rel="noreferrer">Источник порядка</a>; {esc(item.get("checkedAt"))}; {esc(item.get("role", ""))}</li>' for item in order.get("evidence", []))
    limitations = "".join("<li>" + esc(value) + "</li>" for value in [*report["limitations"], *report["warnings"]])
    style = "body{font:16px/1.6 system-ui,sans-serif;background:#101013;color:#eee;max-width:1200px;margin:3em auto;padding:0 1em}h1,h2{color:#f27b85}a{color:#a9d5ff}table{border-collapse:collapse;width:100%;font-size:.92rem}td,th{padding:.7em;text-align:left;border-bottom:1px solid #45454a;vertical-align:top}.scroll{overflow:auto}code{overflow-wrap:anywhere}li{margin:.5em 0}.notice{border-left:4px solid #cc2438;padding:1em;background:#202024}"
    return ('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
            f'<title>Gargantua — {esc(report["query"])}</title><style>{style}</style><main><h1>Gargantua — каталог метаданных</h1>'
            f'<p>Запрос: <b>{esc(report["query"])}</b> · Режим: {esc(report["mode"])} · Статус: {esc(report["status"])}</p><p>{esc(report["generatedAt"])}</p>'
            f'<p class="notice">Только метаданные. Тексты и архивы книг не скачивались. {esc(report.get("nextAction", ""))}</p>'
            f'<h2>Кандидаты автора</h2><ul>{authors}</ul><h2>Порядок чтения: {esc(order["kind"])}</h2><p>{esc(order.get("note", "Не установлен"))}</p><p>Область: {esc(order.get("scope", "unknown"))}</p><ol>{ordered}</ol>'
            f'<h2>Произведения / кандидаты: {len(report["works"])}</h2><p>Сортировка отображения: {esc(report["displayOrder"])}. Год публикации не является хронологией сюжета.</p>'
            f'<div class="scroll"><table><thead><tr><th>ID</th><th>Название</th><th>Авторы</th><th>Год из metadata</th><th>Принадлежность серии</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
            f'<h2>Охват и ограничения</h2><pre>{esc(json.dumps(report["coverage"], ensure_ascii=False, indent=2))}</pre><ul>{limitations}</ul>'
            f'<p>{esc(report.get("error", ""))}</p><h2>Источники и даты</h2><ul>{sources}</ul></main></html>\n')


def export_report(report, directory, overwrite=False):
    directory = Path(directory)
    payloads = {"catalog.json": json.dumps(report, ensure_ascii=False, indent=2) + "\n", "catalog.md": render_markdown(report), "catalog.html": render_html(report)}
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / ".catalog-export.lock"
    try:
        handle = lock.open("x", encoding="utf-8")
    except FileExistsError as exc:
        raise DiscoveryError("OUTPUT_BUSY", "Output is in use or a previous export was interrupted; use another directory or inspect its .catalog-export.lock") from exc
    try:
        with handle:
            handle.write(json.dumps({"pid": os.getpid(), "startedAt": now_iso()}))
        if not overwrite and any((directory / filename).exists() for filename in payloads):
            raise DiscoveryError("OUTPUT_EXISTS", "Output exists; choose another --output directory or explicitly use --overwrite")
        for filename, content in payloads.items():
            atomic_write(directory / filename, content.encode("utf-8"))
    finally:
        lock.unlink(missing_ok=True)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Gargantua: bounded metadata search, author disambiguation and series candidates. No text downloads.",
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog='''Examples:
  python scripts/catalog-discovery.py author "Arthur C. Clarke" --output .local/catalog/clarke-candidates
  python scripts/catalog-discovery.py author "Arthur C. Clarke" --author-id OL2623461A --sort publication --limit 60 --output .local/catalog/clarke
  python scripts/catalog-discovery.py series "Warriors" --alias "Коты-воители" --curated-order docs/gargantua/examples/catalogs/warriors-first-arc-order.json --output .local/catalog/warriors
  python scripts/catalog-discovery.py search "Rendezvous with Rama" --output .local/catalog/rama
  python scripts/catalog-discovery.py author "Arthur C. Clarke" --offline --output .local/catalog/cached-candidates

Writes catalog.json + catalog.html + catalog.md under explicit --output.
Author ambiguity is exported for selection, never resolved by the first hit.
Publication-year sort is not recommended reading order. Missing dates remain unknown.
Only Open Library JSON metadata endpoints are contacted; no books, covers or archives.
Exit codes: 0 report written (including clarification), 1 source/partial error, 2 invalid input/output.
''')
    parser.add_argument("mode", choices=("search", "author", "series"))
    parser.add_argument("query", help="Literal book/author/series name (not a URL or Solr command)")
    parser.add_argument("--output", type=Path, required=True, help="Explicit directory for JSON, HTML and Markdown exports")
    parser.add_argument("--author-id", help="Explicit previously verified Open Library author ID, e.g. OL2623461A")
    parser.add_argument("--alias", action="append", default=[], help="Additional literal series alias; at most 5")
    parser.add_argument("--curated-order", type=Path, help="Source-backed curated series order JSON schemaVersion 1; series mode only")
    parser.add_argument("--sort", choices=("relevance", "title", "publication"), default="relevance")
    parser.add_argument("--limit", type=int, default=100, help="Maximum unique work records, 1–500; not a completeness claim")
    parser.add_argument("--page-size", type=int, default=50, help="Metadata records per page, 1–100")
    parser.add_argument("--max-requests", type=int, default=10, help="Actual network calls including retries, 1–25")
    parser.add_argument("--timeout", type=float, default=15, help="Socket timeout per attempt, 1–30 seconds")
    parser.add_argument("--cache-dir", type=Path, default=Path(".local/catalog-discovery-cache"))
    parser.add_argument("--cache-hours", type=float, default=24, help="Cache freshness, 0–168 hours")
    parser.add_argument("--offline", action="store_true", help="Only exact cached requests; stale cache is explicitly marked")
    parser.add_argument("--contact", help="Optional real contact email for API User-Agent; never invent an address")
    parser.add_argument("--overwrite", action="store_true", help="Explicitly replace existing three report files")
    args = parser.parse_args(argv)
    if not bounded_text(args.query) or len(args.query) > 500 or any(ord(c) < 32 for c in args.query):
        parser.error("query must be 1–500 characters without control characters")
    if not 1 <= args.limit <= 500 or not 1 <= args.page_size <= 100 or not 1 <= args.max_requests <= 25:
        parser.error("limit/page-size/max-requests outside documented bounds")
    if not math.isfinite(args.timeout) or not 1 <= args.timeout <= 30 or not math.isfinite(args.cache_hours) or not 0 <= args.cache_hours <= 168:
        parser.error("timeout/cache-hours outside documented bounds")
    if len(args.alias) > 5 or any(not bounded_text(alias) or len(alias) > 200 or any(ord(c) < 32 for c in alias) for alias in args.alias):
        parser.error("at most 5 non-empty aliases, up to 200 characters")
    if args.curated_order and args.mode != "series":
        parser.error("--curated-order is supported only in series mode")
    if args.contact and not re.fullmatch(r"[^\s@()<>]+@[^\s@()<>]+\.[^\s@()<>]+", args.contact):
        parser.error("--contact must be an actual email address without spaces/control characters")
    return args


def main(argv=None):
    args = parse_args(argv)
    client = MetadataClient(args.cache_dir, timeout=args.timeout, max_requests=args.max_requests,
                            cache_hours=args.cache_hours, offline=args.offline, contact=args.contact)
    try:
        report = build_report(args, client)
        export_report(report, args.output, args.overwrite)
    except (DiscoveryError, OSError, ValueError, TypeError) as exc:
        code = getattr(exc, "code", "INVALID_INPUT_OR_IO")
        print(f"{code}: {exc}", file=sys.stderr)
        return 2 if code in ("INVALID_INPUT_OR_IO", "OUTPUT_EXISTS", "OUTPUT_BUSY", "AUTHOR_ID", "CURATED_FORMAT", "CURATED_LIMIT", "QUERY_LIMIT") else 1
    print(json.dumps({"status": report["status"], "works": len(report["works"]), "authorCandidates": len(report["authorCandidates"]),
                      "networkRequests": client.requests, "readingOrderType": report["readingOrder"]["kind"], "output": str(args.output.resolve())}, ensure_ascii=False))
    return 1 if report["status"] in ("partial", "error") else 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
