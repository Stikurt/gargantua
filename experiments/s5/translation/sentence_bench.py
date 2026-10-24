"""Separate OPUS fixture diagnostic; never replaces or rewrites paragraph baseline.

Runs manually reviewed, exact source-covering units independently. This is not a
general sentence splitter and does not claim document-context translation.
"""
import argparse
import datetime
import json
from pathlib import Path
import platform
import time

import bench
import sentence_catalog


def verify_catalog(catalogue, corpus_raw, relative_path, rows):
    if catalogue.get("schemaVersion") != 1 or catalogue.get("variant") != "opus-manual-sentencewise-diagnostic-v1":
        raise ValueError("Unexpected frozen segmentation catalogue")
    approved = [row for row in catalogue["corpora"] if row["path"] == relative_path]
    if len(approved) != 1 or approved[0]["sha256"] != sentence_catalog.digest_bytes(corpus_raw):
        raise ValueError("Corpus differs from frozen catalogue")
    catalogue_rows = [row for row in catalogue["segments"] if row["corpusPath"] == relative_path]
    expected = {row["id"]: row for row in rows if row["language"] == "en"}
    if len(expected) != len(catalogue_rows) or {row["id"] for row in catalogue_rows} != set(expected):
        raise ValueError("Catalogue does not cover exact selected English corpus")
    for row in catalogue_rows:
        source = expected[row["id"]]["text"]
        raw = source.encode("utf-8")
        if row["language"] != "en" or row["sourceBytes"] != len(raw) or row["sourceSha256"] != sentence_catalog.digest_bytes(raw):
            raise ValueError("Frozen source identity mismatch")
        sentence_catalog.validate_intervals(source, row["intervals"])
    return catalogue_rows


def model_input(text, language):
    if language != "en":
        raise ValueError("OPUS diagnostic refuses non-English source; no hidden pivot/fallback")
    # References, glossary and future/previous story paragraphs never enter model input.
    return {"id": "sentence-unit", "language": "en", "text": text}


