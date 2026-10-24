"""Windows coordinator for one isolated GGUF case; no production state is mounted.

Uses only the Docker CLI and local Python stdlib. Downloads/builds are separate.
Never invoke this launcher before the central coordinator grants the GPU slot.
"""
from __future__ import annotations
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

import bench
import qa_launcher_policy as qa_policy

ROOT = Path(__file__).resolve().parents[3]
PILOT = ROOT / ".local/s5-pilot"
MODEL_ROOT = PILOT / "downloads"
SERVER_IMAGES = {"cuda": "ghcr.io/ggml-org/llama.cpp:server-cuda", "cpu": "ghcr.io/ggml-org/llama.cpp:server"}
PYTHON_IMAGE = "python@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70"
CASES = ("qwen3-1.7b-q8", "qwen3-4b-q4")
EXTRA_CASE = "qwen35-4b-q4"
EXTRA_WEIGHT = {"path": "Qwen3.5-4B-Q4_K_M.gguf", "bytes": 2707513696, "sha256": "25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c"}
EXTRA_REPOSITORY = "lmstudio-community/Qwen3.5-4B-GGUF"
EXTRA_REVISION = "f9f88ac3e234be915e23811a6d28ea287bdb927e"
EXTRA_LOCK_SHA256 = "efb5dc9626f357d4a2cf829053afbd800c4376a8ca21b6507bde159d65e33f51"

_wrapper_spec = importlib.util.spec_from_file_location("s5_common_container", ROOT / "experiments/s5/run-container.py")
_wrapper = importlib.util.module_from_spec(_wrapper_spec)
_wrapper_spec.loader.exec_module(_wrapper)

HEALTH_CODE = r'''
import json,time,urllib.request,urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): raise ValueError("No inference redirects")
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
start=time.monotonic()
attempt=0
while time.monotonic()-start < 180:
    attempt+=1
    try:
        with opener.open("http://127.0.0.1:8080/health",timeout=1) as r:
            raw=r.read(4097)
            if len(raw)>4096: raise ValueError("Health response oversized")
            payload=json.loads(raw)
            if r.status==200 and payload.get("status")=="ok":
                print(json.dumps({"ready":True,"healthAttempts":attempt,"healthPollSeconds":time.monotonic()-start,"response":payload}),flush=True)
                break
    except (OSError,ValueError): pass
    time.sleep(.5)
else:
    print(json.dumps({"ready":False,"healthAttempts":attempt,"healthPollSeconds":time.monotonic()-start}),flush=True)
    raise SystemExit(2)
'''


def process_options():
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def command(argv, timeout=30, check=True):
    result = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, **process_options())
    if check and result.returncode:
        raise RuntimeError("Command failed: " + " ".join(argv[:3]) + ": " + result.stderr[-1500:])
    return result


def owned_name(name):
    return bool(re.fullmatch(r"gargantua-s5-[a-z0-9-]+", name))


def checked_output(relative):
    checked_mount(relative)
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("Output must be a relative path within .local/s5-pilot")
    target = (ROOT / path).resolve()
    if PILOT.resolve() not in target.parents or target.exists():
        raise ValueError("Output must be a new unique directory within .local/s5-pilot")
    models = MODEL_ROOT.resolve()
    if target == models or models in target.parents or target in models.parents:
        raise ValueError("Model and writable output paths must not overlap")
    return target


def checked_mount(path):
    value = str(path)
    if "," in value or any(ord(char) < 32 for char in value):
        raise ValueError("Docker mount paths must not contain commas or control characters")
    return value


def selected_manifest(args):
    extra = getattr(args, "extra", False)
    if args.case == EXTRA_CASE:
        if not extra:
            raise ValueError("Additional reviewed case requires explicit --extra")
        return ROOT / "experiments/s5/translation-extra/models.lock.json", "/pilot/extra-models.lock.json"
    if args.case not in CASES or extra:
        raise ValueError("--extra is reserved for the one explicitly approved additional case")
    return Path(__file__).with_name("models.lock.json"), "/pilot/translation/models.lock.json"


