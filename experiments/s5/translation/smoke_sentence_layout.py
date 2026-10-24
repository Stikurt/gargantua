"""No-model Linux sandbox smoke for the shallow /pilot/translation layout."""
import json
from pathlib import Path
import platform

import bench
import sentence_bench
import sentence_catalog

assert Path(__file__).resolve().parent == Path("/pilot/translation")
catalog_path = Path(__file__).with_name("sentence-catalog.lock.json")
catalogue = json.loads(catalog_path.read_text(encoding="utf-8"))
raw = Path(__file__).with_name("corpus.json").read_bytes()
rows = sentence_catalog.source_segments(json.loads(raw))
entries = sentence_bench.verify_catalog(catalogue, raw, "experiments/s5/translation/corpus.json", rows)
assert len(entries) == 12
assert sum(sum(span["kind"] == "translate" for span in row["intervals"]) for row in entries) == 30
assert "reference" not in sentence_bench.model_input("Original source.", "en")
print(json.dumps({"status": "passed", "scope": "actual Linux shallow-layout imports and frozen baseline interval validation; NO model imports/inference", "platform": platform.system(), "layout": str(Path(__file__).resolve().parent), "segments": len(entries), "units": 30, "benchSha256": bench.sha256(Path(bench.__file__)), "catalogueSha256": bench.sha256(catalog_path)}))
