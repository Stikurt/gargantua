"""Reviewed fixture-only boundaries; deliberately NOT a production splitter.

No regex sentence guessing, reference loading, model inference, or source edits.
Freeze after initial baseline diagnosis and before sentencewise variant inference.
"""
import datetime
import hashlib
import json
from pathlib import Path

def workspace_root():
    """Only the deliberate host catalogue generator needs repository layout.

    Validation/inference imports also run at /pilot/translation in a sandbox.
    Never resolve a host repository ancestor while importing those helpers.
    """
    path = Path(__file__).resolve()
    if len(path.parents) < 4:
        raise ValueError("Catalogue generation requires the original repository layout")
    return path.parents[3]

# Exclusive end markers, reviewed from ORIGINAL EN sources, not translated output.
# Every remaining final non-whitespace source interval is also a translation unit.
CUT_AFTER = {
    "en-01-atmosphere": ["cold iron."],
    "en-02-dialogue": ["Lena said."],
    "en-03-negation": ["open the gate."],
    "en-04-quantity": ["72 to 19."],
    "en-05-idiom": ["held her tongue."],
    "en-06-context": ["the mountain paths."],
    "en-07-glossary": ["with the Star Keeper."],
    "en-08-untrusted-quote": ['ACCESS GRANTED."'],
    "en-09-formatting": ["The Last Light", "flickered once."],
    "en-10-irony": ["thought Ada.", "a flooded cellar."],
    "en-11-long-causality": ["soldiers arrived.", "harvest had failed.", "her closest friend.", "the patrol had left."],
    "en-12-no-invention": ["stolen the coat.", "could not tell."],
    "chapter-bridge-1": ["of her coat.", "beside it was shut.", "the evening ferry.", "left the landing.", "to the clerk."],
    "chapter-bridge-2": ["called his name.", "for a parcel.", "dry,' he said.", "back for something.'", "its lower deck.", "of a bell.", "the signal rope.", "could pull it."],
    "chapter-bridge-3": ["steps alone.", "a wooden box.", "inside it.", "behind the box.", "of fishing nets.", "for her luggage."],
    "chapter-bridge-4": ["the child's shoulders.", "counted the passengers.", "eight of them.", "shook her head.", "lower the bridge.'", "a single line."],
}


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def validate_intervals(source, intervals):
    if not isinstance(source, str) or not source or len(source) > 8000:
        raise ValueError("Invalid source text")
    raw = source.encode("utf-8")
    if not isinstance(intervals, list) or not 1 <= len(intervals) <= 100:
        raise ValueError("Invalid interval count")
    position = 0
    for interval in intervals:
        if set(interval) != {"startByte", "endByte", "kind"}:
            raise ValueError("Unknown interval field; references and arbitrary metadata are not accepted")
        start, end = interval["startByte"], interval["endByte"]
        if type(start) is not int or type(end) is not int or start != position or not 0 <= start < end <= len(raw):
            raise ValueError("Intervals must cover source bytes in exact non-overlapping order")
        try:
            text = raw[start:end].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("Interval splits a UTF8 code point") from exc
        if interval["kind"] == "whitespace":
            if not text.isspace():
                raise ValueError("Whitespace span contains source content")
        elif interval["kind"] == "translate":
            if not text or text != text.strip():
                raise ValueError("Translation unit must not absorb surrounding whitespace")
        else:
            raise ValueError("Unknown interval kind")
        position = end
    if position != len(raw) or not any(row["kind"] == "translate" for row in intervals):
        raise ValueError("Uncovered source suffix or no translation units")
    return raw


def reviewed_intervals(source, cut_after):
    boundaries, position = [], 0
    for marker in cut_after:
        if not isinstance(marker, str) or not marker:
            raise ValueError("Invalid reviewed boundary marker")
        found = source.find(marker, position)
        if found < 0 or source.find(marker, found+1) >= 0:
            raise ValueError("Reviewed marker missing or ambiguous: " + marker)
        position = found+len(marker)
        boundaries.append(position)
    boundaries.append(len(source))
    char_start, intervals = 0, []
    for char_end in boundaries:
        chunk = source[char_start:char_end]
        if not chunk:
            raise ValueError("Empty reviewed interval")
        left = len(chunk)-len(chunk.lstrip())
        right = len(chunk.rstrip())
        pieces = [(0, left, "whitespace"), (left, right, "translate"), (right, len(chunk), "whitespace")]
        for start, end, kind in pieces:
            if end <= start:
                continue
            row = {"startByte": len(source[:char_start+start].encode("utf-8")), "endByte": len(source[:char_start+end].encode("utf-8")), "kind": kind}
            if intervals and kind == "whitespace" and intervals[-1]["kind"] == kind:
                intervals[-1]["endByte"] = row["endByte"]
            else:
                intervals.append(row)
        char_start = char_end
    validate_intervals(source, intervals)
    return intervals


def source_segments(corpus):
    if "segments" in corpus:
        return [{"id": row["id"], "language": row["language"], "text": row["text"]} for row in corpus["segments"]]
    return [{"id": row["id"], "language": corpus["sourceLanguage"], "text": row["text"]} for sample in corpus["samples"] for row in sample["segments"]]


def build_catalog():
    root = workspace_root()
    corpora, segments = [], []
    seen = set()
    for relative in ("experiments/s5/translation/corpus.json", "experiments/s5/chapter-inputs.json"):
        raw = (root / relative).read_bytes()
        data = json.loads(raw)
        corpora.append({"path": relative, "sha256": digest_bytes(raw)})
        for row in source_segments(data):
            if row["language"] != "en":
                continue
            if row["id"] in seen or row["id"] not in CUT_AFTER:
                raise ValueError("Duplicate or unreviewed English segment")
            seen.add(row["id"])
            intervals = reviewed_intervals(row["text"], CUT_AFTER[row["id"]])
            segments.append({"corpusPath": relative, "id": row["id"], "language": "en", "sourceBytes": len(row["text"].encode("utf-8")), "sourceSha256": digest_bytes(row["text"].encode("utf-8")), "intervals": intervals})
    if seen != set(CUT_AFTER):
        raise ValueError("Unused reviewed boundary specs")
    return {"schemaVersion": 1, "variant": "opus-manual-sentencewise-diagnostic-v1", "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "freezeProvenance": "Original source-only manually reviewed boundaries frozen after observing paragraph-baseline omissions and before any sentencewise diagnostic inference. No wording or source text changed to tune translations.", "productionReadySplitter": False, "contextPolicy": "Independent ordered translation units. Quoted pronoun/name continuity may degrade; this is measured separately, not concealed.", "corpora": corpora, "segments": segments, "translationUnits": sum(sum(i["kind"] == "translate" for i in row["intervals"]) for row in segments)}


if __name__ == "__main__":
    destination = Path(__file__).with_name("sentence-catalog.lock.json")
    if destination.exists():
        raise ValueError("Frozen catalogue cannot be overwritten")
    catalogue = build_catalog()
    destination.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({"segments": len(catalogue["segments"]), "translationUnits": catalogue["translationUnits"], "sha256": digest_bytes(destination.read_bytes())}))
