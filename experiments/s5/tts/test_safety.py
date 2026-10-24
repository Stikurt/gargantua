import io
import pathlib
import tarfile
import tempfile
import unittest
from safety import extract_bounded, target_path


class ArchiveSafety(unittest.TestCase):
    def test_traversal(self):
        for name in ["../outside", "/outside", "C:/outside", "a\\outside", "a/../../outside"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                target_path(pathlib.Path("stage"), name)

    def build(self, parent, members):
        path = parent / "test.tar.bz2"
        with tarfile.open(path, "w:bz2") as archive:
            for member, data in members:
                archive.addfile(member, io.BytesIO(data) if member.isfile() else None)
        return path

    def test_regular_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            member = tarfile.TarInfo("model/tokens.txt"); member.size = 3
            path = self.build(root, [(member, b"abc")])
            report = extract_bounded(path, root / "stage")
            self.assertEqual(report["expandedBytes"], 3)
            self.assertEqual((root / "stage/model/tokens.txt").read_bytes(), b"abc")

    def test_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            member = tarfile.TarInfo("model/link"); member.type = tarfile.SYMTYPE; member.linkname = "../../outside"
            path = self.build(root, [(member, b"")])
            with self.assertRaises(ValueError): extract_bounded(path, root / "stage")
            self.assertFalse((root / "stage").exists())

    def test_member_budget(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            member = tarfile.TarInfo("model/payload"); member.size = 4
            path = self.build(root, [(member, b"1234")])
            with self.assertRaises(ValueError): extract_bounded(path, root / "stage", max_member=3)

    def test_duplicate_casefold(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            members = []
            for name in ["model/TOKENS.txt", "model/tokens.txt"]:
                member = tarfile.TarInfo(name); member.size = 1; members.append((member, b"x"))
            path = self.build(root, members)
            with self.assertRaises(ValueError): extract_bounded(path, root / "stage")

    def test_total_budget(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            members = []
            for name in ["model/a", "model/b"]:
                member = tarfile.TarInfo(name); member.size = 3; members.append((member, b"123"))
            path = self.build(root, members)
            with self.assertRaises(ValueError): extract_bounded(path, root / "stage", max_total=5)

    def test_file_count_budget(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            members = []
            for name in ["model/a", "model/b"]:
                member = tarfile.TarInfo(name); member.size = 1; members.append((member, b"x"))
            path = self.build(root, members)
            with self.assertRaises(ValueError): extract_bounded(path, root / "stage", max_files=1)

    def test_hardlink(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            member = tarfile.TarInfo("model/link"); member.type = tarfile.LNKTYPE; member.linkname = "model/target"
            path = self.build(root, [(member, b"")])
            with self.assertRaises(ValueError): extract_bounded(path, root / "stage")


if __name__ == "__main__": unittest.main()
