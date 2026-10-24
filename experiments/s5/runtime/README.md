# CPU runtime for the S5 pilot

This is an isolated experimental runtime, not a new production service. It never
needs a production database, library volume, profile token or Docker socket.
The owner-controlled model inventory and actual inference are separate steps.

The base image is pinned to
`python@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70`
(Linux x86_64, Python 3.12.15 when inspected). `requirements.in` fixes the direct
pilot packages. PyTorch is the exact **2.14.1+cpu cp312** wheel from the
[official CPU index](https://download.pytorch.org/whl/cpu/torch/), not the PyPI GPU
distribution. No CUDA packages are required in this image.

`download-wheels.py` runs in a disposable network-enabled container with only this
directory mounted. It downloads binary wheels only, verifies every resolved wheel
against the exact official PyTorch index or exact PyPI release SHA-256, and writes
`requirements.lock` and `wheel-lock.json`. Source distributions are prohibited.
The lock covers transitive dependencies as well as the direct packages. The
wheel package name/version is read as data, not imported or executed.

For the executed setup, Docker-to-PyPI payload transfers were too slow. After pip
had collected the complete dependency metadata, its 43 selected package versions
and the exact target interpreter's wheel tags were saved as
`resolved-metadata.json`. `finish-wheel-lock.py` then fetched the matching official
PyPI wheel data through bounded parallel host HTTPS requests, verified the exact
release hashes and retained the already verified official Torch CPU wheel. It
does **not** call host pip, install a package, import a downloaded wheel or change
host site-packages. This metadata-assisted resolution is provisional until the
offline container install and `pip check` succeed. The final wheel lock states
this actual path; the original slower downloader is preserved for reproducibility.

The Dockerfile installs only from the local wheel set using `--no-index`,
`--require-hashes` and a `RUN --network=none` instruction. `pip check` must pass.
The wheel inventory remains in this workspace for reproducibility; it is removed
from the final image filesystem. A local image ID and smoke result are recorded
separately after an actual successful build. A Docker tag alone is not a release
identity.

Runtime defaults turn off Hugging Face network use and telemetry, cap library
threads and use `/tmp` for caches. These environment flags complement, but do not
replace, `--network none`, a read-only root, non-root UID, capability drop,
no-new-privileges, bounded tmpfs/PIDs/CPU/memory/time and exact read-only model
mounts. No HTTP port needs publishing. The orchestrator must still reserve the
single heavy slot and protect foreground reading before model loading.

The offline smoke imports translation/TTS APIs, performs a tiny CPU tensor
operation, round-trips a synthetic silent WAV and confirms denied external
network access. It loads **no model and no book**, and is not translation,
pronunciation or listening acceptance. The model harness must separately set
`local_files_only=True`, `trust_remote_code=False` and `use_safetensors=True`
where applicable, verify the admitted file inventory and use bounded outputs.

The initial wheel-download attempt used a 256 MiB tmpfs. Because pip retained the
196,253,677-byte Torch wheel while preparing other dependencies, that attempt was
stopped before likely temporary-space exhaustion. The completed Torch wheel was
preserved, rechecked against the official index digest, and reused. The retry
uses disk-backed temporary storage under this runtime directory with the same
container memory limit. This was a build/download change, not a model benchmark
failure or a production security-limit change.

Sherpa's own source license does not cover every linked component or voice.
The TTS model lock records engine/component and individual voice/dataset scopes;
the local pilot does not publish a runtime image or native application containing
these assets. Redistribution must carry the applicable corresponding sources and
notices rather than labeling the entire combined image simply Apache-2.0.

## Separate GPU supply-chain speed experiment

The host GHCR range probe and `download-ghcr.py` were a tactical attempt to bypass
a slow Docker proxy for one exact official amd64 manifest. The 4 MiB probe passed
the requested 1 MB/s threshold, while larger transfers showed substantially lower
and variable throughput. The original official Docker pull then completed with
digest `sha256:490d8cd8000203a3ab8fdfce14ef931e2aa85affd4dd4447bcc75f299f00fd9a`.
The duplicate host helper was stopped by its verified exact PID and command;
process absence was confirmed. It has no model inference or active downloader.

The preserved host ranges are **not admitted image blobs**: 19 complete raw ranges
contained 973,432,616 bytes and partial ranges another 108,003,328 bytes at stop.
Only HTTPS origin, Content-Range and byte lengths had been checked; no whole
compressed blob digest was accepted, no full OCI archive was created or loaded,
and these ranges must not be used as an inference runtime. The terminal receipt
is `.local/s5-pilot/runtime-gpu/download-state.json` in the workspace.

A separate real 10 KiB OCI import fixture contained one inert text file and no
executable or model. Docker accepted its gzip OCI format, but raw alias lookup
failed; exact manifest-ID inspection succeeded. That temporary fixture was
removed only after checking its own label and exact ID. This limited probe does
not establish a complete alternate image import pipeline. The GPU benchmark uses
the completed original official Docker image instead.
