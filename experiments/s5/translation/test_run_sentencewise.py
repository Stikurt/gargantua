import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("run_sentencewise", Path(__file__).with_name("run-sentencewise.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class SentenceLauncherTests(unittest.TestCase):
    def test_no_network_gpu_ports_capabilities_or_production_mounts(self):
        args = launcher.docker_args("gargantua-s5-fixture-sentence", "sha256:"+"a"*64, Path("C:/case/results"), "baseline", 2, [])
        self.assertEqual(args[args.index("--network")+1], "none")
        self.assertEqual(args[args.index("--memory")+1], "2g")
        self.assertEqual(args[args.index("--memory-swap")+1], "2g")
        self.assertEqual(args[args.index("--cpus")+1], "2")
        self.assertEqual(args[args.index("--user")+1], "1000:1000")
        self.assertIn("--read-only", args)
        self.assertEqual(args[args.index("--cap-drop")+1], "ALL")
        self.assertFalse(any(flag in args for flag in ("--gpus", "-p", "--publish", "--privileged")))
        mounts = [args[index+1] for index, value in enumerate(args) if value == "--mount"]
        writable = [value for value in mounts if not value.endswith(",readonly")]
        self.assertEqual(len(writable), 1)
        self.assertIn("case/results", writable[0].replace("\\", "/"))
        self.assertNotIn("case/telemetry", " ".join(mounts))

    def test_chapter_mount_only_source_not_private_reference(self):
        args = launcher.docker_args("gargantua-s5-fixture-sentence", "sha256:"+"a"*64, Path("C:/case/results"), "chapter", 6, ["chapter-bridge-1"])
        self.assertIn("/pilot/chapter-inputs.json", args)
        mounts = [args[index+1] for index, value in enumerate(args) if value == "--mount"]
        self.assertTrue(any("chapter-inputs.json" in value for value in mounts))
        self.assertFalse(any("private" in value for value in mounts))
        self.assertEqual(args[args.index("--cpus")+1], "6")
        self.assertEqual(args[args.index("--threads")+1], "6")

    def test_invalid_identity_selector_and_mount_syntax_refused(self):
        with self.assertRaises(ValueError):
            launcher.docker_args("production-container", "sha256:"+"a"*64, Path("C:/case/results"), "baseline", 2, [])
        with self.assertRaises(ValueError):
            launcher.docker_args("gargantua-s5-fixture", "latest", Path("C:/case/results"), "baseline", 2, [])
        with self.assertRaises(ValueError):
            launcher.docker_args("gargantua-s5-fixture", "sha256:"+"a"*64, Path("C:/case/results"), "baseline", 2, ["bad;selector"])
        with self.assertRaises(ValueError):
            launcher.checked_mount(Path("C:/bad,source=/other"))

    def test_output_cannot_escape_reuse_or_overlap_model_directory(self):
        for value in ("../elsewhere", ".local/s5-pilot", ".local/s5-pilot/downloads/opus-en-ru/new-case"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                launcher.checked_case(value)


if __name__ == "__main__":
    unittest.main()
