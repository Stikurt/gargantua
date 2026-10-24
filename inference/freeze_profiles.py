"""Explicit reviewed-code release step; never called automatically by the daemon."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from protocol import digest, file_digest, read_json, recipe


def build():
    code = Path(__file__).resolve().parent
    lock = read_json(code / "profiles.lock.json", 262144)
    implementation = {name: file_digest(code / name) for name in ("protocol.py", "container_worker.py", "executor.py")}
    rows = {}
    for kind in ("translation", "tts"):
        model = lock[kind]
        descriptor = {"id": model["id"], "kind": kind, "sourceLanguage": "en" if kind == "translation" else "ru",
            "targetLanguage": "ru", "modelId": model["modelId"], "artifactManifestSha256": digest(model["files"]),
            "runtimeImage": model["image"], "recipe": recipe(kind), "implementation": implementation,
            "admissionStatus": "NOT_FULLY_SCANNED", "qualityStatus": "MACHINE_DRAFT" if kind == "translation" else "NOT_LISTENED",
            "maxSourceCharacters": 700, "maxArtifactBytes": 25600 if kind == "translation" else 8388608}
        if "clientImage" in model:
            descriptor["clientImage"] = model["clientImage"]
        rows[kind] = {"profileSha256": digest(descriptor), "providerRecipeSha256": digest(recipe(kind)), "descriptor": descriptor}
    return {"schemaVersion": 1, "profiles": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = Path(__file__).with_name("profiles.json")
    value = build()
    if args.check:
        if read_json(path, 65536) != value:
            raise SystemExit("Profile export differs from reviewed implementation; do not start providers")
    else:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({kind: {key: row[key] for key in ("profileSha256", "providerRecipeSha256")}
        for kind, row in value["profiles"].items()}))


if __name__ == "__main__": main()
