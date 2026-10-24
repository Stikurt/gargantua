"""One data-only request in a network-none container. No DB/library credentials."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import time
import urllib.request
import wave

from protocol import (ProtocolError, TRANSLATION_RECIPE, TTS_RECIPE, atomic_json,
    binding, digest, file_digest, read_json, recipe, translation_body, validate_request)

BASE = "http://127.0.0.1:8080/v1/chat/completions"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ProtocolError("provider_protocol", "Inference redirects forbidden")


def opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def json_call(client, endpoint, body, maximum, timeout=180):
    if endpoint not in (BASE, BASE + "/input_tokens"):
        raise ProtocolError("provider_protocol", "Only fixed private loopback endpoint is allowed")
    request = urllib.request.Request(endpoint, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with client.open(request, timeout=timeout) as response:
        raw = response.read(maximum + 1)
    if len(raw) > maximum:
        raise ProtocolError("provider_protocol", "Response exceeds bound")
    return json.loads(raw)


def translate(request, output, client=None):
    client = client or opener()
    body = translation_body(request)
    prompt_hash = digest(body)
    atomic_json(output / "phase.json", {"phase": "token_preflight"})
    native = json_call(client, BASE + "/input_tokens", body, 65536)
    count = native.get("input_tokens")
    if (native.get("object") != "response.input_tokens" or type(count) is not int
        or not 1 <= count <= TRANSLATION_RECIPE["maxInputTokens"]
        or count + TRANSLATION_RECIPE["maxOutputTokens"] + TRANSLATION_RECIPE["contextReserveTokens"] > TRANSLATION_RECIPE["contextTokens"]):
        raise ProtocolError("needs_split", "Native exact-template token count exceeds fixed context; no truncation")
    atomic_json(output / "phase.json", {"phase": "generating", "inputTokens": count})
    started = time.monotonic()
    data = json_call(client, BASE, body, 131072)
    elapsed = time.monotonic() - started
    choices, usage = data.get("choices"), data.get("usage", {})
    if not isinstance(choices, list) or len(choices) != 1:
        raise ProtocolError("provider_protocol", "Expected one completion")
    choice = choices[0]
    message = choice.get("message", {})
    text = message.get("content")
    if (usage.get("prompt_tokens") != count or type(usage.get("prompt_tokens")) is not int
        or type(usage.get("completion_tokens")) is not int
        or not 0 <= usage["completion_tokens"] <= TRANSLATION_RECIPE["maxOutputTokens"]):
        raise ProtocolError("provider_protocol", "Actual usage differs from native preflight or bounds")
    if choice.get("finish_reason") != "stop":
        raise ProtocolError("needs_split", "Translation did not stop normally; incomplete output withheld")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 6400:
        raise ProtocolError("quality_rejected", "Translation empty or oversized")
    text = text.strip()
    if (message.get("reasoning_content") or "<think>" in text or "</think>" in text
        or any(ord(c) < 32 and c not in "\r\n\t" for c in text)):
        raise ProtocolError("quality_rejected", "Reasoning or unsafe controls in translation")
    letters = [c for c in text if c.isalpha()]
    russian = sum("\u0400" <= c <= "\u04ff" for c in letters)
    flags = []
    if len(letters) >= 12 and russian / len(letters) < .6:
        raise ProtocolError("quality_rejected", "Output not predominantly Russian")
    if len(text) < len(request["text"]) * .35:
        raise ProtocolError("quality_rejected", "Possible major omission; output withheld")
    if len(text) > len(request["text"]) * 4:
        flags.append("possible_addition")
    target = output / "text.txt"
    with target.open("xb") as stream:
        stream.write(text.encode("utf-8")); stream.flush(); os.fsync(stream.fileno())
    return {"artifact": {"filename": "text.txt", "bytes": target.stat().st_size,
        "sha256": file_digest(target), "mime": "text/plain; charset=utf-8"},
        "promptSha256": prompt_hash, "inputTokens": count, "outputTokens": usage["completion_tokens"],
        "finishReason": "stop", "inferenceSeconds": elapsed, "qualityStatus": "MACHINE_DRAFT",
        "qualityFlags": flags, "semanticGuarantee": False}


def speech(request, output, profile):
    import numpy as np
    import sherpa_onnx
    root = Path("/models") / profile["modelDirectory"]
    config = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=str(root / profile["modelFilename"]),
            tokens=str(root / "tokens.txt"), data_dir=str(root / "espeak-ng-data")),
        provider="cpu", num_threads=2, debug=False), max_num_sentences=1)
    if not config.validate():
        raise ProtocolError("provider_protocol", "Pinned voice configuration invalid")
    atomic_json(output / "phase.json", {"phase": "loading_voice"})
    engine = sherpa_onnx.OfflineTts(config)
    atomic_json(output / "phase.json", {"phase": "generating"})
    started = time.monotonic()
    audio = engine.generate(request["text"], sid=0, speed=1.0)
    elapsed = time.monotonic() - started
    samples = np.asarray(audio.samples, dtype=np.float32).reshape(-1)
    rate = audio.sample_rate
    if (rate != 22050 or not 4410 <= len(samples) <= 22050 * TTS_RECIPE["maxAudioSeconds"]
        or not np.isfinite(samples).all()):
        raise ProtocolError("quality_rejected", "Voice signal length/rate/finite checks failed")
    peak, rms = float(np.max(np.abs(samples))), float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
    clipped = float(np.mean(np.abs(samples) >= .999))
    if peak <= .001 or rms <= .0001 or clipped >= .01:
        raise ProtocolError("quality_rejected", "Voice signal integrity check failed")
    path = output / "audio.wav"
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(rate)
        writer.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
    with path.open("rb") as stream:
        os.fsync(stream.fileno())
    if path.stat().st_size > 8 * 1024**2:
        raise ProtocolError("quality_rejected", "PCM artifact exceeds scan budget")
    return {"artifact": {"filename": "audio.wav", "bytes": path.stat().st_size,
        "sha256": file_digest(path), "mime": "audio/wav"},
        "durationSeconds": len(samples) / rate, "sampleRate": rate, "frames": len(samples),
        "inferenceSeconds": elapsed, "signalIntegrity": {"peak": peak, "rms": rms, "clippingFraction": clipped},
        "qualityStatus": "NOT_LISTENED", "qualityFlags": [], "semanticGuarantee": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--health", action="store_true")
    args = parser.parse_args()
    if args.health:
        client = opener()
        started = time.monotonic()
        while time.monotonic() - started < 180:
            try:
                with client.open("http://127.0.0.1:8080/health", timeout=1) as response:
                    data = json.loads(response.read(4096))
                if data.get("status") == "ok":
                    print('{"ready":true}'); return
            except (OSError, ValueError):
                pass
            time.sleep(.5)
        raise SystemExit(3)
    if args.request is None or args.output is None:
        parser.error("request and output are required for inference")
    request = validate_request(read_json(args.request))
    report = {"schemaVersion": 1, **binding(request), "requestSha256": file_digest(args.request),
        "providerRecipeSha256": digest(recipe(request["kind"])), "status": "failed"}
    try:
        if any(args.output.iterdir()):
            raise ProtocolError("provider_protocol", "Inference output must be empty")
        if request["kind"] == "translation":
            report.update(translate(request, args.output))
        else:
            profiles = read_json(Path(__file__).with_name("profiles.lock.json"), 262144)
            report.update(speech(request, args.output, profiles["tts"]))
        report["status"] = "completed"
    except ProtocolError as exc:
        report.update(code=exc.code, message=str(exc), retryable=exc.retryable)
    except Exception as exc:
        report.update(code="provider_error", message=type(exc).__name__ + ": " + str(exc)[:300], retryable=True)
    atomic_json(args.output / "inference.json", report)
    print(json.dumps({"status": report["status"], "code": report.get("code")}))
    raise SystemExit(0 if report["status"] == "completed" else 2)


if __name__ == "__main__":
    main()
