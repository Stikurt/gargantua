"""Run one bounded local experiment and capture host/container telemetry.

This is a coordinator, not production scheduling. Caller supplies reviewed
Docker arguments. Only gargantua-s5-* containers can be monitored/stopped.
The actual inference container must deny network, mounts and capabilities.
"""
from __future__ import annotations
import argparse
import ctypes
import datetime
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


class MemoryStatus(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [(x, ctypes.c_ulonglong) for x in ("totalPhysical", "freePhysical", "totalPage", "freePage", "totalVirtual", "freeVirtual", "freeExtended")]


def free_memory():
    if hasattr(ctypes, "windll"):
        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)): return status.freePhysical
    return None


def command(args, timeout=8):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
        return result.returncode, result.stdout.strip()
    except subprocess.TimeoutExpired: return -1, ""


def numeric(value):
    value = value.strip()
    return float(value) if re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", value) else None


def ensure_stopped(name):
    """Verify daemon state; killing a Docker CLI is NOT container cleanup."""
    if not name.startswith("gargantua-s5-") or not name.replace("-", "").isalnum():
        raise ValueError("Refusing cleanup outside owned pilot containers")
    steps = []
    def state():
        rc, raw = command(["docker", "ps", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.ID}} {{.State}}"], 8)
        if rc: return "unknown"
        if not raw: return "absent"
        rows = raw.splitlines()
        return rows[0].split()[-1] if len(rows) == 1 else "unknown"
    observed = state()
    steps.append(observed)
    if observed in ("running", "restarting", "paused", "created"):
        command(["docker", "stop", "-t", "5", name], 15)
        observed = state()
        steps.append(observed)
    if observed in ("running", "restarting", "paused", "created"):
        command(["docker", "kill", name], 10)
        observed = state()
        steps.append(observed)
    return {"name":name,"observations":steps,"verifiedStopped":observed in ("absent", "exited", "dead")}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--name", required=True)
    p.add_argument("--monitor", action="append", default=[])
    p.add_argument("--timeout", type=int, default=1800)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("args", nargs=argparse.REMAINDER)
    args = p.parse_args()
    names = list(dict.fromkeys([args.name] + args.monitor))
    if any(not n.startswith("gargantua-s5-") or not n.replace("-", "").isalnum() for n in names): raise ValueError("Invalid owned container name")
    if not 30 <= args.timeout <= 3600: raise ValueError("Timeout outside pilot bounds")
    docker_args = args.args[1:] if args.args and args.args[0] == "--" else args.args
    if not docker_args or docker_args[0] != "run": raise ValueError("Expected Docker run arguments")
    if "--name" not in docker_args or docker_args[docker_args.index("--name")+1] != args.name:
        raise ValueError("Monitored and launched container names must match")
    if "--detach" in docker_args or "-d" in docker_args: raise ValueError("Detached execution is not monitored by this wrapper")
    if args.output.exists(): raise ValueError("Never overwrite an experiment directory")
    available = free_memory()
    if sys.platform == "win32" and available is None:
        raise RuntimeError("Host memory telemetry unavailable; refusing heavy launch")
    if available is not None and available < 1024**3:
        raise RuntimeError("Free host memory below 1 GiB; refusing heavy launch")
    args.output.mkdir(parents=True)
    telemetry = args.output / "telemetry.jsonl"
    start = time.monotonic()
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    samples, abort, low_samples, cleanup, missing_host = 0, None, 0, [], 0
    gpu_samples, missed_gpu = 0, 0
    cgroup_misses = {name:0 for name in names}
    peaks = {"gpuUsedMiB": None, "gpuTemperatureC": None, "containerMemoryPeakBytes": {}}
    with (args.output / "console.log").open("w", encoding="utf-8") as console, telemetry.open("w", encoding="utf-8") as stream:
        proc = subprocess.Popen(["docker", *docker_args], stdout=console, stderr=subprocess.STDOUT)
        try:
            while proc.poll() is None:
                now = time.monotonic()
                sample = {"seconds": round(now-start, 3), "freeHostMemoryBytes": free_memory(), "freeDiskBytes": shutil.disk_usage(args.output).free, "containers": {}}
                rc, gpu = command(["nvidia-smi", "--query-gpu=memory.used,memory.free,temperature.gpu,utilization.gpu,power.draw", "--format=csv,noheader,nounits"], 4)
                if rc == 0:
                    fields = gpu.splitlines()[0].split(",")
                    sample["gpu"] = dict(zip(("usedMiB", "freeMiB", "temperatureC", "utilizationPercent", "powerWatts"), [numeric(x) for x in fields]))
                    gpu_samples += 1
                    if sample["gpu"]["usedMiB"] is not None: peaks["gpuUsedMiB"] = max(peaks["gpuUsedMiB"] or 0, sample["gpu"]["usedMiB"])
                    if sample["gpu"]["temperatureC"] is not None: peaks["gpuTemperatureC"] = max(peaks["gpuTemperatureC"] or 0, sample["gpu"]["temperatureC"])
                    if (sample["gpu"]["temperatureC"] or 0) >= 87: abort = "GPU temperature reached 87 C"
                else: missed_gpu += 1
                for name in names:
                    rc, raw = command(["docker", "exec", name, "sh", "-c", "cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/cpu.stat"], 4)
                    if rc == 0:
                        values = raw.splitlines()
                        item = {"memoryCurrentBytes": int(values[0]), "memoryPeakBytes": int(values[1]), "cpuStat": values[2:]}
                        sample["containers"][name] = item
                        peaks["containerMemoryPeakBytes"][name] = max(peaks["containerMemoryPeakBytes"].get(name, 0), item["memoryPeakBytes"])
                    else: cgroup_misses[name] += 1
                if sample["freeHostMemoryBytes"] is not None:
                    low_samples = low_samples + 1 if sample["freeHostMemoryBytes"] < 1024**3 else 0
                    if low_samples >= 2: abort = "Free host RAM below 1 GiB on two consecutive samples"
                missing_host = missing_host + 1 if sample["freeHostMemoryBytes"] is None else 0
                if sys.platform == "win32" and missing_host >= 2: abort = "Host memory telemetry unavailable on two consecutive samples"
                if sample["freeDiskBytes"] < 10 * 1024**3: abort = "Free disk below 10 GiB"
                if now-start > args.timeout: abort = "Experiment timeout"
                stream.write(json.dumps(sample) + "\n")
                stream.flush()
                samples += 1
                if abort:
                    cleanup = [ensure_stopped(name) for name in names]
                    break
                time.sleep(1)
            try: code = proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                code = proc.wait()
                abort = abort or "Docker coordinator did not exit after stopping owned containers"
        except BaseException:
            abort = abort or "Coordinator interrupted or telemetry failed"
            cleanup = [ensure_stopped(name) for name in names]
            try: proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            raise
        finally:
            # Normal completion leaves explicitly monitored servers to their
            # parent coordinator; the main attached process must have stopped.
            cleanup = [ensure_stopped(name) for name in (names if abort else [args.name])]
            summary = {"schemaVersion": 1, "startedAtUtc": started, "finishedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "wallSeconds": time.monotonic()-start,
                       "exitCode": proc.poll(), "abort": abort, "samples": samples, "peaks": peaks,
                       "cleanup":cleanup,"cleanupVerified":all(row["verifiedStopped"] for row in cleanup),
                       "measurementAvailability":{"gpuSamples":gpu_samples,"gpuMissedSamples":missed_gpu,"cgroupMissedSamples":cgroup_misses},
                       "sampling":"Variable interval: timestamped sequential queries with timeouts plus one-second pause, not a guaranteed 1 Hz sampler.",
                       "scope": "Process-cold, OS file cache not flushed; cgroup memory includes file cache. GPU values are sampled whole-device including desktop, not exact model allocation. Sidecar/server shown separately."}
            (args.output / "telemetry-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary))
    if not summary["cleanupVerified"]: raise SystemExit(3)
    if code or abort: raise SystemExit(code or 2)


if __name__ == "__main__": main()