def reconstruct(source, intervals, translations):
    raw = sentence_catalog.validate_intervals(source, intervals)
    expected = sum(row["kind"] == "translate" for row in intervals)
    if len(translations) != expected or any(not isinstance(text, str) or not text.strip() for text in translations):
        raise ValueError("Cannot reconstruct incomplete translated coverage")
    output, index = [], 0
    for row in intervals:
        if row["kind"] == "whitespace":
            output.append(raw[row["startByte"]:row["endByte"]].decode("utf-8"))
        else:
            output.append(translations[index])
            index += 1
    return "".join(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--corpus", choices=("baseline", "chapter"), default="baseline")
    parser.add_argument("--corpus-file", type=Path)
    parser.add_argument("--catalog", type=Path, default=Path(__file__).with_name("sentence-catalog.lock.json"))
    parser.add_argument("--lock", type=Path, default=Path(__file__).with_name("models.lock.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--segment-id", action="append")
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Never overwrite a completed or incomplete experiment; choose a new output")
    if not 1 <= args.threads <= 6:
        raise ValueError("Threads exceed diagnostic CPU budget")
    args.device, args.max_input_tokens, args.max_output_tokens = "cpu", 384, 384
    relative = "experiments/s5/translation/corpus.json" if args.corpus == "baseline" else "experiments/s5/chapter-inputs.json"
    corpus_file = args.corpus_file or (Path(__file__).with_name("corpus.json") if args.corpus == "baseline" else Path(__file__).parents[1] / "chapter-inputs.json")
    corpus_raw = corpus_file.read_bytes()
    if len(corpus_raw) > 1024*1024:
        raise ValueError("Corpus over diagnostic bound")
    sources = sentence_catalog.source_segments(json.loads(corpus_raw))
    catalogue = json.loads(args.catalog.read_text(encoding="utf-8"))
    ordered = verify_catalog(catalogue, corpus_raw, relative, sources)
    by_id = {row["id"]: row for row in sources}
    if args.segment_id:
        if len(set(args.segment_id)) != len(args.segment_id) or set(args.segment_id)-{row["id"] for row in ordered}:
            raise ValueError("Selected segment is unknown or non-English")
        ordered = [row for row in ordered if row["id"] in args.segment_id]
    model, checked = bench.verify_model(json.loads(args.lock.read_text(encoding="utf-8")), "opus-en-ru", args.model_dir)
    report = {"schemaVersion": 1, "kind": "translation-diagnostic-variant", "variant": catalogue["variant"], "notOriginalParagraphBaseline": True, "notProductionSplitter": True, "status": "running", "startedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "runnerSha256": bench.sha256(Path(__file__)), "catalogueValidatorSha256": bench.sha256(Path(sentence_catalog.__file__)), "frozenBaseRunnerSha256": bench.sha256(Path(bench.__file__)), "catalogueSha256": bench.sha256(args.catalog), "corpusSha256": sentence_catalog.digest_bytes(corpus_raw), "model": {key: model[key] for key in ("id", "repository", "revision", "license")}, "artifactsVerified": checked, "settings": {"threads": args.threads, "device": "cpu", "sourceLanguage": "en", "targetLanguage": "ru", "sourceContext": False, "glossaryApplied": False, "inputTokenCap": 384, "outputTokenCap": 384, "selectedIds": [row["id"] for row in ordered]}, "unsupportedLanguagesExcludedExplicitly": sorted({row["language"] for row in sources if row["language"] != "en"}), "runtime": {"python": platform.python_version(), "torch": bench.version("torch"), "transformers": bench.version("transformers")}, "segments": [], "units": [], "qualityReview": "NOT_REVIEWED", "errors": []}
    bench.save_report(args.output, report)
    try:
        loading = time.perf_counter()
        engine = bench.TransformersEngine(args, "transformers-marian")
        report["loadSeconds"] = time.perf_counter()-loading
        warm = engine.translate(model_input("The rain stopped before dawn.", "en"), args)
        report["excludedWarmupSeconds"] = warm["wallSeconds"]
        for entry in ordered:
            source = by_id[entry["id"]]["text"]
            raw = source.encode("utf-8")
            translations, segment_start = [], time.perf_counter()
            for interval_index, span in enumerate(entry["intervals"]):
                if span["kind"] != "translate":
                    continue
                text = raw[span["startByte"]:span["endByte"]].decode("utf-8")
                response = engine.translate(model_input(text, "en"), args)
                if response is None or not response["text"].strip() or response["finishReason"] != "stop":
                    raise ValueError("Sentence unit failed, empty or capped; no complete segment may be published")
                translations.append(response["text"])
                report["units"].append({"segmentId": entry["id"], "intervalIndex": interval_index, "sourceByteStart": span["startByte"], "sourceByteEnd": span["endByte"], "sourceSha256": sentence_catalog.digest_bytes(text.encode("utf-8")), "sourceCharacters": len(text), **response})
                bench.save_report(args.output, report)
            translated = reconstruct(source, entry["intervals"], translations)
            report["segments"].append({"id": entry["id"], "sourceCoverageComplete": True, "coverageScope": "Every reviewed source text interval generated a nonempty uncapped output, whitespace copied exactly; not proof of semantic completeness.", "sourceCharacters": len(source), "sourceBytes": len(raw), "translationUnits": len(translations), "inclusiveSegmentWallSeconds": time.perf_counter()-segment_start, "text": translated})
            bench.save_report(args.output, report)
            print(json.dumps({"segment": entry["id"], "units": len(translations), "status": "structurally-covered"}), flush=True)
        report["status"] = "completed"
    except Exception as exc:
        report["status"] = "failed"
        report["errors"].append({"type": type(exc).__name__, "message": str(exc)[:1500]})
        raise
    finally:
        wall = sum(row["inclusiveSegmentWallSeconds"] for row in report["segments"])
        chars = sum(row["sourceCharacters"] for row in report["segments"])
        report["summary"] = {"completedSegments": len(report["segments"]), "plannedSegments": len(ordered), "completedUnitCalls": len(report["units"]), "plannedUnitCalls": sum(sum(span["kind"] == "translate" for span in entry["intervals"]) for entry in ordered), "allUnitGenerateSeconds": sum(row["wallSeconds"] for row in report["units"]), "inclusiveCompletedSegmentSeconds": wall, "completeSegmentSourceCharacters": chars, "sourceCharactersPerInclusiveSegmentSecond": chars/wall if wall else None, "timingScope": "All completed unit calls included; inclusive segment time also includes tokenization, decode, ordered reconstruction and per-unit checkpoint writes. Warmup/load excluded and separately recorded."}
        report["finishedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        bench.save_report(args.output, report)


if __name__ == "__main__":
    main()
