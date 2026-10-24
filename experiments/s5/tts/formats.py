"""Data-only format inspection, run inside the offline resource-limited sandbox.

This checks model structure, not absence of malware or inference-engine defects.
It does not import model-supplied Python, load custom operator libraries, follow
ONNX external-data paths, or deserialize PyTorch pickle.
"""
from __future__ import annotations
import json
import hashlib
import math
import pathlib
import struct


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def inspect_safetensors(path: pathlib.Path):
    file_size = path.stat().st_size
    with path.open("rb") as stream:
        raw = stream.read(8)
        if len(raw) != 8: raise ValueError("truncated safetensors prefix")
        header_size = struct.unpack("<Q", raw)[0]
        if not 2 <= header_size <= 2 * 1024 * 1024 or 8 + header_size > file_size:
            raise ValueError("safetensors header budget")
        header = json.loads(stream.read(header_size), object_pairs_hook=strict_object)
    if not isinstance(header, dict) or len(header) > 10000:
        raise ValueError("safetensors tensor count/type")
    payload_size = file_size - 8 - header_size
    widths = {"F32":4,"F16":2,"BF16":2,"F64":8,"I64":8,"I32":4,"I16":2,
              "I8":1,"U8":1,"BOOL":1,"U16":2,"U32":4,"U64":8}
    ranges = []
    for name, value in header.items():
        if name == "__metadata__":
            if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
                raise ValueError("safetensors metadata must be strings")
            continue
        if not isinstance(name, str) or len(name) > 300 or not isinstance(value, dict):
            raise ValueError("invalid safetensors tensor")
        if set(value) != {"dtype", "shape", "data_offsets"} or value["dtype"] not in widths:
            raise ValueError("safetensors unsupported tensor schema/dtype")
        shape = value["shape"]
        if not isinstance(shape, list) or len(shape) > 16 or any(type(n) is not int or not 0 <= n <= 1000000 for n in shape):
            raise ValueError("safetensors shape budget")
        size = math.prod(shape) * widths[value["dtype"]]
        offsets = value["data_offsets"]
        if not isinstance(offsets, list) or len(offsets) != 2 or any(type(n) is not int for n in offsets):
            raise ValueError("invalid safetensors offsets")
        start, end = offsets
        if not 0 <= start <= end <= payload_size or end - start != size:
            raise ValueError("safetensors extent does not match declared shape")
        ranges.append((start, end))
    previous_end = 0
    for start, end in sorted(ranges):
        if start != previous_end:
            raise ValueError("overlapping/noncontiguous safetensors data")
        previous_end = end
    if previous_end != payload_size or not ranges:
        raise ValueError("safetensors trailing/unaccounted data")
    return {"format":"safetensors","tensors":len(ranges),"payloadBytes":payload_size,
            "externalData":False,"modelSuppliedCode":False}


