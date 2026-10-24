"""Real Windows Python-executor / PowerShell-backup lock interoperability.

Only a fresh owned fixture lock is touched. No Docker, model, runtime lock or
production service is used.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "inference"))
spec = importlib.util.spec_from_file_location("derived_lock_executor", ROOT / "inference/executor.py")
EXECUTOR = importlib.util.module_from_spec(spec)
spec.loader.exec_module(EXECUTOR)


@unittest.skipUnless(os.name == "nt", "Windows file-sharing interop")
class LockInteropTests(unittest.TestCase):
    def test_python_lock_blocks_powershell_snapshot_until_released(self):
        parent = ROOT / ".local/test-results/derived-lock-interop"
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            root = Path(directory)
            lock = root / "execution.lock"
            script = root / "probe.ps1"
            script.write_text("""param([string]$LockPath)
$stream=$null
try {
 $stream=[IO.File]::Open($LockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $stream.Dispose()
 exit 0
} catch { exit 12 }
""", encoding="utf-8")
            pwsh = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe"
            self.assertTrue(pwsh.is_file(), "Bundled PowerShell runtime is required")
            arguments = [str(pwsh), "-NoProfile", "-File", str(script), "-LockPath", str(lock)]
            options = {"capture_output": True, "timeout": 15, "creationflags": subprocess.CREATE_NO_WINDOW}
            with EXECUTOR.FileLock(lock):
                blocked = subprocess.run(arguments, **options)
                self.assertEqual(blocked.returncode, 12, "A snapshot must not acquire the executor-owned lock")
            released = subprocess.run(arguments, **options)
            self.assertEqual(released.returncode, 0, "A released executor lock should permit a later snapshot")


if __name__ == "__main__":
    unittest.main()
