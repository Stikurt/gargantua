"""Offline, bounded Russian TTS benchmark. Run one model per isolated container.

Expected container policy: no network or production mounts, read-only root and
models, non-root user, dropped capabilities, memory/cpu/pid limits and timeout.
Signal metrics detect corrupt/empty output; they do NOT measure intelligibility,
correct word stress, missing spoken words, naturalness, or listener preference.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import pathlib
import platform
import resource
import sys
import time
import wave

PROCESS_START = time.perf_counter()
os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                   "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1"})


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def proc_rss():
    # Linux ru_maxrss is KiB; this pilot intentionally excludes native Windows.
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024


def signal_metrics(samples, sample_rate):
    import numpy as np
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if samples.size == 0 or not np.isfinite(samples).all():
        raise ValueError("empty/non-finite generated signal")
    duration = samples.size / sample_rate
    if not 0.2 <= duration <= 300:
        raise ValueError("generated duration outside per-passage budget")
    maximum = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
    window = max(1, sample_rate // 50)
    full = len(samples) // window
    frame_rms = np.sqrt(np.mean(samples[:full * window].reshape(full, window).astype(np.float64) ** 2, axis=1))
    silence = frame_rms < 0.00316227766  # -50 dBFS, operational threshold only.
    longest = current = 0
    for value in silence:
        current = current + 1 if value else 0
        longest = max(longest, current)
    return {"sampleRate": sample_rate, "sampleCount": int(samples.size), "durationSeconds": duration,
            "peakAmplitude": maximum, "rms": rms,
            "clippingFraction": float(np.mean(np.abs(samples) >= 0.999)),
            "silenceFrameFraction": float(np.mean(silence)),
            "longestSilenceSeconds": longest * window / sample_rate,
            "integrityPassed": maximum > 0.001 and rms > 0.0001 and float(np.mean(silence)) < 0.98
                               and float(np.mean(np.abs(samples) >= 0.999)) < 0.01}


def save_wave(path, samples, sample_rate):
    import numpy as np
    # Only a safe PCM16 derivative is saved; report clipping before conversion.
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())


def verify_staged(models_root, manifest_path, model):
    receipt = json.loads((models_root / "prepared.json").read_text(encoding="utf-8"))
    if receipt["manifestSha256"] != sha256(manifest_path):
        raise ValueError("staging manifest changed")
    entry = next(m for m in receipt["models"] if m["id"] == model["id"])
    total = 0
    for spec in entry["files"]:
        path = models_root / spec["path"]
        if not path.resolve().is_relative_to(models_root.resolve()) or path.is_symlink():
            raise ValueError("staged path escaped")
        if path.stat().st_size != spec["bytes"] or sha256(path) != spec["sha256"]:
            raise ValueError("staged bytes changed")
        total += spec["bytes"]
    return total


def build_engine(model, directory, threads):
    if model["engine"] == "sherpa-onnx":
        import sherpa_onnx
        configuration = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=str(directory / model["modelFilename"]),
                    tokens=str(directory / "tokens.txt"),
                    data_dir=str(directory / model["dataDirectory"])),
                provider="cpu", num_threads=threads, debug=False),
            max_num_sentences=1)
        if not configuration.validate():
            raise ValueError("invalid sherpa model configuration")
        engine = sherpa_onnx.OfflineTts(configuration)

        def synthesize(text, seed):
            result = engine.generate(text, sid=0, speed=1.0)
            return result.samples, result.sample_rate, {"seedControlled": False,
                  "semanticCoverage": "not measured; phonemizer output is not forced-aligned to generated speech"}
        return synthesize, {"runtime": sherpa_onnx.__version__, "sampleRate": engine.sample_rate}
    import torch
    from transformers import VitsModel, VitsTokenizer
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    tokenizer = VitsTokenizer.from_pretrained(directory, local_files_only=True, trust_remote_code=False)
    engine = VitsModel.from_pretrained(directory, local_files_only=True,
                                      use_safetensors=True, trust_remote_code=False).to("cpu").eval()
    vocabulary = tokenizer.get_vocab()

    def synthesize(text, seed):
        torch.manual_seed(seed)
        inputs = tokenizer(text, return_tensors="pt", truncation=False)
        if inputs["input_ids"].shape[1] > 4000:
            raise ValueError("MMS token budget")
        unsupported = sorted(set(c for c in text.lower() if not c.isspace() and c not in vocabulary))
        with torch.inference_mode():
            output = engine(**inputs).waveform[0].detach().cpu().numpy()
        return output, engine.config.sampling_rate, {"seedControlled": True,
               "tokenCount": int(inputs["input_ids"].shape[1]), "charactersOutsideVocabulary": unsupported,
               "semanticCoverage": "not measured; vocabulary exclusions indicate normalization risk, not exact word-error rate"}
    import transformers
    return synthesize, {"torch": torch.__version__, "transformers": transformers.__version__,
                        "sampleRate": engine.config.sampling_rate}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-root", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--threads", type=int, default=2, choices=[1, 2, 4])
    parser.add_argument("--repeat", type=int, default=2, choices=[1, 2, 3])
    parser.add_argument("--sample", action="append", default=[])
    parser.add_argument("--lock", type=pathlib.Path, default=pathlib.Path(__file__).with_name("models.lock.json"))
    parser.add_argument("--corpus", type=pathlib.Path, default=pathlib.Path(__file__).with_name("corpus.json"))
    args = parser.parse_args()
    for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ[variable] = str(args.threads)
    manifest = json.loads(args.lock.read_text(encoding="utf-8"))
    model = next(m for m in manifest["models"] if m["id"] == args.model)
    corpus = json.loads(args.corpus.read_text(encoding="utf-8"))
    passages = [s for s in corpus["samples"] if not args.sample or s["id"] in args.sample]
    if not passages or len(passages) != (len(args.sample) if args.sample else len(corpus["samples"])):
        raise ValueError("unknown/duplicate sample selection")
    for passage in passages:
        if not 1 <= len(passage["text"]) <= 1600:
            raise ValueError("passage length budget")
    if args.output.exists():
        raise ValueError("output already exists; keep individual runs immutable")
    args.output.mkdir(parents=True)
    verify_start = time.perf_counter()
    artifact_bytes = verify_staged(args.models_root, args.lock, model)
    verify_seconds = time.perf_counter() - verify_start
    model_dir = args.models_root / model["id"] / model["directory"]
    load_start = time.perf_counter()
    synthesize, runtime = build_engine(model, model_dir, args.threads)
    load_seconds = time.perf_counter() - load_start
    rows = []
    first_audio = None
    for repeat in range(args.repeat):
        for passage in passages:
            started = time.perf_counter(); cpu_started = time.process_time()
            samples, sample_rate, coverage = synthesize(passage["text"], 70123 + repeat)
            elapsed = time.perf_counter() - started
            cpu_seconds = time.process_time() - cpu_started
            if first_audio is None: first_audio = time.perf_counter() - PROCESS_START
            metrics = signal_metrics(samples, sample_rate)
            name = f"{passage['id']}-{repeat + 1}.wav"
            save_wave(args.output / name, samples, sample_rate)
            row = {"sample": passage["id"], "repeat": repeat + 1, "characters": len(passage["text"]),
                   "sourceTextSha256": hashlib.sha256(passage["text"].encode()).hexdigest(),
                   "wallSeconds": elapsed, "cpuSeconds": cpu_seconds,
                   "realTimeFactor": elapsed / metrics["durationSeconds"],
                   "peakProcessRssBytes": proc_rss(), "audio": name,
                   "audioSha256": sha256(args.output / name), "signal": metrics,
                   "coverage": coverage}
            rows.append(row)
            print(json.dumps({"model": model["id"], "sample": passage["id"], "repeat": repeat + 1,
                              "realTimeFactor": row["realTimeFactor"], "integrity": metrics["integrityPassed"]}), flush=True)
            # Incremental evidence survives a killed later sample, but not a false complete report.
            with (args.output / "samples.jsonl").open("a", encoding="utf-8") as writer:
                writer.write(json.dumps(row, ensure_ascii=False) + "\n")
    report = {"schemaVersion": 1, "status": "completed",
              "allSignalIntegrityPassed": all(r["signal"]["integrityPassed"] for r in rows),
              "model": model["id"], "family": model["family"], "precision": model["precision"],
              "modelArtifactBytes": artifact_bytes, "manifestSha256": sha256(args.lock),
              "corpusSha256": sha256(args.corpus), "threads": args.threads, "runtime": runtime,
              "python": sys.version.split()[0], "platform": platform.platform(),
              "gpuUsed": False, "verificationSeconds": verify_seconds,
              "modelLoadSeconds": load_seconds, "coldTimeToFirstAudioSeconds": first_audio,
              "firstAudioMeaning": "First complete passage is available; this does not measure streaming time to first audio frame.",
              "wallSeconds": time.perf_counter() - PROCESS_START,
              "peakProcessRssBytes": proc_rss(), "sampleCount": len(rows),
              "totalAudioSeconds": sum(r["signal"]["durationSeconds"] for r in rows),
              "totalSynthesisSeconds": sum(r["wallSeconds"] for r in rows),
              "aggregateRealTimeFactor": sum(r["wallSeconds"] for r in rows) / sum(r["signal"]["durationSeconds"] for r in rows),
              "auditoryReview": {"status": "not-performed", "reason": "No listening/transcription tool is available in this run. Signal metrics are not perceived speech quality."},
              "limits": ["Eight synthetic Russian passages do not represent every book.",
                         "No forced alignment or human intelligibility rating was performed.",
                         "Stochastic VITS outputs can vary; sherpa runtime seed was not controlled.",
                         "This is an isolated pilot, not a deployed automatic audio provider."],
              "samples": rows}
    (args.output / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"completed": True, "model": model["id"], "samples": len(rows),
                      "aggregateRealTimeFactor": report["aggregateRealTimeFactor"],
                      "peakProcessRssBytes": report["peakProcessRssBytes"]}))
    if not report["allSignalIntegrityPassed"]: raise SystemExit(2)


if __name__ == "__main__": main()