def inspect_onnx(path: pathlib.Path, *, canonicalize_legacy_metadata=False):
    import onnx
    with path.open("rb") as source:
        original_sha = hashlib.file_digest(source, "sha256").hexdigest()
    model = onnx.load_model(str(path), load_external_data=False)
    if model.functions:
        raise ValueError("model-defined ONNX functions are outside pilot policy")
    domains = {item.domain for item in model.opset_import}
    if domains - {"", "ai.onnx", "com.microsoft"}:
        raise ValueError("unsupported/custom ONNX operator domain")
    metadata = {}; duplicate_metadata = []
    for item in model.metadata_props:
        if item.key in metadata:
            if metadata[item.key] != item.value:
                raise ValueError("conflicting duplicated ONNX metadata")
            duplicate_metadata.append(item.key)
        else:
            metadata[item.key] = item.value
    graph_sha = hashlib.sha256(model.graph.SerializeToString()).hexdigest()
    if duplicate_metadata:
        if not canonicalize_legacy_metadata:
            raise ValueError("duplicated ONNX metadata requires explicit staged canonicalization")
        # Only an admitted publisher artifact's *staged derivative* is changed.
        # All duplicates must be identical. The source archive remains intact;
        # graph/tensor bytes are proven unchanged and recorded in the receipt.
        del model.metadata_props[:]
        for key, value in metadata.items():
            item = model.metadata_props.add(); item.key = key; item.value = value
    count = 0; tensors = 0; operators = set()

    def tensor(value):
        nonlocal tensors
        tensors += 1
        if tensors > 20000 or value.external_data or value.data_location != onnx.TensorProto.DEFAULT:
            raise ValueError("external ONNX tensor data or tensor count budget")
        if len(value.dims) > 16 or any(dim < 0 or dim > 1000000 for dim in value.dims):
            raise ValueError("ONNX tensor dimensions outside budget")

    def graph(value, depth=0):
        nonlocal count
        if depth > 16: raise ValueError("ONNX graph depth budget")
        for initial in value.initializer: tensor(initial)
        for sparse in value.sparse_initializer:
            tensor(sparse.values); tensor(sparse.indices)
        for node in value.node:
            count += 1
            if count > 50000: raise ValueError("ONNX graph node budget")
            if len(node.domain) > 100 or len(node.op_type) > 100:
                raise ValueError("ONNX operator name budget")
            if node.domain not in {"", "ai.onnx", "com.microsoft"}:
                raise ValueError("custom ONNX operator domain")
            # Gelu is the numeric activation observed in the publisher's
            # pinned fp32 Denis graph, not a model-supplied operator library.
            # See Microsoft's v1.22.0 docs/ContribOperators.md Gelu definition.
            if node.domain == "com.microsoft" and node.op_type not in {"DynamicQuantizeMatMul", "MatMulIntegerToFloat", "Gelu"}:
                raise ValueError(f"unreviewed Microsoft contrib ONNX operator: {node.op_type}")
            operators.add(f"{node.domain or 'ai.onnx'}::{node.op_type}")
            for attribute in node.attribute:
                if attribute.type == onnx.AttributeProto.TENSOR: tensor(attribute.t)
                elif attribute.type == onnx.AttributeProto.TENSORS:
                    for item in attribute.tensors: tensor(item)
                elif attribute.type == onnx.AttributeProto.GRAPH: graph(attribute.g, depth + 1)
                elif attribute.type == onnx.AttributeProto.GRAPHS:
                    for item in attribute.graphs: graph(item, depth + 1)
                elif attribute.type == onnx.AttributeProto.SPARSE_TENSOR:
                    tensor(attribute.sparse_tensor.values); tensor(attribute.sparse_tensor.indices)
                elif attribute.type == onnx.AttributeProto.SPARSE_TENSORS:
                    for item in attribute.sparse_tensors: tensor(item.values); tensor(item.indices)
    graph(model.graph)
    onnx.checker.check_model(model, full_check=False)
    if hashlib.sha256(model.graph.SerializeToString()).hexdigest() != graph_sha:
        raise ValueError("graph changed while canonicalizing metadata")
    if duplicate_metadata:
        temporary = path.with_name(path.name + ".canonicalizing")
        with temporary.open("xb") as output:
            output.write(model.SerializeToString())
        temporary.replace(path)
    with path.open("rb") as source:
        derived_sha = hashlib.file_digest(source, "sha256").hexdigest()
    return {"format":"ONNX","onnxInspectorVersion":onnx.__version__,"nodes":count,"tensors":tensors,
            "opset": [{"domain": item.domain, "version": item.version} for item in model.opset_import],
            "operators":sorted(operators), "externalData":False,"customOperatorLibraries":False,
            "canonicalization":{"sourceSha256":original_sha,"derivedSha256":derived_sha,
                "graphSha256":graph_sha,"graphSha256Before":graph_sha,
                "graphSha256After":hashlib.sha256(model.graph.SerializeToString()).hexdigest(),
                "identicalDuplicateMetadataRemoved":duplicate_metadata,
                "policy":"Only identical repeated metadata annotations are removed; conflicting duplicates, external data, unreviewed operators or graph changes are refused."}}


def inspect_model(path: pathlib.Path, *, canonicalize_legacy_metadata=False):
    if path.suffix == ".onnx": return inspect_onnx(path, canonicalize_legacy_metadata=canonicalize_legacy_metadata)
    if path.suffix == ".safetensors": return inspect_safetensors(path)
    raise ValueError("unreviewed model format")
