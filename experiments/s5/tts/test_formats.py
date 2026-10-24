import json
import pathlib
import struct
import tempfile
import unittest
from formats import inspect_safetensors


class SafetensorsFormat(unittest.TestCase):
    def write_tensor(self, root, header, payload=b"\0\0\0\0"):
        path = root / "weights.safetensors"
        encoded = header.encode() if isinstance(header, str) else json.dumps(header).encode()
        path.write_bytes(struct.pack("<Q", len(encoded)) + encoded + payload)
        return path

    def test_valid_tensor(self):
        with tempfile.TemporaryDirectory() as temp:
            path = self.write_tensor(pathlib.Path(temp), {"weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}})
            self.assertEqual(inspect_safetensors(path)["tensors"], 1)

    def test_overlapping_ranges(self):
        with tempfile.TemporaryDirectory() as temp:
            path = self.write_tensor(pathlib.Path(temp), {
                "a":{"dtype":"F32","shape":[1],"data_offsets":[0,4]},
                "b":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}})
            with self.assertRaises(ValueError): inspect_safetensors(path)

    def test_outside_file_range(self):
        with tempfile.TemporaryDirectory() as temp:
            path = self.write_tensor(pathlib.Path(temp), {"weight":{"dtype":"F32","shape":[2],"data_offsets":[0,8]}})
            with self.assertRaises(ValueError): inspect_safetensors(path)

    def test_shape_mismatch(self):
        with tempfile.TemporaryDirectory() as temp:
            path = self.write_tensor(pathlib.Path(temp), {"weight":{"dtype":"F32","shape":[100],"data_offsets":[0,4]}})
            with self.assertRaises(ValueError): inspect_safetensors(path)

    def test_duplicate_key(self):
        with tempfile.TemporaryDirectory() as temp:
            path = self.write_tensor(pathlib.Path(temp), '{"a":{},"a":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}')
            with self.assertRaises(ValueError): inspect_safetensors(path)

    def test_oversized_header(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "weights.safetensors"
            path.write_bytes(struct.pack("<Q", 3 * 1024 * 1024) + b"{}")
            with self.assertRaises(ValueError): inspect_safetensors(path)

    def test_undeclared_payload(self):
        with tempfile.TemporaryDirectory() as temp:
            path = self.write_tensor(pathlib.Path(temp), {"weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}, payload=b"12345678")
            with self.assertRaises(ValueError): inspect_safetensors(path)

    def test_metadata_nested_object(self):
        with tempfile.TemporaryDirectory() as temp:
            path = self.write_tensor(pathlib.Path(temp), {"__metadata__":{"unsafe":{"x":"y"}},"weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}})
            with self.assertRaises(ValueError): inspect_safetensors(path)


if __name__ == "__main__": unittest.main()