def validate_extra_policy(lock, args):
    if args.case != EXTRA_CASE:
        return
    if not getattr(args, "extra", False) or len(lock.get("models", [])) != 1:
        raise ValueError("Extra case must use its separate single-model manifest")
    row = lock["models"][0]
    if any(row.get(key) != value for key, value in {"id": EXTRA_CASE, "repository": EXTRA_REPOSITORY, "revision": EXTRA_REVISION, "provider": "llama-http", "license": "apache-2.0"}.items()):
        raise ValueError("Additional model differs from root-reviewed provenance")
    files = row.get("files", [])
    weights = [item for item in files if item.get("path", "").endswith(".gguf")]
    if len(weights) != 1 or any(weights[0].get(key) != value for key, value in EXTRA_WEIGHT.items()):
        raise ValueError("Additional weights differ from root-approved exact artifact")
    if len(files) != 2 or {item.get("path") for item in files} != {EXTRA_WEIGHT["path"], "README.md"}:
        raise ValueError("Only the reviewed text-model GGUF and provenance README may be mounted")


def image_info(reference):
    info = json.loads(command(["docker", "image", "inspect", reference], timeout=20).stdout)[0]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", info.get("Id", "")):
        raise ValueError("Local runtime image has no immutable content ID")
    return {"requestedReference": reference, "id": info["Id"], "repoDigests": info.get("RepoDigests", []), "entrypoint": info.get("Config", {}).get("Entrypoint"), "cmd": info.get("Config", {}).get("Cmd")}


def server_binary(image):
    entrypoint = image.get("entrypoint")
    if entrypoint == ["/app/llama-server"]:
        return "/app/llama-server"
    raise ValueError("Unexpected upstream server entrypoint; inspect before running any model")


def restrictions(name, memory, cpus, pids=128):
    if not owned_name(name):
        raise ValueError("Invalid owned container name")
    return ["--name", name, "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", memory, "--memory-swap", memory, "--cpus", str(cpus), "--pids-limit", str(pids), "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m", "--env", "HOME=/tmp", "--env", "PYTHONDONTWRITEBYTECODE=1"]


def model_mount(model_dir):
    return ["--mount", f"type=bind,source={checked_mount(model_dir)},target=/models,readonly"]


def server_args(name, model_dir, image_id, binary, filename, backend="cuda", bounded_cache=False, qa=False, context_tokens=2048):
    if filename not in ("Qwen3-1.7B-Q8_0.gguf", "Qwen3-4B-Q4_K_M.gguf", EXTRA_WEIGHT["path"]):
        raise ValueError("Unknown GPU artifact")
    if backend not in SERVER_IMAGES:
        raise ValueError("Unknown explicit inference backend")
    if bounded_cache and filename != EXTRA_WEIGHT["path"]:
        raise ValueError("Bounded-cache recipe is a separate additional-model profile only")
    if (qa and filename != EXTRA_WEIGHT["path"]) or context_tokens not in (2048, 4096) or (not qa and context_tokens != 2048):
        raise ValueError("QA/context change is an explicit additional-model recipe only")
    return ["run", *restrictions(name, "5g", 6), "--network", "none", *(["--gpus", "all"] if backend == "cuda" else []), *model_mount(model_dir), "--entrypoint", binary, image_id, "--model", "/models/" + filename, "--host", "127.0.0.1", "--port", "8080", "--ctx-size", str(context_tokens), "--batch-size", "256", "--ubatch-size", "128", "--parallel", "1", "--threads", "6", "--n-gpu-layers", "99" if backend == "cuda" else "0", "--jinja", "--verbosity", "4", *(["--cache-ram", "256", "--ctx-checkpoints", "2"] if bounded_cache else []), *(["--no-context-shift"] if qa else [])]


