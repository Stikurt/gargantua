"""Second read-only audit of actual QA recovery; no model/harness imports."""
import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CASE = ROOT / ".local/s5-pilot/qwen35-gpu-qa-chapter"
ORIGINAL_CASE_SHA = "8fa44f7227392a0f4e87cefdc2e60d9cc4016ed304219c6a66f4279732fa9141"
INTERRUPTED_SHA = "2f7b22b8b3facbac357167b0d4ba97d432471f7e30ae6133baa61dcda8388ea6"


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def read(path):
    if path.is_symlink() or path.stat().st_size > 16 * 1024 ** 2:
        raise ValueError("Unexpected review input")
    return json.loads(path.read_text(encoding="utf-8"))


def require(test, message):
    if not test:
        raise ValueError(message)


def main():
    original, previous, current, receipt = [read(CASE / name) for name in ("case.json", "interrupted-result.json", "results/result.json", "recovery.json")]
    require(sha(CASE / "case.json") == ORIGINAL_CASE_SHA and original["status"] == "failed", "Original failed case was changed")
    require(sha(CASE / "interrupted-result.json") == INTERRUPTED_SHA and previous["status"] == "failed", "Interrupted snapshot was changed")
    require(receipt["status"] == "completed" and receipt["resourceAcceptance"] is True, "Recovery is not accepted technically")
    require(receipt["sourceCaseUnchanged"] is True and receipt["snapshotUnchanged"] is True, "Recovery lacks preserved evidence flags")
    require(sha(CASE / "results/result.json") == receipt["resultSha256"], "Final hash differs from recovery receipt")
    for checkpoint in (previous, current):
        require(checkpoint["checkpointSha256"] == canonical({k: v for k, v in checkpoint.items() if k != "checkpointSha256"}), "Checkpoint body checksum mismatch")
        require(checkpoint["identitySha256"] == canonical(checkpoint["identity"]), "Checkpoint identity checksum mismatch")
    require(current["status"] == "completed" and current["identity"] == previous["identity"], "Recipe/runtime identity differs")
    require(len(previous["segments"]) == 4 and len(current["segments"]) == 8 and current["segments"][:4] == previous["segments"], "Committed prefix differs")
    require(current["pendingDraft"] is None, "Unfinished draft remains")
    pending = previous["pendingDraft"]
    require(current["segments"][4]["draft"] == pending["result"] and current["segments"][4]["draftTextSha256"] == pending["draftTextSha256"], "Pending draft regenerated/changed")
    require([(r["id"], r["repeatIndex"]) for r in current["segments"]] == [(f"chapter-bridge-{p}", repeat) for repeat in (1, 2) for p in (1, 2, 3, 4)], "Final source/repeat order differs")
    for row in current["segments"]:
        require(row["status"] == "generated" and row["qualityStatus"] == "NOT_REVIEWED", "Technical/quality state conflated")
        require(row["outputSha256"] == hashlib.sha256(row["text"].encode()).hexdigest() and row["final"]["text"] == row["text"], "Final text binding differs")
        require(row["draftTextSha256"] == hashlib.sha256(row["draft"]["text"].encode()).hexdigest(), "Draft text binding differs")
        for phase in (row["draft"], row["final"]):
            require(type(phase["inputTokens"]) is int and phase["inputTokens"] == phase["preflight"]["inputTokens"], "Native count/usage mismatch")
    normalized, index = [], 0
    argv = receipt["serverArguments"]
    while index < len(argv):
        if argv[index] == "--name":
            index += 2
        else:
            normalized.append(argv[index]); index += 1
    require(canonical(normalized) == receipt["serverRecipeSha256"] == previous["identity"]["settings"]["serverRecipeSha256"], "Actual new server recipe differs")
    require("--no-context-shift" in argv and argv[argv.index("--ctx-size") + 1] == "4096", "Context shift/size differs")
    require(receipt["serverImageId"] == previous["identity"]["runtime"]["modelServerImageId"] and receipt["clientImageId"] == previous["identity"]["runtime"]["pythonImageId"], "Actual runtime image differs")
    require(current["resumeCount"] == previous["resumeCount"] + 1 and current["invocations"][:-1] == previous["invocations"], "Invocation history changed")
    require(current["invocations"][-1]["reusedPendingDraft"] is True and current["invocations"][-1]["resumedAtCompletedSegments"] == 4, "Resume boundary not proven")
    summaries = [read(CASE / f"resume-02/{role}-telemetry/telemetry-summary.json") for role in ("server", "client")]
    require(all("abort" in t and t["abort"] is None and t["cleanupVerified"] is True and t["cleanup"] and all(r["verifiedStopped"] is True for r in t["cleanup"]) for t in summaries), "Final telemetry abort/unknown cleanup")
    require(receipt["cleanup"]["allVerifiedStopped"] is True and all(r["verifiedStopped"] is True for r in receipt["cleanup"]["containers"]), "Recovery container cleanup unproven")
    report = {"schemaVersion": 1, "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "status": "READ_ONLY_SECOND_REVIEW_CONFIRMS_RECOVERY_NOT_QUALITY_ACCEPTANCE", "resultSha256": receipt["resultSha256"], "originalFailedCaseSha256": ORIGINAL_CASE_SHA, "interruptedSnapshotSha256": INTERRUPTED_SHA,
        "committedRowsPreserved": 4, "newRows": 4, "totalRows": 8, "exactPendingDraftReused": True,
        "actualServerRecipeRecomputed": True, "nativeTokenUsageEqualityCheckedPhases": 16,
        "bothFinalTelemetryNoAbort": True, "allOwnedCleanupVerified": True,
        "observedGpuPeakMiB": max(t["peaks"]["gpuUsedMiB"] for t in summaries), "observedTemperaturePeakC": max(t["peaks"]["gpuTemperatureC"] for t in summaries),
        "recordedContainerMemoryPeakBytes": max(v for t in summaries for v in t["peaks"]["containerMemoryPeakBytes"].values()),
        "successfulInferenceSecondsStoredAcrossAttempts": current["summary"]["totalInferenceSecondsBothPhasesCompletedRows"],
        "limits": ["Generation time sums accepted successful calls from both attempts; interrupted calls, duplicate startup and cooldown require separate whole-attempt accounting.", "No inference, human semantic/listening review or production mutation by this verifier.", "This confirms controlled recovery from this thermal process abort, not power-loss durability or universal GPU endurance."], "automaticPublicationApproved": False}
    destination = CASE / "second-recovery-review.json"
    require(not destination.exists(), "Keep completed second review immutable")
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
