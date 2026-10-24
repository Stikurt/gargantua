"""Offline import/API/tensor/WAV smoke; no model or user book is loaded."""
import importlib.metadata
import io
import json
import platform
import socket

import numpy as np
import onnx
import psutil
import safetensors
import sentencepiece
import sherpa_onnx
import soundfile as sf
import torch
import transformers
from transformers import (AutoModelForSeq2SeqLM, AutoTokenizer, MarianMTModel,
                          MarianTokenizer, M2M100ForConditionalGeneration,
                          M2M100Tokenizer, VitsModel)

torch.set_num_threads(1)
assert not torch.cuda.is_available(), "CPU image unexpectedly has CUDA runtime"
assert (torch.eye(2) @ torch.ones(2, 2)).sum().item() == 4.0
buffer = io.BytesIO()
sf.write(buffer, np.zeros(2205, dtype=np.float32), 22050, format="WAV", subtype="PCM_16")
buffer.seek(0)
pcm, sample_rate = sf.read(buffer, dtype="float32")
assert sample_rate == 22050 and len(pcm) == 2205
for name in ("OfflineTts", "OfflineTtsConfig", "OfflineTtsModelConfig", "OfflineTtsVitsModelConfig"):
    assert hasattr(sherpa_onnx, name), name
network_disabled = False
try:
    with socket.create_connection(("1.1.1.1", 443), timeout=0.3):
        pass
except OSError:
    network_disabled = True
assert network_disabled, "Smoke must be run with --network none"
packages = ["torch", "transformers", "safetensors", "sentencepiece", "psutil", "sherpa-onnx",
            "sherpa-onnx-core", "onnx", "soundfile", "numpy"]
print(json.dumps({"status": "passed", "kind": "offline-runtime-smoke-not-model-benchmark",
                  "python": platform.python_version(), "packages": {name: importlib.metadata.version(name) for name in packages},
                  "networkDenied": network_disabled, "cpuTensor": True, "wavRoundtrip": True,
                  "ttsApiPresent": True, "translationModelClassesPresent": True,
                  "modelLoaded": False, "bookLoaded": False, "sampleAudioListened": False}, indent=2))