def client_args(name, server, model_dir, output, image_id, args):
    if not owned_name(server):
        raise ValueError("Unknown server namespace")
    argv = ["run", "--rm", *restrictions(name, "1g", 2), "--network", "container:" + server, *model_mount(model_dir), "--mount", f"type=bind,source={checked_mount(ROOT / 'experiments/s5/translation')},target=/pilot/translation,readonly", "--mount", f"type=bind,source={checked_mount(output)},target=/out"]
    manifest_path, manifest_target = selected_manifest(args)
    if getattr(args, "extra", False):
        argv += ["--mount", f"type=bind,source={checked_mount(manifest_path)},target={manifest_target},readonly"]
    is_qa = getattr(args, "qa", False)
    if is_qa:
        qa_policy.require_extra_variant(args.case, getattr(args, "extra", False))
        argv += ["--mount", f"type=bind,source={checked_mount(qa_policy.QA_ROOT)},target=/pilot/translation-extra,readonly"]
    corpus_path, corpus_target = selected_corpus(args)
    if args.holdout or getattr(args, "chapter", False):
        argv += ["--mount", f"type=bind,source={checked_mount(corpus_path)},target={corpus_target},readonly"]
    argv += ["--entrypoint", "python", image_id, "/pilot/translation-extra/qa_bench.py" if is_qa else "/pilot/translation/bench.py", "--model-id", args.case, "--model-dir", "/models", "--lock", manifest_target, "--corpus", corpus_target, "--output", "/out/result.json", "--device", getattr(args, "backend", "cuda"), "--threads", "2", "--repeat", str(args.repeat)]
    if is_qa:
        argv += qa_policy.runtime_arguments(image_id, args.qa_server_image_id, args.qa_server_args)
    if args.context:
        argv.append("--context")
    if args.glossary:
        argv.append("--glossary")
    return argv


def selected_corpus(args):
    if args.holdout and getattr(args, "chapter", False):
        raise ValueError("Choose only one fixed corpus")
    if getattr(args, "chapter", False):
        return ROOT / "experiments/s5/chapter-inputs.json", "/pilot/chapter-inputs.json"
    if args.holdout:
        return ROOT / "experiments/s5/holdout-inputs.json", "/pilot/holdout-inputs.json"
    return ROOT / "experiments/s5/translation/corpus.json", "/pilot/translation/corpus.json"


def health_args(name, server, image_id):
    if not owned_name(server):
        raise ValueError("Unknown server namespace")
    return ["run", "--rm", *restrictions(name, "128m", .5, 64), "--network", "container:" + server, "--entrypoint", "python", image_id, "-c", HEALTH_CODE]


def backend_evidence(backend, server_text):
    offloads = re.findall(r"offloaded\s+(\d+)/(\d+)\s+layers to GPU", server_text)
    if backend == "cuda":
        if not offloads or int(offloads[-1][0]) <= 0 or offloads[-1][0] != offloads[-1][1]:
            raise RuntimeError("GPU case did not confirm complete model layer offload; do not silently benchmark a CPU fallback")
        return {"backend": "cuda", "layersOffloaded": int(offloads[-1][0]), "layersTotal": int(offloads[-1][1]), "source": "server-telemetry/console.log"}
    if backend != "cpu":
        raise ValueError("Unknown inference backend")
    cpu_buffers = re.findall(r"[^\n]*\bCPU(?:_Mapped)?\s+model buffer size[^\n]*", server_text)
    if not cpu_buffers or any(int(loaded) > 0 for loaded, total in offloads) or re.search(r"\bCUDA\d+\s+model buffer size", server_text):
        raise RuntimeError("CPU case did not confirm CPU model buffers without GPU model offload")
    return {"backend": "cpu", "requestedGpuLayers": 0, "cpuModelBuffers": cpu_buffers, "source": "server-telemetry/console.log", "gpuModelOffload": False}


def cleanup_owned(names):
    rows = []
    for name in names:
        if not owned_name(name):
            raise ValueError("Refusing cleanup outside this pilot namespace")
        try:
            rows.append(_wrapper.ensure_stopped(name))
        except Exception as exc:
            rows.append({"name": name, "verifiedStopped": False, "observations": ["unknown"], "error": type(exc).__name__ + ": " + str(exc)[:500]})
    return rows


