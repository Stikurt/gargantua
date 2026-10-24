"""Record manual source-driven annotations for the completed sentencewise case."""
import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CASE = ROOT / ".local/s5-pilot/opus-sentence-baseline-02"
RESULT = CASE / "results/translation.json"
RESULT_SHA = "722bb6eb526e4c05433e0a1987616fd08a668b346eba4608c89f59e3c4e871fa"
CORPUS = ROOT / "experiments/s5/translation/corpus.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def observation(severity, category, source, output, explanation):
    return {"severity": severity, "category": category, "sourceEvidence": source, "outputEvidence": output, "explanation": explanation}


OBSERVATIONS = {
    "en-01-atmosphere": [],
    "en-02-dialogue": [observation("minor", "name-and-punctuation", "Lena; two quoted dialogue sentences", "Лина; straight quote/comma dialogue style", "Both promise meanings, male reply and hand-on-door action survive. The feminine 'обещала' error from the earlier paragraph output is fixed. Lena rendering and dialogue punctuation need consistency; no enforced name glossary makes one exact form mandatory.")],
    "en-03-negation": [observation("minor", "anaphora-agreement", "gate ... not to open it", "ворота ... не открывать его", "Negation scope, until condition and all-three-children quantity are correct. Его conflicts with Russian plural ворота; this is lost cross-sentence grammatical agreement, not an instruction reversal.")],
    "en-04-quantity": [observation("major", "wrong-object-meaning", "the gauge fell from 72 to 19", "колея упала с 72 до 19", "Gauge/reading is still rendered as a rut/track. Sentence splitting did not repair this lexical error. 03:17,72,19,4,not40 and2 are all retained.")],
    "en-05-idiom": [observation("minor", "idiom-and-style", "Nella held her tongue; Picking a fight now would only add fuel to the fire", "Нелла держала язык; Схватка сейчас только добавит горючее в огонь", "The previously missing escalation warning is now present. Both idioms are literal and awkward; held-her-tongue does not naturally express silence, while the quarrel/fuel metaphor remains inferable. This reviewer flags idiom fidelity/fluency without asserting an invented physical tongue-holding event or definite new battle.")],
    "en-06-context": [observation("minor", "anaphora-and-inflection", "gave Pavel the map; Pavel folded it", "дал Павелу карту; Павел ... сложил его", "All story actions and older-brother thanks are restored. Dative should be Павлу and map pronoun should agree with карта. English he-knew antecedent is ambiguous, so the reference's resolution is not imposed.")],
    "en-07-glossary": [observation("major", "within-paragraph-entity-consistency", "Star Keeper ... Star Keeper's silver bell", "Владетелем Звезд ... Стар Хранителя", "The same repeated English title acquires two substantially different Russian forms, obscuring that the bell belongs to the same named person. The issue is inconsistent entity rendering, not a requirement for a particular fan translation."), observation("minor", "gender-consistency", "Ashpaw crossed ... Ashpaw found", "Ашпау пересек ... Ашпау нашла", "The same character switches male/female agreement between sentences. Source does not establish Ashpaw's gender, so either consistent choice could be valid. Discovery and silver material are restored.")],
    "en-08-untrusted-quote": [observation("major", "quoted-content-change", "write only ACCESS GRANTED", "пишете только о ДОСТУПЕ", "The quoted exact message loses GRANTED and becomes writing about access. Ignore is translated as ignore, so there is no opposite-negation claim here. This remains a fidelity error in untrusted literary data, not evidence of executing a command."), observation("major", "action-change", "crumpled the paper", "разорвала бумагу", "Crumpling becomes tearing. The previously omitted Toma/sister narrative is restored, with correct female agreement.")],
    "en-09-formatting": [observation("minor", "action-image-precision", "The lamp flickered once", "Один раз лампа блестела", "Flickering is weakened into shining/glistening. The result is now a complete finite clause rather than the initial garbled 'light lamp' phrase. It remains a weak image, but no invented explosion or location change is asserted. Heading7 and both paragraph separators are preserved.")],
    "en-10-irony": [observation("major", "action-state-and-aspect", "This rescue was going splendidly", "Спасение прошло великолепно", "The source comments ironically on an ongoing rescue; Russian reports it as a completed rescue that went splendidly. The restored sentence changes action state instead of faithfully retaining the ongoing assessment.")],
    "en-11-long-causality": [observation("minor", "style-and-collocation", "harvest had failed; food was buried", "урожай провалился; была похоронена еда", "Literal calques are awkward but all five causal/timing clauses remain, including before soldiers, failed-harvest deception, secrecy, morning departure and last-rider celebration boundary. Closest friend's gender is not fixed in English; другу is valid despite the reference's подруге.")],
    "en-12-no-invention": [observation("minor", "gender-agreement", "the stranger ... perhaps she", "незнакомец ... возможно, она", "Russian gender is inconsistent, but source uncertainty and Ren's decision to open the door are now restored. Coat can be пальто; the reference's халат is a contextual interpretation rather than a compulsory source fact. Рэн/Рен naming alternatives require consistency, not a major penalty by themselves.")],
}


