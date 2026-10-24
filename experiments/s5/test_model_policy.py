"""Small synthetic fixtures only. Never extracts a downloaded archive on host."""
import copy
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import platform
import sys

_spec = importlib.util.spec_from_file_location("model_policy", Path(__file__).with_name("model-policy.py"))
policy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy)
COMMIT = "1" * 40


def artifact(**overrides):
    value = {"url": f"https://huggingface.co/official/model/resolve/{COMMIT}/model.safetensors",
             "path": "model/model.safetensors", "kind": "weights", "sha256": "0" * 64, "size": 5}
    value.update(overrides)
    return value


def manifest():
    return {"schemaVersion": 1, "models": [{"id": "candidate", "role": "translation",
             "license": {"id": "Apache-2.0", "sourceUrl": f"https://huggingface.co/official/model/blob/{COMMIT}/LICENSE",
                         "scope": "model-weights"},
             "source": {"publisher": "official", "repo": "official/model", "revision": COMMIT,
                        "reviewStatus": "verified-official"}, "artifacts": [artifact()]}]}


def make_tar(path, entries):
    with tarfile.open(path, "w:bz2", format=tarfile.PAX_FORMAT) as archive:
        for name, payload, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = payload
                archive.addfile(info)
            elif kind == "hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = payload
                archive.addfile(info)
            elif kind == "fifo":
                info.type = tarfile.FIFOTYPE
                archive.addfile(info)
            elif kind == "device":
                info.type = tarfile.CHRTYPE
                archive.addfile(info)
            else:
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))


