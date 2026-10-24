"""Host-only, durable one-segment executor. Model containers never receive DB access.

The server worker owns approvals, leases and publishing. This daemon consumes a
short lived permit, holds an OS execution lock, and commits a fenced receipt only
after owned inference containers have verifiably stopped. A lost/expired permit
cannot produce a successful receipt. Cold starts deliberately bound v1 lifetime.
"""
from __future__ import annotations
import argparse
import contextlib
import ctypes
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid
import wave

from protocol import (ProtocolError, atomic_json, binding, canonical, digest, file_digest,
    read_json, recipe, validate_request, MAX_REQUEST_BYTES)

ROOT = Path(__file__).resolve().parent.parent
CODE = Path(__file__).resolve().parent
DEFAULT_SPOOL = ROOT / ".local/inference-spool"
RUNTIME = ROOT / ".local/inference-runtime"
LABEL = "org.gargantua.inference=derived-v1"
OWNED_PREFIX = "gargantua-derived-"


class Paused(ProtocolError):
    def __init__(self, code, message):
        super().__init__(code, message, retryable=True)


class CleanupUnknown(RuntimeError):
    pass


def now_ms():
    return int(time.time() * 1000)


def run(argv, timeout=15, check=True):
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    result = subprocess.run(argv, timeout=timeout, capture_output=True, encoding="utf-8", errors="replace", **options)
    if check and result.returncode:
        raise RuntimeError("Command failed: " + " ".join(argv[:3]) + ": " + result.stderr[-500:])
    return result


def checked_path(path, base, exists=False):
    path, base = Path(path).absolute(), Path(base).absolute()
    if path == base or not path.is_relative_to(base):
        raise ProtocolError("invalid_path", "Path outside fixed private workspace")
    current = path
    while current != base.parent:
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ProtocolError("invalid_path", "Symlink/reparse paths forbidden")
        current = current.parent
    resolved = path.resolve()
    if not resolved.is_relative_to(base.resolve()) or (exists and not resolved.exists()):
        raise ProtocolError("invalid_path", "Path missing or resolved outside fixed workspace")
    if "," in str(path) or any(ord(c) < 32 for c in str(path)):
        raise ProtocolError("invalid_path", "Mount delimiters/control characters forbidden")
    return resolved


def valid_uuid(value):
    try:
        return str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


class FileLock:
    """Cross-process byte lock; a backup also uses FileShare.None on this file."""
    def __init__(self, path):
        self.path, self.stream = Path(path), None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        try:
            if self.stream.tell() == 0:
                self.stream.write(b"\0"); self.stream.flush()
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            self.stream.close(); self.stream = None
            raise
        return self

    def __exit__(self, *_):
        if self.stream:
            if os.name == "nt":
                import msvcrt
                self.stream.seek(0); msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
            self.stream.close(); self.stream = None


class MemoryStatus(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [(x, ctypes.c_ulonglong) for x in
        ("totalPhysical", "freePhysical", "totalPage", "freePage", "totalVirtual", "freeVirtual", "freeExtended")]


def free_memory():
    if hasattr(ctypes, "windll"):
        value = MemoryStatus(); value.length = ctypes.sizeof(value)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value)):
            return value.freePhysical
    return None


def validate_permit(path, request, current_ms=None):
    current_ms = now_ms() if current_ms is None else current_ms
    try:
        permit = read_json(path, 2048)
    except (OSError, ProtocolError) as exc:
        raise Paused("permit_missing", "Server execution permit unavailable") from exc
    required = {"schemaVersion", "jobId", "segmentId", "attemptId", "expiresAt"}
    if not isinstance(permit, dict) or set(permit) != required or type(permit["schemaVersion"]) is not int or permit["schemaVersion"] != 1:
        raise Paused("permit_invalid", "Execution permit is malformed")
    if any(permit[key] != request[key] for key in ("jobId", "segmentId", "attemptId")):
        raise Paused("permit_fenced", "Server changed execution identity")
    expires = permit["expiresAt"]
    if type(expires) is not int or not current_ms < expires <= current_ms + 30000:
        raise Paused("permit_expired", "Execution permit expired or exceeds bounded lifetime")
    return permit


