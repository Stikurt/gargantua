"""Read-only manual semantic review of the longer OPUS diagnostic fixture."""
import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CASE = ROOT / ".local/s5-pilot/opus-sentence-chapter-01"
RESULT = CASE / "results/translation.json"
SOURCE = ROOT / "experiments/s5/chapter-inputs.json"
REFERENCE = ROOT / "experiments/s5/chapter-reference.private.json"
EXPECTED_RESULT = "53dc791481d8b4100ea97feb177fc7d90b5840e8fd722f93a5e2d7d3f8af5ffe"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


ROWS = [
    {"id": "chapter-bridge-1", "materialFindings": [
        {"source": "A red line crossed the entry for the evening ferry", "output": "Красная линия пересекла вход на вечерний паром", "error": "Register entry becomes a physical entrance, changing the location and function of the red line."},
        {"source": "last passenger had left the landing", "output": "последний пассажир не покинет посадку", "error": "The landing/pier is rendered as boarding, making the place-based clearance condition unclear. Raised/until polarity itself is retained."}],
     "minorFindings": ["Harbour office shortened to harbour; coat soaked-through wording becomes rain pouring through shoulders.", "Tide Ledger transliteration can be a valid name strategy without applied glossary, but this name must stay a register and remain consistent across paragraphs."],
     "preservedFacts": ["Bridge remains raised until clearance; no raised/lowered reversal", "Clerk reports seven, Nora sees six, including younger brother", "Register is open under a stone despite closed window"]},
    {"id": "chapter-bridge-2", "materialFindings": [
        {"source": "Those notes might have been the wind", "output": "Эти записи, возможно, были ветром", "error": "Bell notes become written records/recordings instead of sounds; the wind-versus-signal inference is semantically corrupted."},
        {"source": "Evin reached for the signal rope. Nora caught his wrist before he could pull it", "output": "Эвин дотянулся до сигнальной веревки. Нора поймал его запястье до того, как он смог его вытащить", "error": "Pulling a signal rope becomes taking/pulling something out with an unclear masculine/neuter pronoun, which may refer to the wrist. The intended stopped-before-signaling action is no longer reliably rendered."}],
     "minorFindings": ["Evin first has feminine остановилась despite source he and later masculine verbs; Nora then receives masculine поймал.", "Carrying scarf becomes носил, potentially suggesting wearing; folded-parcel context partially disambiguates it."],
     "preservedFacts": ["Woman's red folded scarf, dry request and return for something", "Two faint bell notes and fog-covered lower deck", "Notes are explicitly not permission to leave; no invented actual completed bell pull is asserted by this review"]},
    {"id": "chapter-bridge-3", "materialFindings": [
        {"source": "sent him to the tower with the Tide Ledger", "output": "отправила его в башню с лифтом", "error": "The named harbour register becomes a lift/elevator, adding a different physical object and breaking document continuity."},
        {"source": "Beneath the ferry's awning", "output": "Под паромомом", "error": "Under the awning becomes under the ferry itself, with corrupted word form. This changes the old woman's location."},
        {"source": "Nothing moved inside it", "output": "Ничего не двигалось внутрь", "error": "Nothing moving inside the box becomes nothing moving inward; the deliberately empty-box clue changes."}],
     "minorFindings": ["Unnatural translations around rain masking hearing, but the reason for return remains understandable."],
     "preservedFacts": ["Nora descends alone", "Breath comes from behind the box and child sleeps between two net bundles", "Woman did not return for luggage; she returned because rain masked her grandson's sounds", "No sleeping/dead or grandson/granddaughter reversal"]},
    {"id": "chapter-bridge-4", "materialFindings": [
        {"source": "sleeping boy had been hidden against his grandmother", "output": "спящий мальчик был спрятан против своей бабушки", "error": "Body proximity/occlusion explaining the missed child becomes an incoherent against/opposed-to relation; correct numeral eight does not restore the explanation."},
        {"source": "Nora shook her head", "output": "Нора пожала ей голову", "error": "Nora's own head-shaking action is replaced by an incoherent action on her head/another person's head."},
        {"source": "leaving the mistaken entry legible beneath a single line", "output": "оставляя неправильный вход под одной линией", "error": "Written entry again becomes entrance and legible is omitted, losing the non-destructive correction detail."},
        {"source": "nobody was still waiting on the landing", "output": "никто до сих пор не ждал приземления", "error": "Nobody left waiting at the pier becomes nobody waiting for a landing event, changing the final clearance location/condition."}],
     "minorFindings": ["Tide Ledger name form changes again (Тейд Лиджер); this profile explicitly did not apply the approved glossary, so it is not falsely accused of failing a supported glossary feature."],
     "preservedFacts": ["Evin wraps child's shoulders with scarf", "True total always eight; earlier seven not silently rewritten", "Correct number first, then lower bridge; order is preserved", "Ferry lamp vanishes in fog and rain stops"]},
]


