"""Offline contract tests for the bounded metadata catalog pilot."""
import argparse
from contextlib import contextmanager
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("catalog_discovery", ROOT / "scripts/catalog-discovery.py")
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)


@contextmanager
def workspace_temporary_directory():
    parent = ROOT / "tests/.catalog-discovery-tmp"
    parent.mkdir(exist_ok=True)
    # Verify the absolute cleanup target is inside this test workspace.
    with tempfile.TemporaryDirectory(dir=parent) as directory:
        if not Path(directory).resolve().is_relative_to(ROOT.resolve()):
            raise AssertionError("Test temporary directory escaped the workspace")
        yield directory


def work(key, title="Shared title", year=None, **extra):
    result = {"key": "/works/" + key, "title": title, "author_name": ["Erin Hunter"], "author_key": ["OL1A"], **extra}
    if year is not None:
        result["first_publish_year"] = year
    return result


def options(mode="search", query="Example", **extra):
    return argparse.Namespace(mode=mode, query=query, author_id=None, alias=[], curated_order=None,
                              limit=100, page_size=50, sort="relevance", **extra)


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.provenance = []
        self.warnings = []

    def get(self, path, params=None):
        self.calls.append((path, params))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class Response:
    def __init__(self, body, headers=None):
        self.status = 200
        self.headers = {"Content-Type": "application/json", **(headers or {})}
        self.body = io.BytesIO(body)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read1(self, count):
        return self.body.read(count)


