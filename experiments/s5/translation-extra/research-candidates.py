"""Summarize primary public metadata; no new model admission or execution."""
import datetime
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
EVIDENCE = ROOT / ".local/s5-pilot/extra-model-research"


def data(name):
    return json.loads((EVIDENCE / (name + ".json")).read_text(encoding="utf-8"))


def weights(metadata):
    return [{"path": f["rfilename"], "bytes": f["size"], "sha256": f.get("lfs", {}).get("sha256")} for f in metadata["siblings"] if f["rfilename"].endswith((".gguf", ".safetensors", ".bin"))]


def main():
    official4 = data("qwen35-official-4b")
    official2 = data("qwen35-official-2b")
    converted4 = data("qwen35-lmstudio-4b")
    converted2 = data("qwen35-lmstudio-2b")
    nllb = data("nllb-pr45")
    tg = data("translategemma-official-4b")
    selected = json.loads((HERE / "models.lock.json").read_text(encoding="utf-8"))
    report = {
        "schemaVersion": 1,
        "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope": "Additional candidates after semantic screening of the original four; no original comparison lock/corpus or earlier result rewritten.",
        "method": "Public primary publisher/converter model APIs, pinned cards/config/license bytes and exact installed llama.cpp source. Metadata only except separately approved fifth model download; no inference by this researcher.",
        "hardware": {"gpu": "RTX3050TiLaptop", "nominalVramBytes": 4 * 1024 ** 3, "runtime": "official llama.cpp server-cuda b11804", "runtimeSourceRevision": "c7fc5094179bf8a9c73c18593db714f8da41a402", "runtimeImageId": "sha256:490d8cd8000203a3ab8fdfce14ef931e2aa85affd4dd4447bcc75f299f00fd9a", "memoryRule": "Weight bytes are only a lower bound. CUDA/runtime/graph/attention KV/recurrent state, CPU staging and other desktop use must be measured; no model is declared to fit from file size alone."},
        "candidates": [
            {"id": "qwen35-4b-q4", "decision": "APPROVED_EXTRA_PILOT_DOWNLOAD_NOT_QUALITY_ACCEPTED", "publisher": "lmstudio-community conversion, original model Qwen", "repository": converted4["id"], "revision": converted4["sha"], "gated": converted4["gated"], "license": converted4["cardData"]["license"], "format": "GGUFv3", "weightOptions": weights(converted4), "chosenFile": "Qwen3.5-4B-Q4_K_M.gguf", "chosenWeightGiB": 2707513696 / 1024 ** 3,
             "provenance": selected["models"][0]["provenance"], "upstreamOfficialRevisionAtReview": official4["sha"], "upstreamFormat": "safetensors", "upstreamRawWeightBytes": sum(f["bytes"] for f in weights(official4)),
             "licenseEvidence": selected["models"][0]["licenseEvidence"], "runtimeCompatibility": "Exact installed source includes llama_model_qwen35 loader plus recurrent/dense hybrid graphs and Qwen3.5-4B Jinja template. This is source-level support, not a successful model load/quality result.",
             "fitAssessment": "Q4 weights 2.522GiB leave nominal ~1.478GiB for runtime/state/desktop; plausible short-context candidate, actual full GPU offload and sampled peak/headroom remain required. Q8 weights 4.174GiB exceed entire nominal VRAM before runtime; Q6 has substantially less headroom.",
             "pilotConstraints": {"contextTokens": 4096, "parallelSequences": 1, "multimodalProjector": False, "mtpSpeculativeDecoding": False, "thinking": False, "inferenceNetwork": "none", "trustRemoteCode": False},
             "sources": [f"https://huggingface.co/{converted4['id']}/blob/{converted4['sha']}/README.md", f"https://huggingface.co/Qwen/Qwen3.5-4B/blob/{official4['sha']}/config.json", "https://github.com/ggml-org/llama.cpp/blob/c7fc5094179bf8a9c73c18593db714f8da41a402/src/models/qwen35.cpp"]},
            {"id": "qwen35-2b-lmstudio-reserve", "decision": "RESEARCH_RESERVE_NO_DOWNLOAD_AUTHORIZATION", "publisher": "LM Studio team conversion, not official Qwen GGUF", "repository": converted2["id"], "revision": converted2["sha"], "gated": converted2["gated"], "license": converted2["cardData"]["license"], "format": "GGUF", "weightOptions": weights(converted2), "upstreamOfficialRevisionAtReview": official2["sha"], "upstreamFormat": "safetensors", "upstreamRawWeightBytes": sum(f["bytes"] for f in weights(official2)),
             "fitAssessment": "Q8_0 is 1.874GiB; Q4_K_M is 1.184GiB. More runtime headroom than 4B, but lower parameter count does not establish faithful literary translation. No performance/quality promise without the same source-driven screening.",
             "sources": [f"https://huggingface.co/{converted2['id']}/blob/{converted2['sha']}/README.md", f"https://huggingface.co/Qwen/Qwen3.5-2B/blob/{official2['sha']}/config.json"]},
            {"id": "nllb200-distilled600m-reserve", "decision": "RESEARCH_RESERVE_SAFE_FORMAT_CONVERSION_IDENTIFIED_NOT_DOWNLOADED", "publisher": "Meta official repository; open HF SFconvertbot PR45 supplies separate reviewed conversion", "repository": "facebook/nllb-200-distilled-600M", "revision": nllb["sha"], "upstreamMainRevision": "f8d333a098d19b4fd9a8b18f94170487ad3f821d", "gated": nllb["gated"], "license": "cc-by-nc-4.0", "format": "safetensors only; original pytorch_model.bin is excluded", "weightOptions": [f for f in weights(nllb) if f["path"].endswith(".safetensors")],
             "conversionStatus": "PR45 open, authored SFconvertbot, commit parent matches official main f8d333a. Bot asserts equivalence; not accepted by Meta and not independently numerically compared here.",
             "licenseVsIntendedUse": "Record CC-BY-NC-4.0 obligations separately from model-card intended use. The card describes research/single-sentence MT, unsuitable document/production use and training sequences <=512 tokens; these are engineering/intended-use constraints, not an invented blanket legal ban on a personal noncommercial sentence-wise experiment. Attribution/noncommercial/exact license terms remain applicable.",
             "fitAssessment": "FP32 safe weight file 2,460,355,912B (~2.291GiB). CPU may fit bounded 5GiB runtime only after measured transient/RSS/host reserve check. Full GPU memory use is unmeasured; do not assume it fits4GiB. Quantized CTranslate2/FP16 would be a distinct conversion/runtime pilot, not silently equivalent baseline.",
             "integrationNotes": ["Use direct AutoTokenizer/AutoModelForSeq2SeqLM, local_files_only, use_safetensors and trust_remote_code=False; translation pipeline removed in transformers5.", "Explicit source/target tags such as eng_Latn, jpn_Jpan, zho_Hans, rus_Cyrl; verify actual tokenizer special tokens.", "Sentence-boundary segmentation and strict complete encoded-token limit including language/EOS tokens; never truncate silently. Document context/glossary consistency is a separate unresolved gate."],
             "sources": ["https://huggingface.co/facebook/nllb-200-distilled-600M", "https://huggingface.co/facebook/nllb-200-distilled-600M/discussions/45", "https://creativecommons.org/licenses/by-nc/4.0/"]},
            {"id": "translategemma4b-research-only", "decision": "GATED_NO_ACCOUNT_TERMS_ACCEPTANCE_NO_DOWNLOAD", "publisher": "Google", "repository": tg["id"], "revision": tg["sha"], "gated": tg["gated"], "license": tg["cardData"]["license"], "format": "safetensors", "architecture": "gemma3", "rawWeightBytes": sum(f["bytes"] for f in weights(tg)),
             "reason": "Official repository requires account review and acceptance of Google usage license before artifact access. None accepted here; do not bypass this gate with a third-party mirror. Exact legal consent is distinct from zero monetary price.",
             "fitAssessment": "Official full weights are not a 4GiB VRAM profile. A future license-authorized reviewed quantization would need separate pinned provenance/runtime and real measurements.",
             "sources": ["https://huggingface.co/google/translategemma-4b-it", "https://blog.google/innovation-and-ai/technology/developers-tools/translategemma/"]},
        ],
        "officialGgufLookup": {"result": "NO_PUBLIC_OFFICIAL_QWEN35_GGUF_VERIFIED", "exactGuesses": {"Qwen/Qwen3.5-4B-GGUF": "API401", "Qwen/Qwen3.5-2B-GGUF": "API401"}, "interpretation": "401 on guessed repositories does not prove nonexistence. Public Qwen owner search and official cards yielded no official small GGUF release at review time; selected converter is explicitly labeled accordingly."},
        "qualityGate": "Source-driven semantic fidelity first: negation/condition/agent/number/name/time, no omission/invention/untranslated-script leaks. Faster throughput or a newer generation cannot compensate for critical semantic errors. No quality acceptance from vendor benchmarks alone.",
        "measuredResultsByThisResearcher": None,
    }
    path = HERE / "candidate-research.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"path": str(path), "candidates": len(report["candidates"]), "newInferenceExecuted": False}))


if __name__ == "__main__":
    main()