def main():
    if sha(RESULT) != EXPECTED_RESULT:
        raise ValueError("Frozen reviewed result changed")
    result = json.loads(RESULT.read_text(encoding="utf-8"))
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))
    if result["status"] != "completed" or result["corpusSha256"] != sha(SOURCE):
        raise ValueError("Result/source completion identity mismatch")
    source_rows = {r["id"]: r for r in source["samples"][0]["segments"]}
    output_rows = {r["id"]: r for r in result["segments"]}
    fact_rows = {r["id"]: r for r in reference["samples"][0]["segments"]}
    if set(source_rows) != {r["id"] for r in ROWS} or set(output_rows) != set(source_rows):
        raise ValueError("Expected the complete four-paragraph fixture")
    for row in ROWS:
        identifier = row["id"]
        row.update({"status": "MATERIAL_MEANING_ERRORS", "sourceTextSha256": hashlib.sha256(source_rows[identifier]["text"].encode()).hexdigest(), "outputTextSha256": hashlib.sha256(output_rows[identifier]["text"].encode()).hexdigest(), "assistantFactChecklistRead": bool(fact_rows[identifier]["facts"]), "wholeSentenceTailOmissionObserved": False})
    report = {"schemaVersion": 1, "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "status": "ADVISORY_ASSISTANT_SEMANTIC_REVIEW_NOT_PRODUCTION_ACCEPTANCE", "humanEvaluation": False, "blindEvaluation": False,
        "resultSha256": EXPECTED_RESULT, "sourceSha256": sha(SOURCE), "referenceSha256": sha(REFERENCE), "source": str(SOURCE.relative_to(ROOT)),
        "referenceUse": "Assistant-authored example/fact checklist read only for review, never inference. Source facts override any over-specific reference interpretation.",
        "variant": result["variant"], "scope": "Four successive original English paragraphs,29 manually reviewed sentence intervals. SourceContext/glossary disabled as explicitly declared by this OPUS diagnostic; this is not a supported-context/glossary test.",
        "rows": ROWS, "summary": {"reviewedParagraphs": 4, "paragraphsWithMaterialErrors": [r["id"] for r in ROWS], "wholeSentenceTailOmissionsObserved": [], "criticalRaisedLoweredOrSevenSixEightReversalsObserved": [], "sourceIntervalCoverage": "29/29 technical calls completed; all whole source sentences have a corresponding output, but clauses and meanings can still be wrong."},
        "observedPerformance": result["summary"],
        "conclusion": "Sentence-wise coverage solves the earlier missing-tail symptom but not document word sense, entity consistency, anaphora or idioms. This continuous scene exposes register→elevator, entry→entrance and awning→under-ferry substitutions despite preserved passenger counts and condition polarity. Keep OPUS as an optional low-resource EN draft candidate, not autonomous final prose/audio input until further quality handling is proven.",
        "automaticPublicationApproved": False, "semanticNumericGrade": None, "antivirusClearanceClaimed": False}
    destination = CASE / "assistant-review.json"
    if destination.exists():
        raise ValueError("Review already exists; preserve evidence")
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"path": str(destination), "reviewedParagraphs": 4, "paragraphsWithMaterialErrors": 4, "automaticAcceptance": False}))


if __name__ == "__main__":
    main()
