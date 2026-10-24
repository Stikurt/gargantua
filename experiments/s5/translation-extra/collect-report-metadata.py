"""Read existing pilot receipts only; no inference or quality computation."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PILOT = ROOT / ".local/s5-pilot"
MT = {
    "opus-paragraph": ("mt-opus-baseline/results/translation.json", ["mt-opus-baseline/telemetry/telemetry-summary.json"]),
    "m2m-paragraph-stable": ("mt-m2m-baseline-stable/results/translation.json", ["mt-m2m-baseline-stable/telemetry/telemetry-summary.json"]),
    "qwen3-1.7b-q8": ("qwen-small-gpu-baseline-retry-01/results/result.json", ["qwen-small-gpu-baseline-retry-01/server-telemetry/telemetry-summary.json", "qwen-small-gpu-baseline-retry-01/client-telemetry/telemetry-summary.json"]),
    "qwen3-4b-q4": ("qwen4-gpu-baseline/results/result.json", ["qwen4-gpu-baseline/server-telemetry/telemetry-summary.json", "qwen4-gpu-baseline/client-telemetry/telemetry-summary.json"]),
    "qwen35-4b-q4-default": ("qwen35-gpu-baseline/results/result.json", ["qwen35-gpu-baseline/server-telemetry/telemetry-summary.json", "qwen35-gpu-baseline/client-telemetry/telemetry-summary.json"]),
    "qwen35-4b-q4-bounded": ("qwen35-gpu-bounded-baseline/results/result.json", ["qwen35-gpu-bounded-baseline/server-telemetry/telemetry-summary.json", "qwen35-gpu-bounded-baseline/client-telemetry/telemetry-summary.json"]),
}


def read(relative):
    return json.loads((PILOT / relative).read_text(encoding="utf-8"))


def main():
    rows = []
    for name, (path, telemetry_paths) in MT.items():
        result = read(path)
        telemetries = [read(p) for p in telemetry_paths]
        row = {"name": name, "path": path, "sha256": hashlib.sha256((PILOT / path).read_bytes()).hexdigest(), "status": result.get("status"), "model": result.get("model"), "summary": result.get("summary"), "settings": result.get("settings"), "loadSeconds": result.get("loadSeconds"), "processPeakRssBytes": result.get("processPeakRssBytes"), "cgroupMemoryPeakBytes": result.get("cgroupMemoryPeakBytes"), "telemetry": [{"path": p, "wallSeconds": t["wallSeconds"], "abort": t["abort"], "exitCode": t["exitCode"], "peaks": t["peaks"], "cleanupVerified": t["cleanupVerified"]} for p, t in zip(telemetry_paths, telemetries)]}
        case_path = PILOT / Path(path).parents[1] / "case.json"
        if case_path.is_file():
            case = json.loads(case_path.read_text(encoding="utf-8"))
            row["coldStartupObservedSeconds"] = case.get("coldStartupObservedSeconds")
            row["serverLimits"] = case.get("serverLimits")
        rows.append(row)
    tts = []
    for name in ("piper-denis-fp32", "piper-denis-int8", "piper-ruslan-fp32", "mms-rus-fp32"):
        path = f"tts-comparison-01/{name}/results/audio/report.json"
        result = read(path)
        telemetry_path = f"tts-comparison-01/{name}/telemetry/telemetry-summary.json"
        telemetry = read(telemetry_path)
        keys = ("status", "sampleCount", "totalAudioSeconds", "totalSynthesisSeconds", "aggregateRealTimeFactor", "modelLoadSeconds", "coldTimeToFirstAudioSeconds", "wallSeconds", "peakProcessRssBytes", "allSignalIntegrityPassed", "modelArtifactBytes", "auditoryReview", "runtime")
        tts.append({"name": name, "path": path, "sha256": hashlib.sha256((PILOT / path).read_bytes()).hexdigest(), **{k: result.get(k) for k in keys}, "telemetry": {"path": telemetry_path, "wallSeconds": telemetry["wallSeconds"], "peaks": telemetry["peaks"], "cleanupVerified": telemetry["cleanupVerified"], "abort": telemetry["abort"]}})
    out = {"translation": rows, "tts": tts, "scope": "Metadata only from completed receipts; no new output quality or model execution inferred."}
    (PILOT / "report-metadata.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
