from pathlib import Path
import unittest

import qa_launcher_policy as policy


class QaLauncherPolicyTests(unittest.TestCase):
    def test_only_explicit_extra_case_may_use_qa(self):
        self.assertEqual(policy.server_flags("qwen35-4b-q4", True), ["--no-context-shift"])
        for case, extra in (("qwen3-4b-q4", True), ("qwen35-4b-q4", False)):
            with self.assertRaises(ValueError):
                policy.require_extra_variant(case, extra)

    def test_runtime_and_actual_recipe_are_bound_and_shifting_refused(self):
        argv = ["run", "--no-context-shift", "--ctx-size", "2048"]
        result = policy.runtime_arguments("sha256:"+"a"*64, "sha256:"+"b"*64, argv)
        self.assertIn("--runtime-image-id", result)
        self.assertEqual(result[result.index("--server-recipe-sha256")+1], policy.bench.canonical_digest(argv))
        self.assertIn("--context-shift-disabled", result)
        self.assertEqual(result[result.index("--max-input-tokens")+1], "1536")
        with self.assertRaises(ValueError):
            policy.runtime_arguments("latest", "sha256:"+"b"*64, argv)
        with self.assertRaises(ValueError):
            policy.runtime_arguments("sha256:"+"a"*64, "sha256:"+"b"*64, ["run"])

    def test_4096_is_explicit_and_random_container_name_does_not_change_recipe(self):
        first = ["run", "--name", "gargantua-s5-first", "--no-context-shift", "--ctx-size", "4096"]
        second = ["run", "--name", "gargantua-s5-second", "--no-context-shift", "--ctx-size", "4096"]
        self.assertEqual(policy.recipe_sha256(first), policy.recipe_sha256(second))
        result = policy.runtime_arguments("sha256:"+"a"*64, "sha256:"+"b"*64, first)
        self.assertEqual(result[result.index("--server-context-tokens")+1], "4096")
        self.assertEqual(result[result.index("--max-input-tokens")+1], "3584")
        with self.assertRaises(ValueError):
            policy.runtime_arguments("sha256:"+"a"*64, "sha256:"+"b"*64, ["run", "--no-context-shift", "--ctx-size", "32768"])

    def test_actual_frozen_qa_runner_matches_author_review(self):
        result = policy.validate_frozen_runner(policy.QA_ROOT / "qa_bench.py", policy.QA_RUNNER_SHA256)
        self.assertEqual(result["sha256"], "40dc4042f47ba6c04107a4850c7a8d69c968745fae744f542d5f83dad5db6b61")


if __name__ == "__main__":
    unittest.main()