def validate_coordinator_telemetry(summaries):
    """A finished client is insufficient if its server later reports an abort."""
    if set(summaries) != {"server", "client"}:
        raise ValueError("Both finalized coordinator summaries are required")
    for role, summary in summaries.items():
        if not isinstance(summary, dict):
            raise ValueError(role + " telemetry is malformed")
        cleanup = summary.get("cleanup")
        if ("abort" not in summary or summary["abort"] is not None
                or summary.get("cleanupVerified") is not True
                or not isinstance(cleanup, list) or not cleanup
                or not all(isinstance(row, dict) and row.get("verifiedStopped") is True for row in cleanup)):
            raise ValueError(role + " telemetry reports an abort or lacks verified cleanup")
        allowed = (0, 143) if role == "server" else (0,)
        if type(summary.get("exitCode")) is not int or summary["exitCode"] not in allowed:
            raise ValueError(role + " coordinator recorded an unexpected or unknown container exit")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=CASES+(EXTRA_CASE,), required=True)
    parser.add_argument("--extra", action="store_true", help="Explicitly select the separately reviewed fifth-model manifest, only for qwen35-4b-q4")
    parser.add_argument("--bounded-cache", action="store_true", help="Additional-model resource variant only: 256 MiB server cache and two context checkpoints")
    parser.add_argument("--qa", action="store_true", help="Explicit frozen source/draft repair variant, only for the separately reviewed additional model")
    parser.add_argument("--qa-context-tokens", type=int, choices=(2048, 4096), default=2048, help="QA-only context profile; 4096 is a separate measured recipe")
    parser.add_argument("--backend", choices=("cpu", "cuda"), default="cuda", help="Explicit backend; CPU uses official CPU runtime and zero GPU layers, never an automatic fallback")
    parser.add_argument("--output", required=True, help="New unique relative directory under .local/s5-pilot")
    parser.add_argument("--holdout", action="store_true")
    parser.add_argument("--chapter", action="store_true", help="Use only the fixed longer original chapter fixture; references remain outside inference")
    parser.add_argument("--context", action="store_true")
    parser.add_argument("--glossary", action="store_true")
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()
    if not 1 <= args.repeat <= 3 or not 30 <= args.timeout <= 3600:
        raise ValueError("Pilot duration/repeat bounds exceeded")
    if args.context and not (args.holdout or args.chapter):
        raise ValueError("Story context trial requires --holdout or --chapter")
    if args.bounded_cache and not (args.extra and args.case == EXTRA_CASE):
        raise ValueError("--bounded-cache requires the explicitly reviewed additional case")
    qa_receipt = None
    if args.qa:
        qa_policy.require_extra_variant(args.case, args.extra)
        qa_receipt = qa_policy.validate_frozen_runner(qa_policy.QA_ROOT / "qa_bench.py", qa_policy.QA_RUNNER_SHA256)
    elif args.qa_context_tokens != 2048:
        raise ValueError("A larger context requires the explicit QA variant")
    output = checked_output(args.output)
    model_dir = MODEL_ROOT / args.case
    if model_dir.is_symlink() or PILOT.resolve() not in model_dir.resolve().parents:
        raise ValueError("Model directory escaped fixed pilot workspace")
    lock_path, _ = selected_manifest(args)
    if args.extra and bench.sha256(lock_path) != EXTRA_LOCK_SHA256:
        raise ValueError("Additional manifest differs from the frozen independently reviewed file")
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    validate_extra_policy(lock, args)
    # Missing, partial or altered weights fail before docker model startup.
    model, checked = bench.verify_model(lock, args.case, model_dir)
    source, _ = selected_corpus(args)
    corpus, corpus_sha = bench.load_corpus(source)
    server_image, python_image = image_info(SERVER_IMAGES[args.backend]), image_info(PYTHON_IMAGE)
    binary = server_binary(server_image)
    nonce = uuid.uuid4().hex
    server, client, health = ["gargantua-s5-" + nonce + "-" + role for role in ("server", "client", "health")]
    output.mkdir(parents=True)
    inference_output = output / "results"
    inference_output.mkdir()
    start = time.monotonic()
    report = {"schemaVersion": 1, "status": "running", "case": args.case, "startedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "serverImage": server_image, "clientImage": python_image, "artifactsVerified": checked, "corpus": {"id": corpus["id"], "sha256": corpus_sha}, "runnerSha256": bench.sha256(Path(__file__)), "benchSha256": bench.sha256(Path(__file__).with_name("bench.py")), "settings": {"holdout": args.holdout, "chapter": args.chapter, "context": args.context, "glossary": args.glossary, "repeat": args.repeat}, "serverLimits": {"memoryBytes": 5*1024**3, "memoryAndSwapBytes": 5*1024**3, "cpus": 6, "threads": 6, "pids": 128, "ctxTokens": 2048, "batchTokens": 256, "microBatchTokens": 128, "parallel": 1, "gpuLayersRequested": 99}, "clientLimits": {"memoryBytes": 1024**3, "memoryAndSwapBytes": 1024**3, "cpus": 2, "pids": 128}, "containers": {"server": server, "client": client, "health": health}, "portsPublished": False, "productionMounted": False, "cleanup": {}}
    manifest = output / "case.json"
    bench.atomic_json(manifest, report)
    wrapper = ROOT / "experiments/s5/run-container.py"
    reviewed_server_args = server_args(server, model_dir, server_image["id"], binary, next(item["path"] for item in model["files"] if item["path"].endswith(".gguf")), args.backend, args.bounded_cache, args.qa, args.qa_context_tokens)
    report["backend"] = args.backend
    report["modelManifest"] = {"family": "additional-reviewed-case" if args.extra else "original-four-model-comparison", "path": str(lock_path.relative_to(ROOT)), "sha256": bench.sha256(lock_path)}
    report["settings"]["backend"] = args.backend
    report["settings"]["boundedCache"] = args.bounded_cache
    report["settings"]["qa"] = args.qa
    report["serverLimits"]["ctxTokens"] = args.qa_context_tokens
    if args.qa:
        report["qaRunner"] = qa_receipt
        report["qaPolicySha256"] = bench.sha256(Path(qa_policy.__file__))
        report["qaServerRecipeSha256"] = qa_policy.recipe_sha256(reviewed_server_args)
        report["qaServerRecipeDigestScope"] = "All actual server argv except the incidental --name UUID pair; full argv also retained"
        report["qaAuthorReceiptSha256"] = bench.sha256(PILOT / "qa-runner-receipt.json")
        args.qa_server_image_id = server_image["id"]
        args.qa_server_args = reviewed_server_args
    report["serverLimits"]["requestedCacheRamMiB"] = 256 if args.bounded_cache else None
    report["serverLimits"]["requestedContextCheckpoints"] = 2 if args.bounded_cache else None
    report["serverLimits"]["cacheScope"] = "Explicit additional-model bounded-cache variant; original comparison recipes retain upstream defaults" if args.bounded_cache else "No cache override; actual upstream defaults belong to this pinned server image"
    report["serverLimits"]["gpuLayersRequested"] = 99 if args.backend == "cuda" else 0
    report["serverArguments"] = reviewed_server_args
    report["commonCoordinatorSha256"] = bench.sha256(wrapper)
    bench.atomic_json(manifest, report)
    server_command = [sys.executable, str(wrapper), "--name", server, "--timeout", str(args.timeout), "--output", str(output / "server-telemetry"), "--", *reviewed_server_args]
    server_proc = None
    try:
        with (output / "server-coordinator.log").open("w", encoding="utf-8") as server_log:
            server_proc = subprocess.Popen(server_command, stdout=server_log, stderr=subprocess.STDOUT, **process_options())
            # Wait for namespace creation only; GPU loading may still be underway.
            deadline = time.monotonic()+30
            while time.monotonic() < deadline:
                if server_proc.poll() is not None:
                    raise RuntimeError("Server coordinator exited before readiness; inspect its preserved logs")
                info = command(["docker", "inspect", "--format", "{{.State.Running}}", server], timeout=5, check=False)
                if info.returncode == 0 and info.stdout.strip() == "true":
                    break
                time.sleep(.5)
            else:
                raise RuntimeError("Server container did not start within 30 seconds")
            ready = command(["docker", *health_args(health, server, python_image["id"])], timeout=200, check=False)
            (output / "health-console.log").write_text(ready.stdout + ready.stderr, encoding="utf-8")
            if ready.returncode:
                raise RuntimeError("Model health readiness failed; inspect preserved logs")
            report["health"] = json.loads(ready.stdout.splitlines()[-1])
            server_text = (output / "server-telemetry/console.log").read_text(encoding="utf-8", errors="replace")
            report["backendEvidence"] = backend_evidence(args.backend, server_text)
            if args.backend == "cuda":
                report["gpuOffloadEvidence"] = report["backendEvidence"]
            report["coldStartupObservedSeconds"] = time.monotonic()-start
            report["coldStartupScope"] = "Process cold, includes Docker namespace and health sidecar startup; OS file cache not flushed. GPU monitoring began at server launch and is sampled whole-device, not an exact allocation peak."
            bench.atomic_json(manifest, report)
            benchmark = [sys.executable, str(wrapper), "--name", client, "--monitor", server, "--timeout", str(args.timeout), "--output", str(output / "client-telemetry"), "--", *client_args(client, server, model_dir, inference_output, python_image["id"], args)]
            with (output / "client-coordinator.log").open("w", encoding="utf-8") as client_log:
                outcome = subprocess.run(benchmark, stdout=client_log, stderr=subprocess.STDOUT, timeout=args.timeout+60, **process_options())
            report["clientCoordinatorExitCode"] = outcome.returncode
            if outcome.returncode:
                raise RuntimeError("Inference case failed or resource admission aborted; inspect preserved logs")
            result = json.loads((inference_output / "result.json").read_text(encoding="utf-8"))
            if result.get("status") != "completed" or result.get("model", {}).get("id") != args.case or result.get("corpus", {}).get("sha256") != corpus_sha:
                raise RuntimeError("Result did not complete the requested model/corpus")
            report["status"] = "completed"
            report["summary"] = result["summary"]
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
        raise
    finally:
        # UUID names belong to this invocation only; no compose/service discovery.
        report["cleanup"]["containers"] = cleanup_owned([health, client, server])
        report["cleanup"]["allVerifiedStopped"] = all(row["verifiedStopped"] for row in report["cleanup"]["containers"])
        if not report["cleanup"]["allVerifiedStopped"]:
            report["status"] = "failed"
            report["cleanup"]["error"] = "Owned container state is unknown or still active; central coordinator must retain the resource lease"
        if server_proc is not None:
            try:
                report["serverCoordinatorExitCodeAfterOwnedStop"] = server_proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                server_proc.kill()
                server_proc.wait(timeout=10)
                report["cleanup"]["serverCoordinatorKilled"] = True
        try:
            summaries = {role: json.loads((output / (role + "-telemetry") / "telemetry-summary.json").read_text(encoding="utf-8"))
                         for role in ("server", "client")}
            report["coordinatorTelemetry"] = summaries
            validate_coordinator_telemetry(summaries)
            report["resourceAcceptance"] = True
        except (OSError, ValueError, TypeError) as exc:
            # A thermal abort can race the final successful client response.
            # Preserve completed text as evidence but do not accept the run.
            report["resourceAcceptance"] = False
            report["resourceAcceptanceError"] = type(exc).__name__ + ": " + str(exc)[:1000]
            report["status"] = "failed"
        report["finishedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        report["wallSeconds"] = time.monotonic()-start
        # Stopped server is retained for postmortem inspect/logs; never model data.
        report["cleanup"]["serverRetainedStoppedForDiagnostics"] = True
        bench.atomic_json(manifest, report)
    print(json.dumps({"status": report["status"], "output": str(output)}))
    if report["status"] != "completed":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
