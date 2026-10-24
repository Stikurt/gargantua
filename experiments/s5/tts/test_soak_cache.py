import hashlib
import json
import pathlib
import struct
import tempfile
import unittest
from unittest import mock
from soak_cache import PcmCache,atomic_json,inspect_pcm


def recipe(): return {"schemaVersion":1,"sampleRate":8000,"model":"fixture","input":"frozen","profile":"v1"}
def binding(name): return {"id":name,"textSha256":hashlib.sha256(name.encode()).hexdigest()}
def pcm(value,frames=80): return struct.pack("<h",value)*frames
def store(cache,name,value):
    item=binding(name)
    return cache.save(name,item["textSha256"],pcm(value),{"wallSeconds":0.01,"cpuSeconds":0.01})


class SoakCacheSafety(unittest.TestCase):
    def test_resume_preserves_valid_audio(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp)/"audio"; first=PcmCache(root,recipe()); accepted=store(first,"p01",123)
            resumed=PcmCache(root,recipe(),resume=True)
            self.assertEqual(resumed.load("p01",binding("p01")["textSha256"]),accepted)

    def test_explicit_resume_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp)/"audio"; PcmCache(root,recipe())
            with self.assertRaises(ValueError): PcmCache(root,recipe())

    def test_model_or_input_change_refused(self):
        for field in ("model","input","profile"):
            with self.subTest(field=field),tempfile.TemporaryDirectory() as temp:
                root=pathlib.Path(temp)/"audio"; first=PcmCache(root,recipe()); store(first,"p01",123)
                changed=recipe(); changed[field]="different"
                with self.assertRaisesRegex(ValueError,"recipe/input/model"): PcmCache(root,changed,resume=True)

    def test_changed_text_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe()); store(first,"p01",123)
            with self.assertRaisesRegex(ValueError,"binding"): first.load("p01","different")

    def test_corrupted_pcm_not_reused(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe()); store(first,"p01",123)
            audio,_=first.paths("p01"); original=audio.read_bytes(); audio.write_bytes(original[:-1]+b"x")
            with self.assertRaisesRegex(ValueError,"hash/header/frame"): first.load("p01",binding("p01")["textSha256"])

    def test_missing_audio_checkpoint_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe()); store(first,"p01",123)
            first.paths("p01")[0].unlink()
            with self.assertRaises(ValueError): first.load("p01",binding("p01")["textSha256"])

    def test_unbound_orphan_quarantined_not_reused(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe()); store(first,"p01",123)
            first.paths("p01")[1].unlink()
            self.assertIsNone(first.load("p01",binding("p01")["textSha256"]))
            self.assertEqual(len(first.orphans),1)
            self.assertFalse(first.paths("p01")[0].exists())

    def test_atomic_checkpoint_failed_replace_preserves_old(self):
        with tempfile.TemporaryDirectory() as temp:
            path=pathlib.Path(temp)/"checkpoint.json"; atomic_json(path,{"old":True})
            with mock.patch("soak_cache.os.replace",side_effect=OSError("simulated interruption")):
                with self.assertRaises(OSError): atomic_json(path,{"new":True})
            self.assertEqual(json.loads(path.read_text()),{"old":True})
            self.assertEqual(list(path.parent.glob("*.partial")),[])

    def test_interruption_after_audio_before_checkpoint_recovers_orphan(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe())
            with mock.patch("soak_cache.atomic_json",side_effect=OSError("checkpoint interruption")):
                with self.assertRaises(OSError): store(first,"p01",123)
            resumed=PcmCache(first.root,recipe(),resume=True)
            self.assertIsNone(resumed.load("p01",binding("p01")["textSha256"]))
            accepted=store(resumed,"p01",321)
            self.assertEqual(accepted["pcm"]["frames"],80)
            self.assertEqual(len(resumed.orphans),1)

    def test_ordered_join_exact_payload_and_no_duplicate(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe()); store(first,"p01",123); store(first,"p02",456)
            result=first.join([binding("p01"),binding("p02")],minimum_seconds=0,maximum_seconds=1)
            self.assertEqual(result["pcm"]["frames"],160)
            self.assertEqual((first.root/"chapter.wav").read_bytes()[44:],pcm(123)+pcm(456))
            self.assertEqual(first.join([binding("p01"),binding("p02")],minimum_seconds=0,maximum_seconds=1),result)

    def test_duplicate_or_missing_segment_not_joined(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe()); store(first,"p01",123)
            for ordered in ([binding("p01"),binding("p01")],[binding("p01"),binding("p02")]):
                with self.subTest(ordered=ordered),self.assertRaises(ValueError): first.join(ordered,minimum_seconds=0,maximum_seconds=1)
            self.assertFalse((first.root/"chapter.json").exists())

    def test_bad_wav_extent_not_reused(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe()); store(first,"p01",123)
            audio,_=first.paths("p01"); audio.write_bytes(audio.read_bytes()+b"junk")
            with self.assertRaises(ValueError): inspect_pcm(audio,8000)

    def test_joined_corruption_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe()); store(first,"p01",123)
            first.join([binding("p01")],minimum_seconds=0,maximum_seconds=1)
            path=first.root/"chapter.wav"; data=path.read_bytes(); path.write_bytes(data[:-2]+b"zz")
            with self.assertRaises(ValueError): first.join([binding("p01")],minimum_seconds=0,maximum_seconds=1)

    def test_bad_id_cannot_escape_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe())
            with self.assertRaises(ValueError): first.paths("../outside")

    def test_atomic_partial_never_reused(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe())
            partial=first.segments/".p01.wav.dead.partial"; partial.write_bytes(b"interrupted")
            first.reconcile_partials()
            self.assertFalse(partial.exists()); self.assertEqual(len(first.orphans),1)
            self.assertIsNone(first.load("p01",binding("p01")["textSha256"]))

    def test_first_join_cannot_override_recipe_order(self):
        with tempfile.TemporaryDirectory() as temp:
            fixed=recipe(); fixed["paragraphs"]=[binding("p01"),binding("p02")]
            first=PcmCache(pathlib.Path(temp)/"audio",fixed); store(first,"p01",123); store(first,"p02",456)
            with self.assertRaisesRegex(ValueError,"immutable recipe"):
                first.join([binding("p02"),binding("p01")],minimum_seconds=0,maximum_seconds=1)

    def test_forged_chapter_receipt_hash_still_cannot_change_ordered_pcm(self):
        with tempfile.TemporaryDirectory() as temp:
            first=PcmCache(pathlib.Path(temp)/"audio",recipe()); store(first,"p01",123)
            first.join([binding("p01")],minimum_seconds=0,maximum_seconds=1)
            audio=first.root/"chapter.wav"; receipt=first.root/"chapter.json"
            original=audio.read_bytes(); audio.write_bytes(original[:44]+pcm(456))
            forged=json.loads(receipt.read_text()); forged["pcm"]=inspect_pcm(audio,8000,max_seconds=1)
            forged["orderedPayloadSha256"]=hashlib.sha256(audio.read_bytes()[44:]).hexdigest()
            atomic_json(receipt,forged)
            with self.assertRaisesRegex(ValueError,"exact ordered PCM"):
                first.join([binding("p01")],minimum_seconds=0,maximum_seconds=1)


if __name__=="__main__": unittest.main()