class ArtifactPolicyTests(unittest.TestCase):
    def test_pinned_artifact_and_manifest(self):
        self.assertEqual(policy.validate_artifact(artifact())["size"], 5)
        self.assertEqual(policy.validate_manifest(manifest())["schemaVersion"], 1)

    def test_hf_mutable_tags_forbidden(self):
        for tag in ("main", "latest", "refs/pr/5", "1" * 39, "a" * 41):
            with self.subTest(tag=tag), self.assertRaises(policy.PolicyError):
                policy.validate_artifact(artifact(url=f"https://huggingface.co/official/model/resolve/{tag}/model.safetensors"))

    def test_source_commit_and_artifact_must_match(self):
        with self.assertRaises(policy.PolicyError):
            policy.validate_artifact(artifact(), expected_revision="2" * 40)
        value = manifest()
        value["models"][0]["source"]["revision"] = "2" * 40
        with self.assertRaises(policy.PolicyError):
            policy.validate_manifest(value)

    def test_unreviewed_source_forbidden(self):
        value = manifest()
        value["models"][0]["source"]["reviewStatus"] = "found-on-web"
        with self.assertRaises(policy.PolicyError):
            policy.validate_manifest(value)

    def test_conversion_keeps_distinct_provenance(self):
        value = manifest()
        value["models"][0]["source"]["reviewStatus"] = "reviewed-conversion"
        self.assertEqual(policy.validate_manifest(value)["models"][0]["source"]["reviewStatus"], "reviewed-conversion")

    def test_source_repository_is_bound_to_origin(self):
        value = manifest()
        value["models"][0]["source"]["repo"] = "another/repo"
        with self.assertRaises(policy.PolicyError):
            policy.validate_manifest(value)
        value = manifest()
        value["models"][0]["source"]["revision"] = "main"
        with self.assertRaises(policy.PolicyError):
            policy.validate_manifest(value)

    def test_malformed_types_fail_closed(self):
        for bad in ([], {}, None, True):
            with self.subTest(bad=bad), self.assertRaises(policy.PolicyError):
                policy.validate_artifact(artifact(kind=bad))
            value = manifest()
            value["models"][0]["role"] = bad
            with self.subTest(role=bad), self.assertRaises(policy.PolicyError):
                policy.validate_manifest(value)

    def test_strict_json_rejects_duplicate_keys_and_nonfinite(self):
        for data in ('{"size": 1, "size": 2}', '{"value": NaN}', '{"value": Infinity}'):
            with self.subTest(data=data), self.assertRaises(policy.PolicyError):
                policy.strict_json(data)
        self.assertEqual(policy.strict_json('{"value": 1}'), {"value": 1})

    def test_only_reviewed_https_origins(self):
        urls = ["http://huggingface.co/a/b", "https://localhost/a/b", "https://127.0.0.1/a",
                "https://huggingface.co.evil.test/a", "https://user@huggingface.co/a",
                "https://huggingface.co:443/a", "https://github.com/unofficial/models/releases/download/v1/model.tar.bz2"]
        for url in urls:
            with self.subTest(url=url), self.assertRaises(policy.PolicyError):
                policy.validate_artifact(artifact(url=url))

    def test_query_fragment_and_encoded_path_forbidden(self):
        good = artifact()["url"]
        for url in (good + "?download=true", good + "#model", good.replace("model.safetensors", "%2e%2e/model.safetensors")):
            with self.subTest(url=url), self.assertRaises(policy.PolicyError):
                policy.validate_artifact(artifact(url=url))

    def test_selected_sherpa_archive_origin(self):
        selected = artifact(url="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/model.tar.bz2",
                            path="sherpa/model.tar.bz2", kind="archive")
        self.assertEqual(policy.validate_artifact(selected)["kind"], "archive")
        for url in (selected["url"].replace("sherpa-onnx", "other"),
                    selected["url"].replace(".tar.bz2", ".zip")):
            with self.subTest(url=url), self.assertRaises(policy.PolicyError):
                policy.validate_artifact({**selected, "url": url})

    def test_pickle_and_code_extensions_forbidden(self):
        for suffix in ("bin", "pkl", "pickle", "pt", "pth", "ckpt", "py", "pyc", "ps1", "so", "dll", "exe"):
            for kind in ("weights", "config", "resource"):
                with self.subTest(suffix=suffix, kind=kind), self.assertRaises(policy.PolicyError):
                    policy.validate_artifact(artifact(path=f"model/danger.{suffix}", kind=kind))

    def test_format_kind_limits(self):
        for path, kind in (("m/file.txt", "weights"), ("m/file.yaml", "config"), ("m/file.onnx", "tokenizer"),
                           ("m/file.tar.gz", "archive")):
            with self.subTest(path=path), self.assertRaises(policy.PolicyError):
                policy.validate_artifact(artifact(path=path, kind=kind))

    def test_rejects_unknown_fields_and_missing_digest(self):
        for change in ({"sha256": ""}, {"sha256": "A" * 64}, {"size": True}, {"size": 0}, {"size": 9 * 1024**3}):
            with self.subTest(change=change), self.assertRaises(policy.PolicyError):
                policy.validate_artifact(artifact(**change))
        with self.assertRaises(policy.PolicyError):
            policy.validate_artifact({**artifact(), "exec": "shell"})

    def test_relative_paths_are_windows_and_posix_safe(self):
        paths = ["../model.onnx", "/root/model.onnx", "C:/model.onnx", "a\\model.onnx", "a//model.onnx",
                 "a/./model.onnx", "a/%2e%2e/model.onnx", "a/model.onnx:stream", "a/NUL.onnx", "a/COM1",
                 "a/model.onnx.", "a/model.onnx ", "a/кириллица.onnx", "a/\nfile.onnx"]
        for path in paths:
            with self.subTest(path=path), self.assertRaises(policy.PolicyError):
                policy.safe_relative_path(path)

    def test_path_and_depth_caps(self):
        for path in ("/".join(["a"] * 13), "a/" + "z" * 151):
            with self.subTest(path=path), self.assertRaises(policy.PolicyError):
                policy.safe_relative_path(path)

    def test_only_exact_espeak_variant_data_path_exception(self):
        accepted = "voice/espeak-ng-data/voices/!v/whisper"
        self.assertEqual(policy.safe_relative_path(accepted), accepted)
        for rejected in ("voice/!v/data", "voice/voices/!v/data", "espeak-ng-data/voices/!evil/data",
                         "espeak-ng-data/voices/!v/!shell", "espeak-ng-data/voices/!v/../file"):
            with self.subTest(path=rejected), self.assertRaises(policy.PolicyError):
                policy.safe_relative_path(rejected)

    def test_shared_model_destinations_forbidden(self):
        value = manifest()
        clone = copy.deepcopy(value["models"][0])
        clone["id"] = "second"
        clone["artifacts"][0]["path"] = "MODEL/MODEL.safetensors"
        value["models"].append(clone)
        with self.assertRaises(policy.PolicyError):
            policy.validate_manifest(value)

    def test_manifest_file_parent_collision_rejected(self):
        value = manifest()
        value["models"][0]["artifacts"].append(artifact(path="model/model.safetensors/child.onnx"))
        with self.assertRaises(policy.PolicyError):
            policy.validate_manifest(value)

    def test_explicit_weights_license_required(self):
        for license_value in ("MIT", {"id": "MIT"}, {"id": "MIT", "sourceUrl": "http://example.org/license", "scope": "voice-weights"}):
            value = manifest()
            value["models"][0]["license"] = license_value
            with self.subTest(license=license_value), self.assertRaises(policy.PolicyError):
                policy.validate_manifest(value)

    def test_verify_hash_without_loading_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "model").mkdir()
            (root / "model/model.safetensors").write_bytes(b"abcde")
            row = artifact(sha256=hashlib.sha256(b"abcde").hexdigest())
            self.assertEqual(policy.verify_artifact(root, row)["size"], 5)
            (root / "model/model.safetensors").write_bytes(b"abcdf")
            with self.assertRaises(policy.PolicyError):
                policy.verify_artifact(root, row)

    def test_size_change_cannot_pass_digest_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "model").mkdir()
            (root / "model/model.safetensors").write_bytes(b"too long")
            with self.assertRaises(policy.PolicyError):
                policy.verify_artifact(root, artifact())


class SyntheticTarPolicyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.archive = self.root / "fixture.tar.bz2"

    def tearDown(self):
        self.directory.cleanup()

    def test_valid_data_inventory_and_manual_extraction(self):
        make_tar(self.archive, [("voice/", None, "dir"), ("voice/model.onnx", b"abcde", "file"),
                                ("voice/config.json", b"{}", "file")])
        result = policy.extract_tar(self.archive, self.root / "output")
        self.assertEqual(result["expandedBytes"], 7)
        self.assertEqual(result["members"], 3)
        self.assertEqual((self.root / "output/voice/model.onnx").read_bytes(), b"abcde")
        self.assertEqual(result["files"][0]["sha256"], hashlib.sha256(b"abcde").hexdigest())

    def test_no_existing_destination_overwrite(self):
        make_tar(self.archive, [("voice/model.onnx", b"a", "file")])
        (self.root / "existing").mkdir()
        (self.root / "existing/keep.txt").write_text("keep")
        with self.assertRaises(policy.PolicyError):
            policy.extract_tar(self.archive, self.root / "existing")
        self.assertEqual((self.root / "existing/keep.txt").read_text(), "keep")

    def test_traversal_absolute_drive_ads_and_encoded_members_rejected(self):
        for name in ("../outside.onnx", "/absolute.onnx", "C:/drive.onnx", "a\\bad.onnx", "a/file:stream", "a/%2e%2e/file"):
            make_tar(self.archive, [(name, b"a", "file")])
            with self.subTest(name=name), self.assertRaises(policy.PolicyError):
                policy.inspect_tar(self.archive)
        self.assertFalse((self.root.parent / "outside.onnx").exists())

    def test_links_fifo_and_devices_rejected(self):
        for kind in ("symlink", "hardlink", "fifo", "device"):
            make_tar(self.archive, [("voice/model.onnx", "../../escape", kind)])
            with self.subTest(kind=kind), self.assertRaises(policy.PolicyError):
                policy.inspect_tar(self.archive)

    def test_duplicate_and_case_collision_rejected(self):
        for second in ("voice/model.onnx", "VOICE/MODEL.onnx"):
            make_tar(self.archive, [("voice/model.onnx", b"a", "file"), (second, b"b", "file")])
            with self.subTest(second=second), self.assertRaises(policy.PolicyError):
                policy.inspect_tar(self.archive)

    def test_file_parent_collision_rejected(self):
        make_tar(self.archive, [("voice/model.onnx", b"a", "file"), ("voice/model.onnx/child", b"b", "file")])
        with self.assertRaises(policy.PolicyError):
            policy.inspect_tar(self.archive)

    def test_code_pickle_nested_archive_rejected(self):
        for name in ("voice/loader.py", "voice/data.bin", "voice/nested.tar.bz2", "voice/secret.zip", "voice/evil.dll"):
            make_tar(self.archive, [(name, b"a", "file")])
            with self.subTest(name=name), self.assertRaises(policy.PolicyError):
                policy.inspect_tar(self.archive)

    def test_member_count_byte_and_per_file_caps(self):
        make_tar(self.archive, [("voice/a.onnx", b"a" * 20, "file"), ("voice/b.onnx", b"b" * 20, "file")])
        for limits in ({"maxMembers": 1}, {"maxFileBytes": 19}, {"maxTotalBytes": 39}, {"maxArchiveBytes": 1}):
            with self.subTest(limits=limits), self.assertRaises(policy.PolicyError):
                policy.inspect_tar(self.archive, limits)

    def test_expansion_bomb_capped(self):
        make_tar(self.archive, [("voice/model.onnx", b"0" * 100000, "file")])
        with self.assertRaises(policy.PolicyError):
            policy.inspect_tar(self.archive, {"maxExpansionRatio": 2})

    def test_invalid_limits_rejected(self):
        make_tar(self.archive, [("voice/model.onnx", b"a", "file")])
        for limits in ({"maxMembers": True}, {"maxDepth": 0}, {"unknown": 1}):
            with self.subTest(limits=limits), self.assertRaises(policy.PolicyError):
                policy.inspect_tar(self.archive, limits)

    def test_wrong_compression_and_corruption_rejected(self):
        self.archive.write_bytes(b"this is no archive")
        with self.assertRaises(policy.PolicyError):
            policy.inspect_tar(self.archive)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if args.report:
        report = {"schemaVersion": 1, "suite": "s5-model-artifact-and-synthetic-tar-policy",
                  "tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                  "skipped": len(result.skipped), "success": result.wasSuccessful(),
                  "python": platform.python_version(), "platform": platform.system(),
                  "scope": "synthetic fixtures only; no downloaded archive or model loaded; not inference/translation/TTS quality acceptance",
                  "sourceHashes": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                   for name in ("model-policy.py", "test_model_policy.py")}}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)
