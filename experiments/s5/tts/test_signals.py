"""Technical audio integrity checks; none assert perceived voice quality."""
import pathlib
import tempfile
import unittest
import wave
import numpy as np
from runner import signal_metrics, save_wave


class PcmIntegrity(unittest.TestCase):
    def test_nonfinite(self):
        for value in (float("nan"), float("inf")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                signal_metrics(np.array([value], dtype=np.float32), 16000)

    def test_empty(self):
        with self.assertRaises(ValueError): signal_metrics([], 16000)

    def test_too_short(self):
        with self.assertRaises(ValueError): signal_metrics(np.ones(100), 16000)

    def test_too_long(self):
        with self.assertRaises(ValueError): signal_metrics(np.zeros(16000 * 301, dtype=np.float32), 16000)

    def test_silent_not_accepted(self):
        report = signal_metrics(np.zeros(16000, dtype=np.float32), 16000)
        self.assertFalse(report["integrityPassed"])

    def test_clipped_not_accepted(self):
        report = signal_metrics(np.ones(16000, dtype=np.float32), 16000)
        self.assertFalse(report["integrityPassed"])

    def test_valid_signal_not_naturalness_proof(self):
        samples = 0.1 * np.sin(np.arange(16000) * 2 * np.pi * 440 / 16000)
        report = signal_metrics(samples, 16000)
        self.assertTrue(report["integrityPassed"])
        self.assertNotIn("naturalness", report)

    def test_pcm_container_roundtrip(self):
        with tempfile.TemporaryDirectory() as temp:
            samples = 0.1 * np.sin(np.arange(16000) * 2 * np.pi * 440 / 16000)
            path = pathlib.Path(temp) / "sample.wav"; save_wave(path, samples, 16000)
            with wave.open(str(path), "rb") as stream:
                self.assertEqual((stream.getnchannels(), stream.getsampwidth(), stream.getframerate(), stream.getnframes()), (1, 2, 16000, 16000))
                self.assertEqual(len(stream.readframes(16000)), 32000)


if __name__ == "__main__": unittest.main()