class Opener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request.full_url, timeout))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class DiscoveryTests(unittest.TestCase):
    def test_author_identity_requires_clarification_even_if_first_name_exact(self):
        docs = [{"key": "OL1A", "name": "Arthur C. Clarke", "top_work": "Rendezvous with Rama"},
                {"key": "OL2A", "name": "Arthur Clarke", "birth_date": "1900"}]
        selected, candidates = catalog.choose_author("Arthur C. Clarke", docs, 2)
        self.assertIsNone(selected)
        self.assertEqual([c["id"] for c in candidates], ["OL1A", "OL2A"])
        selected, _ = catalog.choose_author("Arthur C. Clarke", docs[:1], 90)
        self.assertIsNone(selected, "a truncated first page is not a unique identity")

    def test_only_single_exact_author_metadata_can_auto_select(self):
        docs = [{"key": "/authors/OL1A", "name": "Arthur C. Clarke"}]
        self.assertEqual(catalog.choose_author("Arthur C Clarke", docs, 1)[0]["id"], "OL1A")
        self.assertIsNone(catalog.choose_author("Clarke", docs, 1)[0])

    def test_author_ambiguity_does_not_fetch_bibliography(self):
        client = FakeClient([{"numFound": 2, "docs": [{"key": "OL1A", "name": "A"}, {"key": "OL2A", "name": "A"}]}])
        report = catalog.build_report(options("author", "A"), client)
        self.assertEqual(report["status"], "needs-clarification")
        self.assertEqual(report["works"], [])
        self.assertEqual(len(client.calls), 1)

    def test_duplicate_ids_deduplicate_but_same_title_does_not_merge(self):
        client = FakeClient([{"numFound": 4, "docs": [work("OL1W"), work("OL2W")]},
                             {"numFound": 4, "docs": [work("OL2W"), work("OL3W")]}])
        works, coverage = catalog.collect_pages(client, "/search.json", {}, limit=5, page_size=2)
        self.assertEqual([w["id"] for w in works], ["OL1W", "OL2W", "OL3W"])
        self.assertEqual(coverage["duplicatesById"], 1)
        self.assertEqual(client.calls[1][1]["offset"], 2)
        self.assertFalse(coverage["completeBibliography"])

    def test_pagination_uses_raw_page_count_and_never_loops_repeated_pages(self):
        client = FakeClient([{"numFound": 10, "docs": [work("OL1W"), work("OL2W")]},
                             {"numFound": 10, "docs": [work("OL1W"), work("OL2W")]}])
        _, coverage = catalog.collect_pages(client, "/search.json", {}, limit=10, page_size=2)
        self.assertEqual(coverage["issue"]["code"], "REPEATED_PAGE")
        self.assertEqual(len(client.calls), 2)

    def test_network_failure_preserves_partial_metadata(self):
        client = FakeClient([{"numFound": 4, "docs": [work("OL1W"), work("OL2W")]},
                             catalog.DiscoveryError("SOURCE_UNAVAILABLE", "temporary")])
        works, coverage = catalog.collect_pages(client, "/search.json", {}, limit=4, page_size=2)
        self.assertEqual(len(works), 2)
        self.assertFalse(coverage["exhaustedPages"])
        self.assertEqual(coverage["issue"]["code"], "SOURCE_UNAVAILABLE")

    def test_unicode_query_survives_and_solr_is_literal(self):
        client = FakeClient([{"numFound": 1, "docs": [work("OL1W", "Коты-воители: Лёд")] }])
        report = catalog.build_report(options("series", 'Коты-воители "OR"'), client)
        self.assertEqual(report["query"], 'Коты-воители "OR"')
        self.assertEqual(report["works"][0]["title"], "Коты-воители: Лёд")
        self.assertIn('\\"OR\\"', client.calls[0][1]["q"])
        self.assertEqual(catalog.normalized("ЛЁД"), catalog.normalized("лед"))

    def test_missing_and_ambiguous_publication_year_stay_unknown(self):
        for value in ({}, {"first_publish_year": True}, {"first_publish_year": 0}, {"first_publish_date": "revised 1968 / 1972"}):
            self.assertIsNone(catalog.publication_year(value))
        self.assertEqual(catalog.publication_year({"first_publish_date": "May 1, 1968"}), 1968)

    def test_publication_sort_does_not_claim_reading_order(self):
        args = options("series", "Warriors")
        args.sort = "publication"
        client = FakeClient([{"numFound": 3, "docs": [work("OL1W", "Unknown"), work("OL2W", "New", 2005), work("OL3W", "Old", 2003)]}])
        report = catalog.build_report(args, client)
        self.assertEqual([w["id"] for w in report["works"]], ["OL3W", "OL2W", "OL1W"])
        self.assertEqual(report["readingOrder"]["kind"], "unknown")
        self.assertEqual(report["works"][0]["seriesMembership"], "unverified-search-hit")

    def test_series_metadata_match_is_evidence_not_confirmed_membership(self):
        record = catalog.normalize_work(work("OL1W", "Warriors: Into the Wild", subject=["Warriors (Fictitious characters)"]))
        evidence = catalog.series_evidence(record, ["Warriors"])
        self.assertTrue(evidence)
        self.assertTrue(all(e["strength"] == "candidate" for e in evidence))

    def test_curated_order_keeps_own_sequence_and_ambiguous_work_candidates(self):
        curated = {"orderType": "official-cycle-order", "scope": "first-arc-only", "title": "Example", "evidence": [],
                   "items": [{"id": "curated:x:2", "sequence": 2, "title": "Second", "author": "Erin Hunter"},
                             {"id": "curated:x:1", "sequence": 1, "title": "Into the Wild", "author": "Erin Hunter"}]}
        works = [catalog.normalize_work(work("OL1W", "Into the Wild", 2003)), catalog.normalize_work(work("OL2W", "Into the Wild", 2024))]
        order = catalog.attach_curated(works, curated)
        self.assertEqual(order["kind"], "official-cycle-order")
        self.assertEqual(order["scope"], "first-arc-only")
        self.assertEqual(order["items"][0]["matchStatus"], "ambiguous-candidates")
        self.assertEqual(len(order["items"][0]["candidateWorkIds"]), 2)
        self.assertEqual(order["items"][1]["matchStatus"], "unresolved")

    def test_curated_order_rejects_javascript_source_and_duplicate_sequence(self):
        doc = {"schemaVersion": 1, "orderType": "official-cycle-order", "evidence": [{"url": "javascript:alert(1)", "checkedAt": "2026-10-22"}],
               "items": [{"id": "curated:a", "sequence": 1, "title": "X", "author": "A"}]}
        with workspace_temporary_directory() as directory:
            path = Path(directory) / "order.json"
            path.write_text(json.dumps(doc), encoding="utf-8")
            with self.assertRaises(catalog.DiscoveryError):
                catalog.load_curated_order(path)
            doc["evidence"][0]["url"] = "https://example.org/order"
            doc["items"].append({"id": "curated:b", "sequence": 1, "title": "Y", "author": "A"})
            path.write_text(json.dumps(doc), encoding="utf-8")
            with self.assertRaises(catalog.DiscoveryError):
                catalog.load_curated_order(path)

    def test_html_and_markdown_export_do_not_execute_title_markup(self):
        attack = '</title><script>alert(1)</script><img src=x onerror="evil()">'
        report = catalog.build_report(options(query=attack), FakeClient([{"numFound": 1, "docs": [work("OL1W", attack)]}]))
        document = catalog.render_html(report)
        self.assertNotIn("<script>", document)
        self.assertNotIn("<img ", document)
        self.assertIn("&lt;script&gt;", document)
        self.assertIn("Content-Security-Policy", document)
        self.assertNotIn("<script>", catalog.render_markdown(report))

    def test_export_json_utf8_and_requires_explicit_overwrite(self):
        report = catalog.build_report(options(query="Коты-воители"), FakeClient([{"numFound": 0, "docs": []}]))
        with workspace_temporary_directory() as directory:
            catalog.export_report(report, directory)
            self.assertEqual(json.loads((Path(directory) / "catalog.json").read_text(encoding="utf-8"))["query"], "Коты-воители")
            self.assertTrue((Path(directory) / "catalog.html").exists())
            self.assertTrue((Path(directory) / "catalog.md").exists())
            with self.assertRaises(catalog.DiscoveryError):
                catalog.export_report(report, directory)
            catalog.export_report(report, directory, overwrite=True)

    def test_markdown_source_url_cannot_inject_another_link(self):
        report = catalog.build_report(options(), FakeClient([{"numFound": 0, "docs": []}]))
        malicious = "https://example.org/)[x](javascript:alert(1))"
        self.assertTrue(catalog.safe_url(malicious), "HTTPS alone is not safe Markdown serialization")
        report["readingOrder"]["evidence"] = [{"url": malicious, "checkedAt": "2026-10-22"}]
        rendered = catalog.render_markdown(report)
        self.assertNotIn(")[x](javascript:", rendered)
        self.assertIn("%29%5Bx%5D%28javascript:", rendered)

    def test_concurrent_exports_cannot_overwrite_without_permission(self):
        report = catalog.build_report(options(), FakeClient([{"numFound": 0, "docs": []}]))
        entered, release = threading.Event(), threading.Event()
        original = catalog.atomic_write
        failures = []

        def slow_write(path, data):
            if path.name == "catalog.json":
                entered.set()
                if not release.wait(3):
                    raise AssertionError("Test export was not released")
            return original(path, data)

        def run_first(directory):
            try:
                catalog.export_report(report, directory)
            except Exception as exc:
                failures.append(exc)

        with workspace_temporary_directory() as directory, mock.patch.object(catalog, "atomic_write", slow_write):
            first = threading.Thread(target=run_first, args=(directory,))
            first.start()
            try:
                self.assertTrue(entered.wait(3))
                with self.assertRaises(catalog.DiscoveryError) as failure:
                    catalog.export_report({**report, "query": "Second export"}, directory)
                self.assertEqual(failure.exception.code, "OUTPUT_BUSY")
            finally:
                release.set()
                first.join(3)
            self.assertFalse(failures)
            self.assertEqual(json.loads((Path(directory) / "catalog.json").read_text(encoding="utf-8"))["query"], "Example")

    def test_cache_replay_is_metadata_only_and_provenance_has_source_date(self):
        opener = Opener([Response(b'{"numFound": 0, "docs": []}')])
        with workspace_temporary_directory() as directory:
            first = catalog.MetadataClient(directory, opener=opener, sleep=lambda _: None)
            self.assertEqual(first.get("/search.json", {"q": "X"})["numFound"], 0)
            second = catalog.MetadataClient(directory, offline=True, opener=Opener([]))
            second.get("/search.json", {"q": "X"})
            self.assertEqual(second.requests, 0)
            self.assertTrue(second.provenance[0]["cache"])
            self.assertIsNotNone(second.provenance[0]["fetchedAt"])
            with self.assertRaises(catalog.DiscoveryError) as failure:
                second.get("/search.json", {"q": "different"})
            self.assertEqual(failure.exception.code, "CACHE_MISS")

    def test_unexpected_endpoint_never_calls_network(self):
        with workspace_temporary_directory() as directory:
            opener = Opener([])
            client = catalog.MetadataClient(directory, opener=opener)
            for endpoint in ("https://evil.example/book.epub", "/books/OL1M.epub", "/authors/../../secrets.json"):
                with self.assertRaises(catalog.DiscoveryError):
                    client.get(endpoint)
            self.assertEqual(opener.calls, [])

    def test_retry_budget_counts_actual_calls(self):
        error = urllib.error.HTTPError("https://openlibrary.org/search.json", 503, "Unavailable", {}, None)
        opener = Opener([error])
        with workspace_temporary_directory() as directory:
            client = catalog.MetadataClient(directory, opener=opener, max_requests=1, sleep=lambda _: None)
            with self.assertRaises(catalog.DiscoveryError) as failure:
                client.get("/search.json")
            self.assertEqual(failure.exception.code, "REQUEST_BUDGET")
            self.assertEqual(len(opener.calls), 1)

    def test_long_retry_after_is_not_bypassed(self):
        error = urllib.error.HTTPError("https://openlibrary.org/search.json", 429, "Rate limited", {"Retry-After": "3600"}, None)
        opener = Opener([error])
        with workspace_temporary_directory() as directory:
            client = catalog.MetadataClient(directory, opener=opener, sleep=lambda _: None)
            with self.assertRaises(catalog.DiscoveryError) as failure:
                client.get("/search.json")
            self.assertEqual(failure.exception.code, "RATE_LIMITED")
            self.assertEqual(len(opener.calls), 1)

    def test_response_size_limit_before_parsing(self):
        opener = Opener([Response(b"{}", {"Content-Length": str(catalog.MAX_RESPONSE + 1)})])
        with workspace_temporary_directory() as directory:
            client = catalog.MetadataClient(directory, opener=opener)
            with self.assertRaises(catalog.DiscoveryError) as failure:
                client.get("/search.json")
            self.assertEqual(failure.exception.code, "RESPONSE_LIMIT")

    def test_corrupt_cache_does_not_bypass_offline_rules(self):
        with workspace_temporary_directory() as directory:
            client = catalog.MetadataClient(directory, offline=True, opener=Opener([]))
            url = catalog.BASE + "/search.json"
            key = catalog.hashlib.sha256(url.encode()).hexdigest()
            (Path(directory) / (key + ".json")).write_text("[invalid", encoding="utf-8")
            with self.assertRaises(catalog.DiscoveryError) as failure:
                client.get("/search.json")
            self.assertEqual(failure.exception.code, "CACHE_MISS")


if __name__ == "__main__":
    unittest.main()
