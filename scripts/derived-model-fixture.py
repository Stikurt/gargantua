"""Explicit disposable PostgreSQL/library harness; never touches production DB/books.

Run phase requires the human/root coordinator's exclusive heavy-slot grant. The
fixture remains retained for backup/restore validation; there is no delete mode.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / ".local/s5-queue"
STATE = BASE / "active.json"
DB = "gargantua-s5-queue-db"
PG = "postgres:17-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27"
ALPINE = "alpine:3.22@sha256:d406446bc05b82480756ce8f1287964d28768c23955fa9480d2a74a2eae7a654"


def call(args, check=True, timeout=60):
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    result = subprocess.run(args, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout, **options)
    if check and result.returncode:
        raise RuntimeError("Fixture operation failed: " + " ".join(args[:3]) + ": " + result.stderr[-1000:])
    return result


def labels(token):
    return ["--label", "org.gargantua.fixture=s5-local-model-queue-v1", "--label", "org.gargantua.fixture-token=" + token]


def checked_state():
    value = json.loads(STATE.read_text(encoding="utf-8"))
    if (value["databaseContainer"] != DB or len(value["runToken"]) != 32
        or not all(c in "0123456789abcdef" for c in value["runToken"])
        or any(not value[k].startswith("gargantua_s5_queue_") for k in ("databaseVolume", "libraryVolume"))):
        raise ValueError("Fixture ownership state invalid")
    inspected = json.loads(call(["docker", "inspect", DB]).stdout)[0]
    if inspected["Config"]["Labels"].get("org.gargantua.fixture-token") != value["runToken"]:
        raise ValueError("Fixture database ownership mismatch")
    return value


def record_host_proof(value):
    report_path = Path(value["reports"]) / "model-queue-report.json"
    if not report_path.exists():
        return None
    remaining = call(["docker", "ps", "-a", "--filter", "label=org.gargantua.inference=derived-v1", "--format", "{{.Names}} {{.State}}"], timeout=15).stdout.strip().splitlines()
    daemon = json.loads((ROOT / ".local/inference-runtime/daemon.json").read_text(encoding="utf-8"))
    proof = {"checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "modelContainersRemaining": len(remaining), "containers": remaining,
        "daemonState": daemon.get("state"), "hostCleanupVerified": daemon.get("cleanupVerified") is True}
    report = json.loads(report_path.read_text(encoding="utf-8")); report["hostPostcondition"] = proof
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (Path(value["reports"]) / "host-proof.json").write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
    if remaining or daemon.get("cleanupVerified") is not True or daemon.get("state") != "idle":
        raise RuntimeError("Live fixture completed but model cleanup/idle postcondition is not confirmed")
    return proof


def archive():
    value = checked_state()
    token = value["runToken"]
    renamed = {}
    for role in ("db", "seed", "live-prefix", "live", "verify", "init"):
        name = "gargantua-s5-queue-" + role
        inspected = call(["docker", "container", "inspect", name], check=False)
        if inspected.returncode:
            continue
        row = json.loads(inspected.stdout)[0]
        if (row["Config"]["Labels"].get("org.gargantua.fixture-token") != token
            or row["Config"]["Labels"].get("org.gargantua.fixture") != "s5-local-model-queue-v1"
            or row["State"]["Running"] or row["State"]["Status"] not in ("exited", "created")):
            raise ValueError("Only this exact stopped fixture's containers may be archived")
        target = name + "-old-" + token[:8]
        if call(["docker", "container", "inspect", target], check=False).returncode == 0:
            raise ValueError("Archive container name already exists; nothing overwritten")
        call(["docker", "rename", name, target]); renamed[name] = target
    archived = {**value, "archivedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "renamedContainers": renamed}
    target = BASE / ("archived-" + token + ".json")
    if target.exists():
        raise ValueError("Archive ownership record already exists")
    target.write_text(json.dumps(archived, indent=2) + "\n", encoding="utf-8")
    STATE.unlink()
    print(json.dumps({"status": "archived-without-deletion", "record": str(target), "renamedContainers": renamed,
        "preservedVolumes": [value["databaseVolume"], value["libraryVolume"]]}))


def setup():
    if STATE.exists():
        print(json.dumps({"status": "retained-existing-fixture", **checked_state()})); return
    if call(["docker", "container", "inspect", DB], check=False).returncode == 0:
        raise ValueError("Reserved fixture DB name already exists without this run's ownership state")
    token = uuid.uuid4().hex
    directory = BASE / token; directory.mkdir(parents=True)
    reports = directory / "reports"; reports.mkdir()
    database_volume, library_volume = "gargantua_s5_queue_db_" + token[:8], "gargantua_s5_queue_library_" + token[:8]
    admin_password, app_password = secrets.token_hex(32), secrets.token_hex(32)
    database_env, runner_env = directory / "database.env", directory / "runner.env"
    database_env.write_text("POSTGRES_DB=library\nPOSTGRES_USER=cotology_admin\nPOSTGRES_PASSWORD=" + admin_password + "\nCOTOLOGY_ADMIN_PASSWORD=" + admin_password + "\nCOTOLOGY_APP_PASSWORD=" + app_password + "\n", encoding="utf-8")
    runner_env.write_text("DATABASE_URL=postgres://cotology_app:" + app_password + "@" + DB + ":5432/library\nGARGANTUA_MODEL_LIVE=1\nCLAM_HOST=clamav\nCLAM_PORT=3310\n", encoding="utf-8")
    image = call(["docker", "image", "inspect", "cotology-app:core-next", "--format", "{{.Id}}"], timeout=15).stdout.strip()
    if not image.startswith("sha256:") or len(image) != 71:
        raise ValueError("Fixture app runtime missing immutable image identity")
    for volume in (database_volume, library_volume):
        call(["docker", "volume", "create", *labels(token), volume])
    call(["docker", "run", "--rm", "--name", "gargantua-s5-queue-init", *labels(token), "--network", "none",
        "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
        "--mount", f"type=volume,source={library_volume},target=/library", ALPINE,
        "sh", "-c", "mkdir -p /library/books /library/derived && chown -R 1000:1000 /library && chmod 700 /library"])
    started = call(["docker", "run", "--detach", "--name", DB, *labels(token), "--network", "cotology_data", "--memory", "256m", "--memory-swap", "256m", "--cpus", "0.5", "--pids-limit", "128",
        "--env-file", str(database_env), "--mount", f"type=volume,source={database_volume},target=/var/lib/postgresql/data",
        "--mount", f"type=bind,source={ROOT / 'ops/10-roles.sh'},target=/docker-entrypoint-initdb.d/10-roles.sh,readonly", PG])
    value = {"schemaVersion": 1, "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "runToken": token,
        "databaseContainer": DB, "databaseContainerId": started.stdout.strip(), "databaseVolume": database_volume,
        "libraryVolume": library_volume, "directory": str(directory), "reports": str(reports), "imageId": image}
    STATE.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        probe = call(["docker", "exec", DB, "psql", "-U", "cotology_admin", "-d", "library", "-Atc", "SELECT count(*) FROM pg_roles WHERE rolname='cotology_app'"], check=False, timeout=8)
        if probe.returncode == 0 and probe.stdout.strip() == "1":
            print(json.dumps({"status": "ready", **value})); return
        time.sleep(1)
    raise RuntimeError("Disposable fixture PostgreSQL did not finish initialization")


def phase(action, checkpoint_stop):
    value = checked_state()
    if action == "run" and os.environ.get("GARGANTUA_EXCLUSIVE_MODEL_SLOT") != "1":
        raise ValueError("Model run requires the root coordinator's explicit exclusive-slot grant")
    name = "gargantua-s5-queue-" + ("live-prefix" if action == "run" and checkpoint_stop else "live" if action == "run" else action)
    if call(["docker", "container", "inspect", name], check=False).returncode == 0:
        raise ValueError("Fixture phase container already retained; inspect its result before a new run")
    command = ["docker", "run", "--name", name, *labels(value["runToken"]), "--network", "cotology_data", "--read-only", "--user", "1000:1000",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "384m", "--memory-swap", "384m", "--cpus", "1", "--pids-limit", "128",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m", "--env-file", str(Path(value["directory"]) / "runner.env")]
    if checkpoint_stop: command += ["--env", "GARGANTUA_STOP_AFTER_CHECKPOINTS=" + str(checkpoint_stop)]
    for source, target, ro, kind in ((value["libraryVolume"], "/library", False, "volume"),
        (ROOT / ".local/inference-spool", "/inference-spool", False, "bind"),
        (ROOT / ".local/inference-runtime", "/inference-runtime", True, "bind"),
        (ROOT / ".local/runtime", "/resources", True, "bind"),
        (value["reports"], "/fixture-report", False, "bind"),
        (ROOT / "server", "/app/server", True, "bind"),
        (ROOT / "tests/derived-model-live.integration.mjs", "/app/tests/derived-model-live.integration.mjs", True, "bind")):
        command += ["--mount", f"type={kind},source={source},target={target}" + (",readonly" if ro else "")]
    command += ["--entrypoint", "node", value["imageId"], "tests/derived-model-live.integration.mjs", "--phase", action]
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    completed = subprocess.run(command, **options)
    if completed.returncode:
        raise SystemExit(completed.returncode)
    if action in ("run", "verify") and not checkpoint_stop:
        record_host_proof(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("setup", "seed", "run", "verify", "status", "archive"))
    parser.add_argument("--checkpoint-stop", type=int, default=0, choices=range(0, 101))
    args = parser.parse_args()
    if args.action == "setup": setup()
    elif args.action == "archive": archive()
    elif args.action == "status":
        value = checked_state()
        print(json.dumps({**value, "hostPostcondition": record_host_proof(value)}))
    else: phase(args.action, args.checkpoint_stop)


if __name__ == "__main__": main()
