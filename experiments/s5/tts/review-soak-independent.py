"""Second-reviewer read-only audit of the frozen synthetic long-audio pilot.

No TTS/model imports, inference, waveform listening, DB or production mutation.
"""
import datetime
import hashlib
import json
from pathlib import Path
import wave

ROOT = Path(__file__).resolve().parents[3]
CASE = ROOT / ".local/s5-pilot/tts-soak-denis-01"
AUDIO = CASE / "results/audio"


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path):
    if path.is_symlink() or path.stat().st_size > 512 * 1024:
        raise ValueError("Unexpected review input")
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    source_path = ROOT / "experiments/s5/tts/soak-corpus.json"
    source = read(source_path)
    recipe_document = read(AUDIO / "recipe.json")
    recipe = recipe_document["recipe"]
    recipe_sha = hashlib.sha256(json.dumps(recipe, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if recipe_document["recipeSha256"] != recipe_sha or recipe["sourceSha256"] != sha(source_path):
        raise ValueError("Recipe/source mismatch")
    order = [{"id": p["id"], "textSha256": hashlib.sha256(p["text"].encode()).hexdigest(), "characters": len(p["text"])} for p in source["paragraphs"]]
    if recipe["paragraphs"] != order or len(order) != 20:
        raise ValueError("Frozen source/order mismatch")
    payload_digest = hashlib.sha256()
    total_frames = 0
    actual_segments = []
    for row in order:
        audio = AUDIO / "segments" / (row["id"] + ".wav")
        checkpoint = read(AUDIO / "checkpoints" / (row["id"] + ".json"))
        if checkpoint["recipeSha256"] != recipe_sha or checkpoint["id"] != row["id"] or checkpoint["textSha256"] != row["textSha256"]:
            raise ValueError("Source/checkpoint identity mismatch")
        if audio.is_symlink() or audio.stat().st_size != checkpoint["pcm"]["bytes"] or sha(audio) != checkpoint["pcm"]["sha256"]:
            raise ValueError("Segment byte identity mismatch")
        with wave.open(str(audio), "rb") as reader:
            if (reader.getnchannels(), reader.getsampwidth(), reader.getframerate(), reader.getcomptype()) != (1, 2, 22050, "NONE"):
                raise ValueError("Unexpected PCM format")
            frames = reader.getnframes()
            if frames != checkpoint["pcm"]["frames"]:
                raise ValueError("PCM frame mismatch")
            total_frames += frames
            while block := reader.readframes(524288):
                payload_digest.update(block)
        actual_segments.append({"id": row["id"], "sha256": checkpoint["pcm"]["sha256"], "frames": frames})
    chapter = AUDIO / "chapter.wav"
    chapter_checkpoint = read(AUDIO / "chapter.json")
    if chapter_checkpoint["recipeSha256"] != recipe_sha or chapter_checkpoint["segments"] != actual_segments:
        raise ValueError("Chapter/source order differs")
    if sha(chapter) != chapter_checkpoint["pcm"]["sha256"]:
        raise ValueError("Chapter hash mismatch")
    chapter_payload = hashlib.sha256()
    with wave.open(str(chapter), "rb") as reader:
        if (reader.getnchannels(), reader.getsampwidth(), reader.getframerate(), reader.getcomptype(), reader.getnframes()) != (1, 2, 22050, "NONE", total_frames):
            raise ValueError("Final chapter parameters differ")
        while block := reader.readframes(524288):
            chapter_payload.update(block)
    if chapter_payload.digest() != payload_digest.digest() or chapter_payload.hexdigest() != chapter_checkpoint["orderedPayloadSha256"]:
        raise ValueError("Final body differs from exact ordered source segment bodies")
    attempts = [read(CASE / f"attempt-{n:02}.json") for n in (1, 2, 3)]
    if [(x["generatedSegments"], x["reusedSegments"], x["chapterReady"]) for x in attempts] != [(7, 0, False), (13, 7, True), (0, 20, True)]:
        raise ValueError("Three-pass pause/resume/reuse sequence differs")
    if attempts[0]["committedSegments"] != [{"id": row["id"], "sha256": row["sha256"]} for row in actual_segments[:7]]:
        raise ValueError("First seven immutable artifacts changed during resume")
    if attempts[2]["modelLoadSeconds"] != 0 or attempts[2]["runtime"] is not None:
        raise ValueError("All-cache replay unexpectedly initialized a model")
    telemetry = [read(CASE / f"telemetry-{n:02}/telemetry-summary.json") for n in (1, 2, 3)]
    if not all(t["cleanupVerified"] and t["abort"] is None and t["exitCode"] == 0 for t in telemetry):
        raise ValueError("Failed run or unverified owned container cleanup")
    report = {"schemaVersion": 1, "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "reviewer": "separate safety-contract assistant", "status": "READ_ONLY_SECOND_REVIEW_MATCHES_FROZEN_SOURCE_AND_ACTUAL_PCM",
        "recipeSha256": recipe_sha, "sourceSha256": sha(source_path), "sourceParagraphs": len(order), "sourceWordsClaim": "Original assistant-authored synthetic chapter, not a published book",
        "segmentsIndependentlyReadAndHashed": len(actual_segments), "firstSevenUnchangedFromPause": True, "exactSourceOrderAndFrameBodiesMatch": True,
        "frames": total_frames, "audioSeconds": total_frames / 22050, "chapterSha256": sha(chapter), "payloadSha256": chapter_payload.hexdigest(),
        "allCacheReplayModelLoadSeconds": 0, "threeSuccessfulCleanupProofsChecked": True,
        "unitEvidence": {"independentHostFixtures": "16/16 Windows fixtures passed with workspace TEMP, before test-only final negative fixture was added", "finalLinuxFixtures": "17/17 agent execution report; stronger forged chapter+receipt test added", "actualBindFlockProbe": read(ROOT / ".local/s5-pilot/tts-flock-probe/report.json")},
        "limits": {"heardOrListened": False, "spokenWordAlignmentMeasured": False, "humanNaturalnessRating": None, "powerLossDurabilityEstablished": False, "productionAuthorizationOrJobPipelineTested": False, "productionAcceptance": False},
        "conclusion": "This one-chapter experiment supports resumable artifact integrity and exact PCM ordering under controlled process pauses. It does not establish audible completeness/prosody, long-duration server endurance, OS crash recovery or automatic audiobook publication quality."}
    destination = CASE / "second-review.json"
    if destination.exists():
        raise ValueError("Keep this independent review immutable")
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"path": str(destination), "status": report["status"], "segments": len(actual_segments), "frames": total_frames, "audioSeconds": report["audioSeconds"]}))


if __name__ == "__main__":
    main()
