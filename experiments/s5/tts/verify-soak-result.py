"""Independent, stdlib-only verification of the completed three-pass TTS pilot.

This reads generated PCM and receipts; it never loads a model or changes audio.
It is intentionally separate from the frozen inference/cache implementation.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import pathlib
import struct


def sha(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def pcm(path):
    size = path.stat().st_size
    if not 44 <= size <= 64 * 1024**2:
        raise ValueError("unexpected generated WAV size")
    with path.open("rb") as stream:
        header = stream.read(44)
        riff, extent, wave, fmt, fmt_size, encoding, channels, rate, byte_rate, align, bits, data, data_size = struct.unpack("<4sI4s4sIHHIIHH4sI", header)
        if (riff, wave, fmt, fmt_size, encoding, channels, rate, byte_rate, align, bits, data) != (b"RIFF", b"WAVE", b"fmt ", 16, 1, 1, 22050, 44100, 2, 16, b"data"):
            raise ValueError("unexpected PCM format")
        if extent != size - 8 or data_size != size - 44 or data_size % 2:
            raise ValueError("WAV extent or frame boundary differs")
        payload = stream.read()
    return payload, data_size // 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", type=pathlib.Path, required=True)
    args = parser.parse_args()
    case = args.case.resolve()
    audio = case / "results/audio"
    attempts = [read_json(case / f"attempt-{n:02}.json") for n in (1, 2, 3)]
    expected_counts = [(7, 0, False), (13, 7, True), (0, 20, True)]
    observed = [(x["generatedSegments"], x["reusedSegments"], x["chapterReady"]) for x in attempts]
    if observed != expected_counts:
        raise ValueError("three-pass cache counts differ")
    recipe_shas = {x["recipeSha256"] for x in attempts}
    recipe_receipt = read_json(audio / "recipe.json")
    recipe = recipe_receipt["recipe"]
    canonical_recipe = json.dumps(recipe, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    if (len(recipe_shas) != 1 or recipe_receipt["recipeSha256"] != next(iter(recipe_shas))
        or hashlib.sha256(canonical_recipe).hexdigest() != next(iter(recipe_shas))):
        raise ValueError("recipe identity changed across attempts")
    if attempts[2]["modelLoadSeconds"] != 0 or attempts[2]["runtime"] is not None:
        raise ValueError("cached replay initialized an engine")
    source = pathlib.Path(__file__).resolve().parent
    if sha(source / "soak-corpus.json") != recipe["sourceSha256"] or sha(source / "soak-corpus.lock.json") != recipe["sourceReferenceSha256"]:
        raise ValueError("frozen source/reference changed")
    if any(sha(source / name) != digest for name, digest in recipe["driverSha256"].items()):
        raise ValueError("inference driver changed since recipe freeze")
    first_seven = attempts[0]["committedSegments"]
    second = attempts[1]["chapter"]
    third = attempts[2]["chapter"]
    if second != third:
        raise ValueError("final chapter receipt changed on replay")
    if first_seven != [{"id": x["id"], "sha256": x["sha256"]} for x in second["segments"][:7]]:
        raise ValueError("pause/resume prefix changed")
    ordered = hashlib.sha256()
    total_frames = 0
    ids = []
    for item, binding in zip(second["segments"], recipe["paragraphs"], strict=True):
        if item["id"] != binding["id"]:
            raise ValueError("source/segment order differs")
        path = audio / "segments" / (item["id"] + ".wav")
        payload, frames = pcm(path)
        checkpoint = read_json(audio / "checkpoints" / (item["id"] + ".json"))
        if sha(path) != item["sha256"] or checkpoint["pcm"]["sha256"] != item["sha256"]:
            raise ValueError("segment file hash differs")
        if frames != item["frames"] or checkpoint["textSha256"] != binding["textSha256"]:
            raise ValueError("segment frame/text identity differs")
        ordered.update(payload)
        total_frames += frames
        ids.append(item["id"])
    chapter = audio / "chapter.wav"
    chapter_payload, chapter_frames = pcm(chapter)
    chapter_payload_sha = hashlib.sha256(chapter_payload).hexdigest()
    if (chapter_frames != total_frames or chapter_frames != second["pcm"]["frames"]
        or ordered.hexdigest() != chapter_payload_sha or chapter_payload_sha != second["orderedPayloadSha256"]
        or sha(chapter) != second["pcm"]["sha256"]):
        raise ValueError("actual chapter differs from exact ordered source PCM")
    telemetry = [read_json(case / f"telemetry-{n:02}/telemetry-summary.json") for n in (1, 2, 3)]
    if not all(x["cleanupVerified"] and x["exitCode"] == 0 and x["abort"] is None for x in telemetry):
        raise ValueError("an attempt did not complete with verified container cleanup")
    proof = {
        "schemaVersion": 1, "status": "verified-three-pass-generated-pcm",
        "recipeSha256": next(iter(recipe_shas)), "sourceSha256": recipe["sourceSha256"],
        "passes": [{"generated": x[0], "reused": x[1], "chapterReady": x[2]} for x in observed],
        "firstSevenHashesPreserved": True, "cachedReplayModelLoadSeconds": 0,
        "orderedSegmentIds": ids, "exactOrderedPcmPayloadSha256": chapter_payload_sha,
        "chapterWavSha256": sha(chapter), "chapterBytes": chapter.stat().st_size,
        "sumSegmentFrames": total_frames, "chapterFrames": chapter_frames,
        "audioSeconds": chapter_frames / 22050, "allContainerCleanupVerified": True,
        "auditoryReview": "NOT_LISTENED", "spokenWordCompleteness": "NOT_MEASURED",
        "powerLossDurability": "NOT_ESTABLISHED", "productionAcceptance": False,
    }
    (case / "independent-proof.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(proof, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
