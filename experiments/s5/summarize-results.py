"""Summarize existing S5 receipts without importing a model or changing results.

No overlap metric is promoted to a semantic score. Missing experiments stay
missing; interrupted and failed cases are not counted as completed translations.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PILOT = ROOT / ".local/s5-pilot"
TRANSLATION_CASES = (
    "mt-opus-baseline", "mt-m2m-baseline", "mt-m2m-baseline-retry-01",
    "mt-m2m-baseline-stable", "qwen-small-gpu-baseline",
    "qwen-small-gpu-baseline-retry-01", "qwen4-gpu-baseline",
    "qwen35-gpu-baseline", "qwen35-gpu-bounded-baseline",
    "opus-sentence-baseline-01", "opus-sentence-baseline-02",
    "opus-sentence-chapter-01", "qwen35-gpu-holdout", "qwen35-gpu-chapter",
    "qwen35-gpu-qa-holdout", "qwen35-gpu-qa-chapter",
    "qwen35-cpu-holdout",
)


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def receipt(path):
    return {"path": path.relative_to(ROOT).as_posix(), "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def summarize_case(name):
    directory = PILOT / name
    output = {"case": name}
    result_paths = [directory / "results" / x for x in ("result.json", "translation.json")]
    path = next((x for x in result_paths if x.is_file()), None)
    if path:
        report = read(path)
        output.update({"result": receipt(path), "status": report.get("status"),
                       "model": report.get("model", {}).get("id"), "variant": report.get("variant"),
                       "settings": report.get("settings"), "summary": report.get("summary"),
                       "runnerProcessPeakRssBytes": report.get("processPeakRssBytes"),
                       "runnerRssScope": "For llama-http this is the tiny client, NOT the model server",
                       "errors": report.get("errors", [])})
        rows = [r for r in report.get("segments", [])
                if r.get("status") == "generated" and r.get("language") == "en"]
        if rows:
            source = read(ROOT / "experiments/s5/translation/corpus.json")
            by_id = {r["id"]: r["text"] for r in source["segments"]}
            if all(r["id"] in by_id for r in rows):
                seconds = sum(r["wallSeconds"] for r in rows)
                characters = sum(len(by_id[r["id"]]) for r in rows)
                output["baselineEnglishOnly"] = {"calls": len(rows), "sourceCharacters": characters,
                    "inferenceSeconds": seconds, "charactersPerSecond": characters / seconds}
    else:
        output["status"] = "NO_RESULT"
    launch_path = next((directory / x for x in ("case.json", "launch.json") if (directory / x).is_file()), None)
    if launch_path:
        launch = read(launch_path)
        output["launch"] = receipt(launch_path)
        output["launchStatus"] = launch.get("status")
        output["launchCleanup"] = launch.get("cleanup")
        output["serverLimits"] = launch.get("serverLimits")
    telemetry = []
    for telemetry_path in sorted(directory.glob("**/telemetry-summary.json")):
        report = read(telemetry_path)
        telemetry.append({"receipt": receipt(telemetry_path), **report})
    output["telemetry"] = telemetry
    output["reviews"] = [receipt(x) for x in sorted(directory.glob("*review*.json"))]
    recovery_path = directory / "recovery.json"
    if recovery_path.exists():
        recovered = read(recovery_path)
        output["recovery"] = {"receipt": receipt(recovery_path), "data": recovered}
        output["executionStatus"] = ("recovered-completed" if recovered.get("status") == "completed"
                                     and output.get("status") == "completed" else "recovery-not-completed")
        snapshot = directory / "interrupted-result.json"
        if snapshot.exists():
            output["originalInterruptedResult"] = receipt(snapshot)
        output["initialAttemptStatusRetained"] = output.get("launchStatus")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PILOT / "measured-results.json")
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(PILOT.resolve()) or output == PILOT.resolve():
        raise ValueError("Summary must remain inside the pilot evidence directory")
    summary = {"schemaVersion": 1, "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope": "Actual local screening only; not production readiness or a representative book benchmark",
        "hardware": read(PILOT / "hardware-before.json"),
        "translationCases": [summarize_case(name) for name in TRANSLATION_CASES if (PILOT / name).is_dir()],
        "notRun": [name for name in TRANSLATION_CASES if not (PILOT / name).is_dir()],
        "qualityReviewKind": "Assistant source-based annotations; not a human or fully blind evaluation",
        "modelAntivirusStatus": "NOT_FULLY_SCANNED",
        "audioListeningStatus": "NOT_LISTENED"}
    review_paths = [ROOT / "experiments/s5/translation" / x for x in (
        "opus-paragraph-assistant-review.json", "qwen3-paragraph-assistant-review.json",
        "qwen35-paragraph-assistant-review.json", "qwen35-holdout-assistant-review.json",
        "qwen35-chapter-assistant-review.json")]
    review_paths.append(PILOT / "quality-fixture-initial/review.json")
    summary["sourceSemanticReviews"] = [receipt(p) for p in review_paths if p.is_file()]
    for key, rel in (("ttsComparison", "tts-comparison-01/batch.json"),
                     ("ttsResumeProof", "tts-soak-denis-01/independent-proof.json"),
                     ("translationResumeProof", "mt-resume-01/proof.json"),
                     ("productionFinal", "production-final.json")):
        path = PILOT / rel
        if path.exists():
            summary[key] = {"receipt": receipt(path), "data": read(path)}
    for key, path in (("selectedProfiles", ROOT / "experiments/s5/selected-profiles.json"),
                      ("selectionValidation", PILOT / "selection-validation.json"),
                      ("finalTranslationUnitTests", ROOT / ".local/test-results/s5-translation-final-02/report.json")):
        if path.is_file():
            summary[key] = receipt(path)
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "translationCases": len(summary["translationCases"]),
                      "modelLoaded": False, "libraryModified": False}))


if __name__ == "__main__":
    main()
