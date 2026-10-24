"""Experimental data-only PCM checkpoints; no database/provider publication.

All paths are derived from validated paragraph IDs. Only canonical mono PCM16
WAV is accepted. A valid JSON receipt alone never makes cached audio reusable.
The Linux inference coordinator holds an exclusive file lock for one cache.
"""
from __future__ import annotations
import errno
import hashlib
import json
import os
import pathlib
import re
import struct
import uuid
import wave
from formats import strict_object


def digest(path):
    with path.open("rb") as source: return hashlib.file_digest(source,"sha256").hexdigest()


def canonical(value): return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()


def load_json(path):
    if path.is_symlink() or path.stat().st_size>256*1024: raise ValueError("unsafe/oversized checkpoint")
    return json.loads(path.read_text(encoding="utf-8"),object_pairs_hook=strict_object)


def sync_directory(path):
    if os.name=="nt": return False
    fd=os.open(path,os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
    try:
        try: os.fsync(fd); return True
        except OSError as error:
            if error.errno in {errno.EINVAL,errno.ENOTSUP}: return False
            raise
    finally: os.close(fd)


def atomic_json(path,value):
    temporary=path.with_name("."+path.name+"."+uuid.uuid4().hex+".partial")
    try:
        with temporary.open("xb") as output:
            output.write(canonical(value)); output.flush(); os.fsync(output.fileno())
        os.replace(temporary,path)
        return sync_directory(path.parent)
    finally:
        if temporary.exists(): temporary.unlink()


def inspect_pcm(path,expected_rate,*,max_seconds=300):
    if path.is_symlink() or not path.is_file(): raise ValueError("missing/linked PCM file")
    size=path.stat().st_size
    if not 44<size<=44+expected_rate*2*max_seconds: raise ValueError("PCM size budget")
    with path.open("rb") as source: header=source.read(44)
    fields=struct.unpack("<4sI4s4sIHHIIHH4sI",header)
    riff,length,wave_tag,fmt,fmt_size,encoding,channels,rate,byte_rate,alignment,bits,data,payload=fields
    if (riff!=b"RIFF" or length!=size-8 or wave_tag!=b"WAVE" or fmt!=b"fmt " or fmt_size!=16
        or encoding!=1 or channels!=1 or rate!=expected_rate or byte_rate!=rate*2 or alignment!=2
        or bits!=16 or data!=b"data" or payload!=size-44 or payload%2):
        raise ValueError("noncanonical PCM16 WAV header/extent")
    return {"sha256":digest(path),"bytes":size,"frames":payload//2,"sampleRate":rate,
            "channels":1,"sampleWidthBytes":2,"durationSeconds":payload/2/rate}


class PcmCache:
    def __init__(self,root,recipe,*,resume=False):
        self.root=pathlib.Path(root); self.recipe=recipe
        self.recipe_sha=hashlib.sha256(canonical(recipe)).hexdigest()
        self.rate=recipe["sampleRate"]; self.directory_fsync=True; self.orphans=[]
        if self.root.exists() and not resume: raise ValueError("cache exists; explicit resume required")
        self.root.mkdir(parents=True,exist_ok=resume)
        if self.root.is_symlink(): raise ValueError("linked cache root")
        recipe_path=self.root/"recipe.json"
        if recipe_path.exists():
            stored=load_json(recipe_path)
            if stored!={"recipeSha256":self.recipe_sha,"recipe":recipe}:
                raise ValueError("resume recipe/input/model mismatch")
        else:
            if resume and any(self.root.iterdir()): raise ValueError("unbound existing cache")
            self.directory_fsync &= atomic_json(recipe_path,{"recipeSha256":self.recipe_sha,"recipe":recipe})
        self.segments=self.root/"segments"; self.checkpoints=self.root/"checkpoints"
        for directory in (self.segments,self.checkpoints):
            directory.mkdir(exist_ok=True)
            if directory.is_symlink(): raise ValueError("linked cache directory")

    def paths(self,identifier):
        if not isinstance(identifier,str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,39}",identifier):
            raise ValueError("unsafe segment ID")
        return self.segments/(identifier+".wav"),self.checkpoints/(identifier+".json")

    def quarantine(self,path):
        if path.is_symlink() or not path.is_file(): raise ValueError("unsafe orphan type")
        directory=self.root/"orphans"; directory.mkdir(exist_ok=True)
        if directory.is_symlink(): raise ValueError("linked orphan directory")
        target=directory/(uuid.uuid4().hex+"-"+path.name)
        os.replace(path,target); self.directory_fsync &= sync_directory(directory)
        self.directory_fsync &= sync_directory(path.parent)
        self.orphans.append(str(target.relative_to(self.root)))

    def reconcile_partials(self):
        partials=[*self.segments.glob(".*.partial"),*self.checkpoints.glob(".*.partial"),*self.root.glob(".*.partial")]
        if len(partials)>100: raise ValueError("partial-file reconciliation budget")
        for path in partials: self.quarantine(path)

    def load(self,identifier,text_sha):
        audio,receipt=self.paths(identifier)
        if not receipt.exists():
            if audio.exists(): self.quarantine(audio)  # Never reuse audio without a bound checkpoint.
            return None
        checkpoint=load_json(receipt)
        required={"schemaVersion","recipeSha256","id","textSha256","pcm","generation"}
        if (set(checkpoint)!=required or checkpoint["schemaVersion"]!=1 or checkpoint["recipeSha256"]!=self.recipe_sha
            or checkpoint["id"]!=identifier or checkpoint["textSha256"]!=text_sha):
            raise ValueError("segment checkpoint binding mismatch")
        actual=inspect_pcm(audio,self.rate)
        if checkpoint["pcm"]!=actual: raise ValueError("cached PCM hash/header/frame mismatch")
        return checkpoint

    def save(self,identifier,text_sha,pcm_bytes,generation):
        audio,receipt=self.paths(identifier)
        if audio.exists() or receipt.exists(): raise ValueError("never overwrite an accepted/orphan segment")
        if not pcm_bytes or len(pcm_bytes)%2 or len(pcm_bytes)>self.rate*2*300:
            raise ValueError("invalid PCM payload budget")
        temporary=audio.with_name("."+audio.name+"."+uuid.uuid4().hex+".partial")
        try:
            with temporary.open("xb") as output:
                with wave.open(output,"wb") as writer:
                    writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(self.rate)
                    writer.writeframes(pcm_bytes)
                output.flush(); os.fsync(output.fileno())
            pcm=inspect_pcm(temporary,self.rate)
            os.replace(temporary,audio); self.directory_fsync &= sync_directory(self.segments)
            checkpoint={"schemaVersion":1,"recipeSha256":self.recipe_sha,"id":identifier,"textSha256":text_sha,
                        "pcm":pcm,"generation":generation}
            self.directory_fsync &= atomic_json(receipt,checkpoint)
            return checkpoint
        finally:
            if temporary.exists(): temporary.unlink()

    def join(self,ordered,*,minimum_seconds=600,maximum_seconds=1200):
        if not ordered or len({x["id"] for x in ordered})!=len(ordered): raise ValueError("empty/duplicate segment order")
        if "paragraphs" in self.recipe and ordered!=self.recipe["paragraphs"]:
            raise ValueError("requested chapter order differs from immutable recipe")
        verified=[]
        for item in ordered:
            checkpoint=self.load(item["id"],item["textSha256"])
            if checkpoint is None: raise ValueError("cannot join missing required segment")
            verified.append(checkpoint)
        frames=sum(item["pcm"]["frames"] for item in verified)
        if not minimum_seconds<=frames/self.rate<=maximum_seconds: raise ValueError("chapter duration outside target")
        target=self.root/"chapter.wav"; receipt=self.root/"chapter.json"
        expected={"schemaVersion":1,"recipeSha256":self.recipe_sha,
            "segments":[{"id":item["id"],"sha256":item["pcm"]["sha256"],"frames":item["pcm"]["frames"]} for item in verified]}
        if receipt.exists():
            stored=load_json(receipt)
            if any(stored.get(key)!=value for key,value in expected.items()): raise ValueError("chapter order/recipe mismatch")
            pcm=inspect_pcm(target,self.rate,max_seconds=maximum_seconds)
            if stored.get("pcm")!=pcm or pcm["frames"]!=frames: raise ValueError("cached chapter PCM mismatch")
            expected_payload=hashlib.sha256()
            for item in verified:
                audio,_=self.paths(item["id"])
                with audio.open("rb") as source:
                    source.seek(44)
                    while block:=source.read(1024*1024): expected_payload.update(block)
            with target.open("rb") as source:
                source.seek(44); measured=hashlib.file_digest(source,"sha256").hexdigest()
            if measured!=expected_payload.hexdigest() or stored.get("orderedPayloadSha256")!=measured:
                raise ValueError("cached chapter differs from exact ordered PCM segments")
            return stored
        if target.exists(): self.quarantine(target)
        temporary=self.root/(".chapter."+uuid.uuid4().hex+".partial")
        joined_payload=hashlib.sha256()
        try:
            with temporary.open("xb") as output:
                with wave.open(output,"wb") as writer:
                    writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(self.rate)
                    for item in verified:
                        audio,_=self.paths(item["id"])
                        with audio.open("rb") as source:
                            source.seek(44)
                            while block:=source.read(1024*1024):
                                joined_payload.update(block); writer.writeframesraw(block)
                output.flush(); os.fsync(output.fileno())
            pcm=inspect_pcm(temporary,self.rate,max_seconds=maximum_seconds)
            if pcm["frames"]!=frames: raise ValueError("joined frame count differs from ordered segments")
            with temporary.open("rb") as source:
                source.seek(44); measured=hashlib.file_digest(source,"sha256").hexdigest()
            if measured!=joined_payload.hexdigest(): raise ValueError("joined payload hash differs")
            os.replace(temporary,target); self.directory_fsync &= sync_directory(self.root)
            expected.update({"pcm":pcm,"orderedPayloadSha256":measured,"framesMatchExactly":True,
                             "directoryFsyncSupported":self.directory_fsync,
                             "durabilityScope":"Atomic file/checkpoint protocol tested; no claim of power-loss durability on an arbitrary host bind filesystem."})
            self.directory_fsync &= atomic_json(receipt,expected)
            return expected
        finally:
            if temporary.exists(): temporary.unlink()