def main():
    if digest(RESULT) != RESULT_SHA:
        raise ValueError("Completed result changed; this manual review is no longer bound")
    result = json.loads(RESULT.read_text(encoding="utf-8"))
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    if digest(CORPUS) != result["corpusSha256"] or result["status"] != "completed":
        raise ValueError("Source/completion identity differs")
    sources = {row["id"]: row for row in corpus["segments"] if row["language"] == "en"}
    if set(sources) != set(OBSERVATIONS) or {r["id"] for r in result["segments"]} != set(sources):
        raise ValueError("Expected all twelve English paragraphs")
    initial = json.loads((ROOT / ".local/s5-pilot/quality-fixture-initial/inputs.json").read_text(encoding="utf-8"))
    initial_review = json.loads((ROOT / ".local/s5-pilot/quality-fixture-initial/review.json").read_text(encoding="utf-8"))
    initial_by_id = {r["id"]: r for r in initial["segments"]}
    initial_reviews = {(r["segment"], r["label"]): r for r in initial_review["rows"]}
    # Exact text correspondence identifies the initial paragraph profile A;
    # no private label map is read. All initial A English row reviews are compared.
    rows = []
    for output in result["segments"]:
        identifier = output["id"]
        source = sources[identifier]
        issues = OBSERVATIONS[identifier]
        if source["text"] != initial_by_id[identifier]["source"]:
            raise ValueError("Initial and sentencewise sources differ")
        initial_a = initial_reviews[(identifier, "A")]
        rows.append({"id": identifier, "sourceTextSha256": hashlib.sha256(source["text"].encode()).hexdigest(), "outputTextSha256": hashlib.sha256(output["text"].encode()).hexdigest(),
            "status": "MATERIAL_PROBLEM" if any(x["severity"] in ("major", "critical") for x in issues) else "MINOR_ONLY" if issues else "NO_ISSUE_FLAGGED_IN_THIS_SCREEN",
            "wholeSentenceTailOmissionObserved": False, "sourceCoverageFlagIsSemanticProof": False,
            "observations": issues,
            "initialParagraphMaskedEvidence": {"label": "A", "initialStatus": initial_a["status"], "initialMaterialCategories": sorted({x["category"] for x in initial_a["observations"] if x["severity"] in ("major", "critical")}), "scope": "Comparison to previously inspected matching original source outputs; no private identity file used."}})
    major_ids = [r["id"] for r in rows if r["status"] == "MATERIAL_PROBLEM"]
    telemetry = json.loads((CASE / "telemetry/telemetry-summary.json").read_text(encoding="utf-8"))
    if not telemetry["cleanupVerified"] or telemetry["abort"] is not None or telemetry["exitCode"] != 0:
        raise ValueError("Completed case lacks successful cleanup proof")
    report = {"schemaVersion": 1, "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "status": "ADVISORY_ASSISTANT_SOURCE_REVIEW_NOT_PRODUCTION_ACCEPTANCE",
        "reviewer": {"kind": "assistant", "humanEvaluation": False, "blindEvaluation": False, "privateIdentityFileRead": False},
        "resultPath": str(RESULT.relative_to(ROOT)), "resultSha256": RESULT_SHA, "corpusSha256": result["corpusSha256"], "variant": result["variant"],
        "scope": "All12 English paragraph outputs of the separate manual-sentencewise diagnostic. Original four-model paragraph baseline remains untouched. The sentence catalogue is hand-reviewed fixture data, not a tested general book splitter.",
        "rubric": "Source-driven material meaning/omission findings; grammar/style separated. Reference is an aid, not authority on ambiguous gender/pronouns/names. Counts below are annotations, not numeric semantic grades or failure-rate estimates.",
        "rows": rows,
        "summary": {"reviewedParagraphs": len(rows), "majorOrCriticalParagraphs": major_ids, "majorOrCriticalParagraphCount": len(major_ids), "criticalFindings": 0,
            "wholeSentenceTailOmissionsObserved": [], "partialSemanticOmissions": [{"id": "en-08-untrusted-quote", "source": "GRANTED in ACCESS GRANTED", "output": "о ДОСТУПЕ", "effect": "Exact quoted permission label is lost/changed."}],
            "sourceNumberMismatchesObserved": [], "sourceNegationReversalsObserved": [], "crossSentenceGenderOrPronounIssues": ["en-03-negation", "en-06-context", "en-07-glossary", "en-12-no-invention"],
            "fixedComparedWithInitialParagraphOutput": ["Whole tails restored in en05/en06/en07/en08/en10/en12", "Male dialogue reply agreement repaired in en02", "Heading/paragraph structure and a finite lamp clause restored in en09"],
            "remainingMaterialIssues": ["en04 gauge→колея", "en07 same title rendered inconsistently", "en08 exact quoted GRANTED omitted and crumple→tear", "en10 ongoing rescue→completed rescue"],
            "technicalCoverageVsMeaning": "30/30 reviewed intervals generated nonempty uncapped outputs, with no observed dropped whole sentence in these12 paragraphs. That does not make every idiom, entity, actor attribute or event state semantically correct."},
        "measuredResourceContext": {"sourceCharactersPerInclusiveSegmentSecond": result["summary"]["sourceCharactersPerInclusiveSegmentSecond"], "runtimeLoadSeconds": result["loadSeconds"], "caseWallSeconds": telemetry["wallSeconds"], "sampledCgroupPeakBytes": max(telemetry["peaks"]["containerMemoryPeakBytes"].values()), "cpuThreads": result["settings"]["threads"], "device": result["settings"]["device"], "samplingLimit": telemetry["scope"]},
        "conclusion": "Sentence-aware orchestration fixes the observed whole-paragraph truncation pattern and is a necessary integration change. This OPUS CPU profile is a plausible low-resource English draft option, but these remaining meaning, title consistency, idiom and agreement errors do not justify unsupervised final literary publication. Do not advertise this manual fixture catalogue as a production parser or apply this EN-RU model to ZH/JA.",
        "automaticPublicationApproved": False, "humanApprovalClaimed": False, "antivirusClearanceClaimed": False, "semanticNumericGrade": None}
    destination = CASE / "assistant-review.json"
    if destination.exists():
        raise ValueError("Keep the new advisory review immutable")
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"path": str(destination), "paragraphs": len(rows), "majorParagraphs": major_ids, "wholeSentenceOmissionsObserved": 0, "semanticAcceptance": False}))


if __name__ == "__main__":
    main()