def resource_decision(state, current_ms):
    if (not isinstance(state, dict) or state.get("schemaVersion") != 2
        or state.get("metricsAvailable") is not True or state.get("dockerStorageKnown") is not True
        or type(state.get("updatedAt")) not in (int, float)
        or not -5000 <= current_ms - state["updatedAt"] <= 30000):
        raise Paused("metrics_unknown", "Fresh host/Docker resource metrics unavailable")
    if state.get("allowHeavy") is not True or state.get("maxHeavyJobs") != 1:
        raise Paused("resources_busy", "Host resource monitor paused heavy work")


def thermal_decision(temperature, was_hot):
    if type(temperature) not in (int, float) or not 0 <= temperature <= 120:
        return True, "gpu_metrics_unknown"
    if temperature >= 80:
        return True, "gpu_cooling"
    if was_hot and temperature > 65:
        return True, "gpu_cooling"
    return False, None


def gpu_temperature():
    result = run(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"], timeout=5, check=False)
    lines = result.stdout.strip().splitlines()
    if result.returncode or len(lines) != 1 or not re.fullmatch(r"[0-9]{1,3}", lines[0].strip()):
        return None
    return int(lines[0].strip())


def model_profile(kind):
    profiles = read_json(CODE / "profiles.json", 65536)
    row = profiles["profiles"][kind]
    implementation = {name: file_digest(CODE / name) for name in ("protocol.py", "container_worker.py", "executor.py")}
    if (row["profileSha256"] != digest(row["descriptor"]) or row["descriptor"]["recipe"] != recipe(kind)
        or row.get("providerRecipeSha256") != digest(recipe(kind))
        or row["descriptor"].get("implementation") != implementation):
        raise ProtocolError("profile_changed", "Selected profile descriptor differs from runtime recipe")
    return row


def verified_artifacts(kind):
    lock = read_json(CODE / "profiles.lock.json", 262144)
    profile = lock[kind]
    descriptor = model_profile(kind)["descriptor"]
    if (profile["id"] != descriptor["id"] or profile["modelId"] != descriptor["modelId"]
        or profile["image"] != descriptor["runtimeImage"]
        or profile.get("clientImage") != descriptor.get("clientImage")
        or digest(profile["files"]) != descriptor["artifactManifestSha256"]):
        raise ProtocolError("profile_changed", "Model/runtime admission differs from selected profile digest")
    root = checked_path(ROOT / profile["modelRoot"], ROOT / ".local", exists=True)
    checked = []
    for item in profile["files"]:
        path = checked_path(root / item["path"], root, exists=True)
        if not path.is_file() or path.stat().st_size != item["bytes"] or file_digest(path) != item["sha256"]:
            raise ProtocolError("artifact_changed", "Selected model artifact no longer matches reviewed admission")
        checked.append(item)
    return profile, root, checked


def require_images(profile):
    for image in dict.fromkeys([profile["image"], *([profile["clientImage"]] if "clientImage" in profile else [])]):
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
            raise ProtocolError("profile_changed", "Runtime image must be immutable local SHA256")
        inspected = run(["docker", "image", "inspect", image, "--format", "{{.Id}}"], timeout=15, check=False)
        if inspected.returncode or inspected.stdout.strip() != image:
            raise ProtocolError("runtime_unavailable", "Reviewed local runtime missing; no automatic image pull", True)


def restrictions(name, memory, cpus):
    if not re.fullmatch(OWNED_PREFIX + r"[a-z0-9-]+", name):
        raise ValueError("Invalid owned container name")
    return ["--name", name, "--label", LABEL, "--read-only", "--user", "1000:1000",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", memory,
        "--memory-swap", memory, "--cpus", str(cpus), "--pids-limit", "128",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
        "--env", "HOME=/tmp", "--env", "PYTHONDONTWRITEBYTECODE=1",
        "--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1",
        "--env", "OMP_NUM_THREADS=2", "--env", "OPENBLAS_NUM_THREADS=2", "--env", "MKL_NUM_THREADS=2"]


def mount(source, target, readonly=True):
    if "," in str(source) or any(ord(c) < 32 for c in str(source)):
        raise ValueError("Invalid bind mount path")
    return ["--mount", f"type=bind,source={source},target={target}" + (",readonly" if readonly else "")]


def server_command(name, model_root, image):
    return ["docker", "run", "--detach", *restrictions(name, "5g", 6), "--network", "none",
        "--gpus", "all", *mount(model_root / "Qwen3.5-4B-Q4_K_M.gguf", "/model.gguf"),
        "--entrypoint", "/app/llama-server", image, "--model", "/model.gguf", "--host", "127.0.0.1",
        "--port", "8080", "--ctx-size", "2048", "--batch-size", "256", "--ubatch-size", "128",
        "--parallel", "1", "--threads", "6", "--n-gpu-layers", "99", "--jinja", "--verbosity", "4",
        "--cache-ram", "256", "--ctx-checkpoints", "2", "--no-context-shift"]


def client_command(name, request_file, output, profile, model_root, server=None, health=False):
    image = profile["clientImage"] if server else profile["image"]
    args = ["docker", "run", *restrictions(name, "256m" if server else "2g", 2),
        "--ulimit", "fsize=8388608:8388608",
        "--network", "container:" + server if server else "none", *mount(CODE, "/worker")]
    if not health:
        args += [*mount(request_file, "/input.json"), *mount(output, "/output", False)]
        if not server:
            args += mount(model_root, "/models")
    args += ["--entrypoint", "python", image, "/worker/container_worker.py"]
    return args + (["--health"] if health else ["--request", "/input.json", "--output", "/output"])


def container_state(name):
    try:
        result = run(["docker", "ps", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.Names}} {{.State}}"], check=False)
    except Exception:
        return "unknown"
    if result.returncode:
        return "unknown"
    rows = result.stdout.strip().splitlines()
    if not rows:
        return "absent"
    if len(rows) != 1 or rows[0].split()[0] != name:
        return "unknown"
    return rows[0].split()[-1]


def stop_owned(name):
    if not re.fullmatch(OWNED_PREFIX + r"[a-z0-9-]+", name):
        raise ValueError("Refusing foreign container cleanup")
    state = container_state(name)
    if state not in ("absent", "exited", "dead", "unknown"):
        try:
            run(["docker", "stop", "-t", "3", name], timeout=12, check=False)
        except Exception:
            pass
        state = container_state(name)
    if state not in ("absent", "exited", "dead", "unknown"):
        try:
            run(["docker", "kill", name], timeout=10, check=False)
        except Exception:
            pass
        state = container_state(name)
    return {"name": name, "verifiedStopped": state in ("absent", "exited", "dead"), "state": state}


def remove_committed_containers(spool, attempt_id, names):
    """Remove only our exited containers after a durable fenced cleanup receipt.

    No volume/image deletion, wildcard cleanup, arbitrary names, or running state.
    A failed removal is retried at daemon startup; it never erases stop evidence.
    """
    if not valid_uuid(attempt_id):
        raise ValueError("Container retirement requires canonical attempt UUID")
    receipt = None
    for path in (spool / "output" / attempt_id / "result.json", spool / "retired" / (attempt_id + ".json")):
        try:
            candidate = read_json(path, 65536)
            if (candidate.get("attemptId") == attempt_id and candidate.get("cleanupVerified") is True
                and candidate.get("status") in ("completed", "paused", "failed")):
                receipt = candidate; break
        except (OSError, ProtocolError):
            pass
    if receipt is None:
        return []
    suffix = attempt_id.replace("-", "")
    expected = {OWNED_PREFIX + role + "-" + suffix for role in ("mt", "health", "client", "tts")}
    outcomes = []
    for name in names:
        if name not in expected:
            continue
        try:
            inspected = run(["docker", "inspect", name, "--format", "{{json .}}"], timeout=8, check=False)
            if inspected.returncode:
                outcomes.append({"name": name, "removed": container_state(name) == "absent"}); continue
            item = json.loads(inspected.stdout)
            if (item.get("Name") != "/" + name or item.get("Config", {}).get("Labels", {}).get("org.gargantua.inference") != "derived-v1"
                or item.get("State", {}).get("Status") != "exited"):
                outcomes.append({"name": name, "removed": False}); continue
            removed = run(["docker", "rm", name], timeout=15, check=False)
            outcomes.append({"name": name, "removed": removed.returncode == 0 and container_state(name) == "absent"})
        except Exception:
            outcomes.append({"name": name, "removed": False})
    return outcomes


def retire_committed_orphans(spool, stopped):
    grouped = {}
    for row in stopped:
        match = re.fullmatch(OWNED_PREFIX + r"(?:mt|health|client|tts)-([a-f0-9]{32})", row["name"])
        if match and row["verifiedStopped"]:
            attempt = str(uuid.UUID(match[1]))
            grouped.setdefault(attempt, []).append(row["name"])
    for attempt, names in grouped.items():
        remove_committed_containers(spool, attempt, names)


def reap_owned():
    result = run(["docker", "ps", "-a", "--filter", "label=" + LABEL, "--format", "{{.Names}}"], check=False)
    if result.returncode:
        raise CleanupUnknown("Docker state unavailable during startup cleanup")
    rows = []
    for name in result.stdout.strip().splitlines():
        if not re.fullmatch(OWNED_PREFIX + r"[a-z0-9-]+", name):
            raise CleanupUnknown("Unexpected labeled container identity")
        row = stop_owned(name); rows.append(row)
        if not row["verifiedStopped"]:
            raise CleanupUnknown("Startup cleanup could not verify stopped containers")
    return rows


class Guard:
    def __init__(self, request, permit, runtime):
        self.request, self.permit, self.runtime = request, permit, runtime
        self.next_metrics = 0
        self.last_sample = None

    def check(self, boundary=False, force=False):
        if stop_requested():
            raise Paused("executor_stopping", "Host executor is stopping safely")
        validate_permit(self.permit, self.request)
        if time.monotonic() < self.next_metrics and not boundary and not force:
            return
        self.next_metrics = time.monotonic() + 4
        try:
            state = read_json(ROOT / ".local/runtime/resources.json", 16384)
        except (OSError, ProtocolError) as exc:
            raise Paused("metrics_unknown", "Resource monitor unavailable") from exc
        resource_decision(state, now_ms())
        free = free_memory()
        if free is None:
            raise Paused("metrics_unknown", "Host RAM measurement unavailable")
        if free < 1024**3:
            raise Paused("resources_busy", "Free host RAM below 1 GiB")
        if shutil.disk_usage(self.runtime).free < 10 * 1024**3:
            raise Paused("resources_busy", "Free host disk below 10 GiB")
        temperature = None
        if self.request["kind"] == "translation":
            temperature = gpu_temperature()
            if temperature is None:
                self.write_thermal(True, None)
                raise Paused("gpu_metrics_unknown", "GPU temperature unavailable")
            if temperature >= 87:
                self.write_thermal(True, temperature)
                raise Paused("gpu_hard_limit", "GPU reached hard stop 87 C")
            if boundary:
                hot = False
                thermal = self.runtime.parent.parent / "thermal.json"
                if thermal.exists():
                    saved = read_json(thermal, 2048)
                    if type(saved.get("cooling")) is not bool:
                        raise Paused("gpu_metrics_unknown", "Persisted thermal state invalid")
                    hot = saved["cooling"]
                pause, reason = thermal_decision(temperature, hot)
                self.write_thermal(pause, temperature)
                if pause:
                    raise Paused(reason, "GPU cooling: new segment waits until 65 C")
            elif temperature >= 80:
                self.write_thermal(True, temperature)
        self.last_sample = {"at": now_ms(), "freeHostMemoryBytes": free, "gpuTemperatureC": temperature}
        with (self.runtime / "telemetry.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(self.last_sample) + "\n")

    def write_thermal(self, cooling, temperature):
        atomic_json(self.runtime.parent.parent / "thermal.json", {"schemaVersion": 1,
            "cooling": cooling, "temperatureC": temperature, "updatedAt": now_ms()})


def monitored(command, name, guard, logs, timeout=240):
    started = time.monotonic()
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    with logs.open("w", encoding="utf-8") as console:
        process = subprocess.Popen(command, stdout=console, stderr=subprocess.STDOUT, **options)
        try:
            while process.poll() is None:
                guard.check()
                if time.monotonic() - started >= timeout:
                    raise Paused("segment_timeout", "Bounded segment execution timed out")
                time.sleep(.5)
            return process.wait()
        finally:
            stopped = stop_owned(name)
            if process.poll() is None:
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=5)
            if not stopped["verifiedStopped"]:
                raise CleanupUnknown("Could not verify bounded inference stopped")


def start_server(command, name, guard, logs):
    """Monitor even a blocked Docker --detach invocation; keep only success alive."""
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    success = False
    with logs.open("w", encoding="utf-8") as console:
        process = subprocess.Popen(command, stdout=console, stderr=subprocess.STDOUT, **options)
        started = time.monotonic()
        try:
            while process.poll() is None:
                guard.check()
                if time.monotonic() - started >= 30:
                    raise Paused("launch_timeout", "Docker model launch timed out")
                time.sleep(.5)
            if process.wait():
                raise ProtocolError("provider_unavailable", "Pinned GPU runtime failed to launch", True)
            success = True
        finally:
            if not success:
                stopped = stop_owned(name)
                if process.poll() is None:
                    try: process.wait(timeout=10)
                    except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
                if not stopped["verifiedStopped"]:
                    raise CleanupUnknown("Uncertain GPU server launch cleanup")


def verify_result(result, request, sandbox, request_sha=None):
    if (result.get("status") != "completed" or any(result.get(key) != value for key, value in binding(request).items())
        or result.get("requestSha256") != request_sha or result.get("providerRecipeSha256") != digest(recipe(request["kind"]))):
        raise ProtocolError("provider_protocol", "Inference receipt differs from exact request/profile")
    artifact = result.get("artifact", {})
    expected = "text.txt" if request["kind"] == "translation" else "audio.wav"
    maximum = 25600 if expected == "text.txt" else 8 * 1024**2
    if (artifact.get("filename") != expected or type(artifact.get("bytes")) is not int
        or not 1 <= artifact["bytes"] <= maximum
        or artifact.get("mime") != ("text/plain; charset=utf-8" if expected == "text.txt" else "audio/wav")
        or result.get("qualityStatus") != ("MACHINE_DRAFT" if expected == "text.txt" else "NOT_LISTENED")
        or result.get("semanticGuarantee") is not False):
        raise ProtocolError("provider_protocol", "Invalid bounded artifact descriptor")
    path = checked_path(sandbox / expected, sandbox, exists=True)
    if path.stat().st_size != artifact["bytes"] or file_digest(path) != artifact.get("sha256"):
        raise ProtocolError("provider_protocol", "Output artifact hash/size mismatch")
    if expected == "text.txt":
        text = path.read_text(encoding="utf-8")
        if not 1 <= len(text) <= 6400 or any(ord(c) < 32 and c not in "\r\n\t" for c in text):
            raise ProtocolError("quality_rejected", "Invalid plaintext artifact")
    else:
        with wave.open(str(path), "rb") as reader:
            if (reader.getnchannels() != 1 or reader.getsampwidth() != 2 or reader.getframerate() != 22050
                or reader.getcomptype() != "NONE" or not 4410 <= reader.getnframes() <= 22050 * 180
                or path.stat().st_size != 44 + reader.getnframes() * 2):
                raise ProtocolError("quality_rejected", "WAV is not bounded canonical mono PCM16")
            if len(reader.readframes(reader.getnframes() + 1)) != reader.getnframes() * 2:
                raise ProtocolError("quality_rejected", "WAV body truncated")
    return path


def container_exit(name):
    try:
        result = run(["docker", "inspect", name, "--format", "{{json .State}}"], timeout=8, check=False)
        state = json.loads(result.stdout) if result.returncode == 0 else {}
        return {"name": name, "status": state.get("Status"), "exitCode": state.get("ExitCode"),
                "oomKilled": state.get("OOMKilled")}
    except Exception:
        return {"name": name, "status": "unknown", "exitCode": None, "oomKilled": None}


def validate_terminal_exits(rows, server):
    for row in rows:
        allowed = (0, 143) if row["name"] == server else (0,)
        if (row["status"] != "exited" or type(row["exitCode"]) is not int
            or row["exitCode"] not in allowed or row["oomKilled"] is not False):
            raise ProtocolError("runtime_late_failure", "A provider exited abnormally or lacks terminal exit/OOM proof", True)


def process_attempt(spool, attempt_id, runtime_root=RUNTIME):
    if not valid_uuid(attempt_id):
        raise ProtocolError("invalid_request", "Attempt directory must be canonical UUID")
    incoming = checked_path(spool / "incoming" / attempt_id, spool, exists=True)
    request_path = checked_path(incoming / "input.json", incoming, exists=True)
    permit_path = checked_path(incoming / "permit.json", incoming, exists=True)
    output = checked_path(spool / "output" / attempt_id, spool)
    if (output / "result.json").exists():
        return read_json(output / "result.json", 65536)
    request = validate_request(read_json(request_path))
    if request["attemptId"] != attempt_id:
        raise ProtocolError("invalid_request", "Request attempt does not match immutable spool path")
    profile_row = model_profile(request["kind"])
    if request["profileSha256"] != profile_row["profileSha256"]:
        raise ProtocolError("profile_changed", "Requested profile digest is unavailable")
    runtime = runtime_root / "attempts" / attempt_id
    if runtime.exists():
        # Startup has already reaped all labeled containers under execution.lock.
        # A missing final receipt after host crash never makes partial output valid.
        output.mkdir(parents=True, exist_ok=True)
        recovered = {"schemaVersion": 1, **binding(request), "requestSha256": file_digest(request_path),
            "providerRecipeSha256": digest(recipe(request["kind"])), "status": "paused",
            "code": "interrupted_before_commit", "message": "Prior host attempt ended before a committed receipt",
            "retryable": True, "cleanupVerified": True, "cleanup": [], "finishedAt": now_ms()}
        atomic_json(output / "result.json", recovered)
        return recovered
    runtime.mkdir(parents=True, exist_ok=False)
    output.mkdir(parents=True, exist_ok=True)
    sandbox = output / "sandbox"; sandbox.mkdir(exist_ok=False)
    # The trusted snapshot, not worker-writable incoming JSON, is the sole model input.
    snapshot = runtime / "input.json"
    with request_path.open("rb") as source:
        raw_request = source.read(MAX_REQUEST_BYTES + 1)
    if len(raw_request) > MAX_REQUEST_BYTES:
        raise ProtocolError("invalid_request", "Spool source grew beyond byte bound")
    with snapshot.open("xb") as target:
        target.write(raw_request); target.flush(); os.fsync(target.fileno())
    # Reject concurrent source edits between validation and the trusted snapshot.
    if read_json(snapshot) != request:
        raise ProtocolError("invalid_request", "Spool source changed while being snapshotted")
    request_sha = file_digest(snapshot)
    guard = Guard(request, permit_path, runtime)
    names, cleanup, failure, result, server = [], [], None, None, None
    receipt = {"schemaVersion": 1, **binding(request), "requestSha256": request_sha,
        "providerRecipeSha256": digest(recipe(request["kind"])), "startedAt": now_ms(),
        "status": "failed", "antivirusStatus": "NOT_FULLY_SCANNED",
        "codeHashes": {p.name: file_digest(p) for p in sorted(CODE.glob("*.py"))}}
    try:
        guard.check(boundary=True)
        profile, model_root, artifacts = verified_artifacts(request["kind"])
        require_images(profile)
        guard.check(boundary=True)
        receipt["artifacts"] = {"manifestSha256": file_digest(CODE / "profiles.lock.json"),
            "artifactManifestSha256": digest(artifacts), "filesCount": len(artifacts),
            "totalBytes": sum(item["bytes"] for item in artifacts),
            "weights": [item for item in artifacts if item["path"].endswith((".gguf", ".onnx"))]}
        receipt["runtimeImage"] = profile["image"]
        receipt["profileDescriptor"] = profile_row["descriptor"]
        suffix = attempt_id.replace("-", "")
        if request["kind"] == "translation":
            server = OWNED_PREFIX + "mt-" + suffix
            names.append(server)
            start_server(server_command(server, model_root, profile["image"]), server, guard, runtime / "launch.log")
            health = OWNED_PREFIX + "health-" + suffix; names.append(health)
            health_exit = monitored(client_command(health, snapshot, sandbox, profile, model_root, server, True),
                health, guard, runtime / "health.log", 210)
            if health_exit:
                raise ProtocolError("provider_unavailable", "Pinned translation runtime did not become ready", True)
            logs = run(["docker", "logs", server], timeout=10, check=False).stdout
            offloads = re.findall(r"offloaded\s+(\d+)/(\d+)\s+layers to GPU", logs)
            # llama-server writes startup diagnostics to stderr, not stdout.
            if not offloads:
                log_result = run(["docker", "logs", server], timeout=10, check=False)
                logs += log_result.stderr
                offloads = re.findall(r"offloaded\s+(\d+)/(\d+)\s+layers to GPU", logs)
            if not offloads or int(offloads[-1][0]) <= 0 or offloads[-1][0] != offloads[-1][1]:
                raise ProtocolError("gpu_offload_missing", "Full GPU offload not confirmed; no automatic CPU fallback", True)
            # Model warm-up can heat the device before its first source segment.
            guard.check(boundary=True)
            client = OWNED_PREFIX + "client-" + suffix; names.append(client)
            code = monitored(client_command(client, snapshot, sandbox, profile, model_root, server),
                client, guard, runtime / "client.log", 240)
            receipt["clientImage"] = profile["clientImage"]
        else:
            client = OWNED_PREFIX + "tts-" + suffix; names.append(client)
            code = monitored(client_command(client, snapshot, sandbox, profile, model_root),
                client, guard, runtime / "client.log", 240)
        guard.check(force=True)
        result = read_json(sandbox / "inference.json", 65536)
        if result.get("status") != "completed":
            raise ProtocolError(result.get("code", "provider_error"), result.get("message", "Provider failed"), bool(result.get("retryable")))
        if code:
            raise ProtocolError("provider_error", "Provider exit was not successful", True)
        artifact = verify_result(result, request, sandbox, request_sha)
        validate_permit(permit_path, request)
        allowed_metadata = {"artifact", "promptSha256", "inputTokens", "outputTokens", "finishReason",
            "inferenceSeconds", "qualityStatus", "qualityFlags", "semanticGuarantee", "durationSeconds",
            "sampleRate", "frames", "signalIntegrity"}
        receipt.update({key: result[key] for key in allowed_metadata if key in result})
        receipt["status"] = "completed"
    except ProtocolError as exc:
        failure = exc
        receipt.update(status="paused" if isinstance(exc, Paused) else "failed", code=exc.code,
                       message=str(exc)[:400], retryable=exc.retryable)
    except Exception as exc:
        failure = exc
        receipt.update(status="failed", code="executor_error", message=type(exc).__name__ + ": " + str(exc)[:300], retryable=True)
    finally:
        for name in reversed(names):
            cleanup.append(stop_owned(name))
        receipt["cleanup"] = cleanup
        receipt["cleanupVerified"] = all(row["verifiedStopped"] for row in cleanup)
        if not receipt["cleanupVerified"] or isinstance(failure, CleanupUnknown):
            atomic_json(runtime / "blocked.json", {**receipt, "status": "blocked_cleanup"})
            raise CleanupUnknown("Inference cleanup uncertain; execution lock must remain held")
    if receipt["status"] == "completed":
        try:
            receipt["terminalExits"] = [container_exit(name) for name in names]
            validate_terminal_exits(receipt["terminalExits"], server)
            guard.check(force=True)
            artifact = verify_result(result, request, sandbox, request_sha)
            final = output / artifact.name
            with artifact.open("rb") as source, final.open("xb") as target:
                shutil.copyfileobj(source, target, 1024 * 1024); target.flush(); os.fsync(target.fileno())
            if file_digest(final) != result["artifact"]["sha256"]:
                raise ProtocolError("artifact_changed", "Promoted artifact changed")
            validate_permit(permit_path, request)
        except ProtocolError as exc:
            receipt.update(status="paused" if isinstance(exc, Paused) else "failed", code=exc.code,
                           message=str(exc), retryable=exc.retryable)
            receipt.pop("artifact", None)
        except Exception as exc:
            receipt.update(status="failed", code="promotion_failed", message=type(exc).__name__ + ": " + str(exc)[:300], retryable=True)
            receipt.pop("artifact", None)
    receipt["finishedAt"] = now_ms()
    atomic_json(output / "result.json", receipt)
    atomic_json(runtime / "container-retirement.json", {"attemptId": attempt_id,
        "containers": remove_committed_containers(spool, attempt_id, names), "updatedAt": now_ms()})
    return receipt


def daemon_state(state, **extra):
    try:
        atomic_json(RUNTIME / "daemon.json", {"schemaVersion": 1, "pid": os.getpid(),
            "state": state, "updatedAt": now_ms(), **extra})
        return True
    except OSError as exc:
        warn_io("state_publication_failed", exc)
        return False


def warn_io(event, exc):
    try:
        print(json.dumps({"event": event, "at": now_ms(), "error": type(exc).__name__,
            "winerror": getattr(exc, "winerror", None), "errno": getattr(exc, "errno", None)}), file=sys.stderr, flush=True)
    except OSError:
        pass


def stop_requested():
    path = RUNTIME / "stop.json"
    if not path.exists():
        return False
    try:
        row = read_json(path, 2048)
    except (OSError, ProtocolError):
        return True  # An unreadable explicit stop fence fails closed.
    return row.get("pid") == os.getpid()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spool", type=Path, default=DEFAULT_SPOOL)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    spool = checked_path(args.spool, ROOT / ".local")
    spool.mkdir(parents=True, exist_ok=True)
    (spool / "incoming").mkdir(exist_ok=True); (spool / "output").mkdir(exist_ok=True)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with FileLock(RUNTIME / "daemon.lock"):
        with FileLock(RUNTIME / "execution.lock"):
            retire_committed_orphans(spool, reap_owned())
        while True:
            if stop_requested():
                if daemon_state("stopped", cleanupVerified=True):
                    return
                time.sleep(1); continue
            if not daemon_state("idle", cleanupVerified=True):
                # No new model may start until the fresh status is durable.
                # The previous status is untouched, eventually becomes stale,
                # and keeps the worker/backup admission conservative.
                time.sleep(1); continue
            try:
                candidates = sorted((spool / "incoming").iterdir(), key=lambda p: p.name)
            except OSError as exc:
                warn_io("spool_read_failed", exc); time.sleep(1); continue
            acted = False
            for path in candidates:
                if not valid_uuid(path.name) or not path.is_dir() or not (path / "permit.json").is_file():
                    continue
                if (spool / "output" / path.name / "result.json").exists() or (RUNTIME / ("invalid-" + path.name + ".json")).exists():
                    continue
                try:
                    execution = FileLock(RUNTIME / "execution.lock")
                    execution.__enter__()
                except OSError:
                    break  # Backup/other owner holds the execution barrier.
                try:
                    if not daemon_state("running", attemptId=path.name, cleanupVerified=False):
                        # Still no model was started; release only the empty
                        # execution barrier and retry once status can commit.
                        time.sleep(1); continue
                    result = process_attempt(spool, path.name)
                    print(json.dumps({"attemptId": path.name, "status": result["status"], "code": result.get("code")}), flush=True)
                    acted = True
                except CleanupUnknown as exc:
                    daemon_state("blocked_cleanup", attemptId=path.name, cleanupVerified=False, message=str(exc))
                    # Do not release the backup barrier while Docker state is unknown.
                    while True:
                        time.sleep(5)
                        try:
                            reap_owned(); break
                        except Exception:
                            pass
                    daemon_state("idle", cleanupVerified=True)
                except Exception as exc:
                    daemon_state("request_error", attemptId=path.name, cleanupVerified=True,
                        message=type(exc).__name__ + ": " + str(exc)[:300])
                    # Invalid untrusted spool data never starts a model; quarantine the
                    # directory identity locally so one bad request cannot spin forever.
                    if isinstance(exc, OSError):
                        # An IO failure after verified cleanup is retryable. A
                        # later pass recovers the uncommitted runtime attempt;
                        # it must not be mislabeled a permanent invalid input.
                        warn_io("attempt_io_failed", exc); time.sleep(1); continue
                    try:
                        atomic_json(RUNTIME / ("invalid-" + path.name + ".json"), {"attemptId": path.name, "error": str(exc)[:300]})
                    except OSError as write_error:
                        warn_io("rejection_publication_failed", write_error); time.sleep(1); continue
                    rejected = {"schemaVersion": 1, "attemptId": path.name, "status": "failed",
                        "code": "invalid_request", "message": "Invalid or unavailable bounded request",
                        "retryable": False, "cleanupVerified": True, "cleanup": [], "finishedAt": now_ms()}
                    try:
                        raw = read_json(path / "input.json")
                        for key in ("jobId", "segmentId", "kind", "profile", "profileSha256", "recipeSha256", "inputSha256"):
                            if isinstance(raw.get(key), str) and len(raw[key]) <= 96:
                                rejected[key] = raw[key]
                        rejected["requestSha256"] = file_digest(path / "input.json")
                        rejected_output = checked_path(spool / "output" / path.name, spool)
                        rejected_output.mkdir(parents=True, exist_ok=True)
                        if not (rejected_output / "result.json").exists():
                            atomic_json(rejected_output / "result.json", rejected)
                    except Exception:
                        pass
                    acted = True
                finally:
                    execution.__exit__(None, None, None)
                if args.once:
                    break
            if args.once:
                if daemon_state("idle", cleanupVerified=True):
                    return
                time.sleep(1); continue
            time.sleep(.5 if acted else 1)


if __name__ == "__main__":
    main()
