"""Run in the offline pilot image with the pinned onnx inspector installed."""
import pathlib
import tempfile
import unittest
import onnx
from onnx import TensorProto, helper
from formats import inspect_onnx


def identity_model():
    graph = helper.make_graph([helper.make_node("Identity", ["X"], ["Y"])], "fixture",
        [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1])],
        [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1])])
    return helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])


def external_tensor():
    value = TensorProto(); value.name = "external"; value.data_type = TensorProto.FLOAT
    value.dims.append(1); value.data_location = TensorProto.EXTERNAL
    item = value.external_data.add(); item.key = "location"; item.value = "../must-not-be-opened.bin"
    return value


class OnnxFormat(unittest.TestCase):
    def inspect(self, model):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "fixture.onnx"
            path.write_bytes(model.SerializeToString())
            return inspect_onnx(path)

    def test_valid_identity(self):
        report = self.inspect(identity_model())
        self.assertFalse(report["externalData"])
        self.assertEqual(report["nodes"], 1)

    def test_external_initializer(self):
        model = identity_model(); model.graph.initializer.append(external_tensor())
        with self.assertRaisesRegex(ValueError, "external ONNX"): self.inspect(model)

    def test_external_constant_attribute(self):
        model = identity_model()
        model.graph.node.append(helper.make_node("Constant", [], ["unused"], value=external_tensor()))
        with self.assertRaisesRegex(ValueError, "external ONNX"): self.inspect(model)

    def test_external_nested_graph(self):
        model = identity_model()
        branch = helper.make_graph([], "branch", [], [], initializer=[external_tensor()])
        node = helper.make_node("If", ["condition"], ["unused"], then_branch=branch, else_branch=branch)
        model.graph.node.append(node)
        with self.assertRaisesRegex(ValueError, "external ONNX"): self.inspect(model)

    def test_custom_domain(self):
        model = identity_model(); model.graph.node[0].domain = "untrusted.ops"
        model.opset_import.append(helper.make_opsetid("untrusted.ops", 1))
        with self.assertRaisesRegex(ValueError, "domain"): self.inspect(model)

    def test_unreviewed_contrib_operator(self):
        model = identity_model(); model.graph.node[0].domain = "com.microsoft"
        model.graph.node[0].op_type = "UnreviewedOperator"
        with self.assertRaisesRegex(ValueError, "unreviewed Microsoft"): self.inspect(model)

    def test_reviewed_numeric_gelu(self):
        model = identity_model(); model.graph.node[0].domain = "com.microsoft"
        model.graph.node[0].op_type = "Gelu"
        model.opset_import.append(helper.make_opsetid("com.microsoft", 1))
        self.assertIn("com.microsoft::Gelu", self.inspect(model)["operators"])

    def test_model_defined_function(self):
        model = identity_model()
        model.functions.append(helper.make_function("local", "F", ["X"], ["Y"],
            [helper.make_node("Identity", ["X"], ["Y"])], [helper.make_opsetid("", 13)]))
        with self.assertRaisesRegex(ValueError, "model-defined"): self.inspect(model)

    def test_metadata_duplicates_strict_default(self):
        model = identity_model()
        for value in ["vits", "vits"]:
            item = model.metadata_props.add(); item.key = "model_type"; item.value = value
        with self.assertRaisesRegex(ValueError, "duplicated ONNX metadata"): self.inspect(model)

    def test_canonical_identical_metadata_preserves_graph(self):
        model = identity_model()
        for value in ["vits", "vits"]:
            item = model.metadata_props.add(); item.key = "model_type"; item.value = value
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "fixture.onnx"; path.write_bytes(model.SerializeToString())
            report = inspect_onnx(path, canonicalize_legacy_metadata=True)
            derived = onnx.load_model(str(path), load_external_data=False)
            self.assertEqual(derived.graph.SerializeToString(), model.graph.SerializeToString())
            self.assertEqual(len(derived.metadata_props), 1)
            self.assertNotEqual(report["canonicalization"]["sourceSha256"], report["canonicalization"]["derivedSha256"])

    def test_canonical_conflicting_metadata_refused(self):
        model = identity_model()
        for value in ["vits", "untrusted"]:
            item = model.metadata_props.add(); item.key = "model_type"; item.value = value
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "fixture.onnx"; original = model.SerializeToString(); path.write_bytes(original)
            with self.assertRaisesRegex(ValueError, "conflicting duplicated"):
                inspect_onnx(path, canonicalize_legacy_metadata=True)
            self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__": unittest.main()
