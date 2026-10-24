"""Host-only extra QA variant checks; no inference or automatic model admission."""
from pathlib import Path
import re

import bench

ROOT = Path(__file__).resolve().parents[3]
QA_ROOT = ROOT / "experiments/s5/translation-extra"
QA_RUNNER_SHA256 = "40dc4042f47ba6c04107a4850c7a8d69c968745fae744f542d5f83dad5db6b61"


def require_extra_variant(case, extra):
    if case != "qwen35-4b-q4" or not extra:
        raise ValueError("QA is a separately reviewed additional-model variant only")


def server_flags(case, extra):
    require_extra_variant(case, extra)
    # Exact preflight also belongs to qa_bench; this prevents the server evicting
    # source/draft/context behind the caller's back if a budget was miscomputed.
    return ["--no-context-shift"]


def recipe_sha256(server_argv):
    normalized = []
    index = 0
    while index < len(server_argv):
        if server_argv[index] == "--name":
            if index+1 >= len(server_argv):
                raise ValueError("Invalid server name option")
            index += 2
            continue
        normalized.append(server_argv[index])
        index += 1
    return bench.canonical_digest(normalized)


def runtime_arguments(client_image_id, server_image_id, server_argv):
    for image in (client_image_id, server_image_id):
        if not isinstance(image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
            raise ValueError("QA requires actual immutable client and model-server image IDs")
    if "--no-context-shift" not in server_argv:
        raise ValueError("QA requires explicit no-context-shift server policy")
    if "--ctx-size" not in server_argv or server_argv[server_argv.index("--ctx-size")+1] not in ("2048", "4096"):
        raise ValueError("QA pilot requires an explicitly reviewed 2048/4096-token context")
    context = server_argv[server_argv.index("--ctx-size")+1]
    return ["--runtime-image-id", client_image_id, "--model-server-image-id", server_image_id, "--server-recipe-sha256", recipe_sha256(server_argv), "--context-shift-disabled", "--server-context-tokens", context, "--max-input-tokens", str(int(context)-512), "--max-output-tokens", "384"]


def validate_frozen_runner(path, expected_sha256):
    """The independent QA author supplies the reviewed runner hash."""
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or bench.sha256(path) != expected_sha256:
        raise ValueError("QA runner differs from the separately reviewed frozen bytes")
    return {"path": str(path.relative_to(ROOT)), "sha256": expected_sha256}
