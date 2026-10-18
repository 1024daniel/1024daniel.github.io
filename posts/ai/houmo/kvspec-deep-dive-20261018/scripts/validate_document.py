"""Read-only source/document checks; write reports only inside this task directory."""

import hashlib
import json
import re
import subprocess
import struct
import tomllib
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path


TASK = Path(__file__).resolve().parents[1]
WORKSPACE = TASK.parents[1]
assert TASK.is_relative_to(WORKSPACE / "ai")
DOC = TASK / "09-kvspec-houmo-vllm-ascend.md"
body = DOC.read_text()
errors = []


def check(condition, message):
    if not condition:
        errors.append(message)


front = re.match(r"\A\+\+\+\n(.*?)\n\+\+\+\n", body, re.S)
check(front is not None, "Missing TOML front matter")
metadata = tomllib.loads(front.group(1)) if front else {}
check(metadata.get("draft") is True, "Document should remain a draft")

blocks = []
opened = None
content = []
for line_no, line in enumerate(body.splitlines(), 1):
    fence = re.fullmatch(r"```([\w-]*)\s*", line)
    if fence:
        if opened is None:
            opened = (fence.group(1), line_no)
            content = []
        else:
            check(not fence.group(1), f"Nested/unclosed fence near line {line_no}")
            blocks.append({"language": opened[0], "line": opened[1], "text": "\n".join(content)})
            opened = None
    elif opened is not None:
        content.append(line)
check(opened is None, "Unclosed code fence")

ids = re.findall(r'<a id="([^"]+)"></a>', body)
check(len(ids) == len(set(ids)), "Duplicate explicit anchor")
for target in re.findall(r"\]\(#([^\)]+)\)", body):
    check(target in ids, f"Missing anchor: {target}")

# Check task-local diagram/report links without following external URLs.
relative_targets = set()
for target in re.findall(r"\]\(([^)]+)\)", body):
    if target.startswith(("#", "/", "https://", "http://")):
        continue
    relative_path = target.split("#", 1)[0]
    if not relative_path:
        continue
    path = (TASK / relative_path).resolve()
    check(path.is_relative_to(TASK), f"Relative link escaped task directory: {target}")
    check(path.is_file(), f"Missing relative link target: {target}")
    relative_targets.add(relative_path)

svg_path = TASK / "assets/input-name-contract.svg"
png_path = TASK / "assets/input-name-contract.png"
mmd_path = TASK / "assets/input-name-contract.mmd"
image_assets = []
for path in [svg_path, png_path, mmd_path]:
    check(path.is_file(), f"Missing diagram asset: {path.name}")
    if path.is_file():
        image_assets.append({"path": str(path.relative_to(TASK)),
                             "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
if svg_path.is_file():
    svg_root = ET.fromstring(svg_path.read_text())
    check(svg_root.get("viewBox") == "0 0 1800 1480", "Unexpected SVG viewBox")
    check(svg_root.find("{http://www.w3.org/2000/svg}title") is not None, "SVG needs an accessible title")
if png_path.is_file():
    png_data = png_path.read_bytes()
    check(png_data[:8] == b"\x89PNG\r\n\x1a\n", "Invalid PNG signature")
    check(struct.unpack(">II", png_data[16:24]) == (1800, 1480), "Unexpected PNG dimensions")
if mmd_path.is_file():
    check(mmd_path.read_text().startswith("flowchart LR\n"), "Unexpected standalone Mermaid declaration")

figures = list(map(int, re.findall(r"\*\*图 (\d+)：", body)))
check(figures == list(range(1, 23)), f"Unexpected figure numbering: {figures}")
chapters = list(map(int, re.findall(r"^## (\d+)\.", body, re.M)))
check(chapters == list(range(12)), f"Unexpected chapter numbering: {chapters}")

local_targets = re.findall(r"\]\((/home/daniel/code/houmo/[^)]+)\)", body)
source_paths = set()
for target in local_targets:
    path_string, separator, location = target.rpartition(":")
    if not separator or not location.isdigit():
        path_string, location = target, "1"
    path = Path(path_string).resolve()
    check(path.is_relative_to(WORKSPACE), f"Unexpected source root: {path}")
    check(not path.is_relative_to(WORKSPACE / "pkgs"), "Forbidden pkgs reference")
    check(path.is_file(), f"Missing source file: {path}")
    if path.is_file():
        check(1 <= int(location) <= len(path.read_text().splitlines()), f"Invalid line: {target}")
        source_paths.add(path)

mermaid = [item for item in blocks if item["language"] == "mermaid"]
for item in mermaid:
    first = item["text"].splitlines()[0]
    check(first in {"flowchart LR", "flowchart TB", "flowchart TD", "sequenceDiagram", "stateDiagram-v2"},
          f"Unexpected Mermaid diagram declaration at line {item['line']}")

# Arithmetic checks for the documented worked examples (no model imports).
kib, mib, gib = 1024, 1024**2, 1024**3
page = 16 * 8 * (128 + 128) * 2
block_all_layers = 32 * page
bytes_per_token = block_all_layers // 16
lengths = [17, 30, 1000, 2048]
rounded_tokens = sum(((n + 15) // 16) * 16 for n in lengths)
numbers = {
    "houmo_declared_layer_page_bytes": 2 * 128 * 8 * 128 * 2,
    "gpu_example_layer_page_bytes": page,
    "all_layer_page_bytes": block_all_layers,
    "bytes_per_token_all_layers": bytes_per_token,
    "configured_blocks_for_16_gib": 16 * gib // block_all_layers,
    "usable_blocks_after_null": 16 * gib // block_all_layers - 1,
    "fixed_four_slot_bytes": 4 * 8192 * bytes_per_token,
    "four_short_requests_bytes": 4 * 1024 * bytes_per_token,
    "mixed_length_pages_bytes": rounded_tokens * bytes_per_token,
    "mixed_length_tail_tokens": rounded_tokens - sum(lengths),
    "mixed_length_tail_bytes": (rounded_tokens - sum(lengths)) * bytes_per_token,
    "shared_prefix_bytes": (1024 + 512 + 512) * bytes_per_token,
    "gpu_example_slot_ids": [[7, 2, 9][p // 16] * 16 + p % 16 for p in [14, 15, 16, 17, 32]],
    "houmo_slot_ranges": [[3 + b * (2 * 2 + 2), 3 + b * (2 * 2 + 2) + 4] for b in range(3)],
}
check(numbers["houmo_declared_layer_page_bytes"] == 512 * kib, "Houmo page arithmetic")
check(page == 64 * kib and block_all_layers == 2 * mib, "GPU page arithmetic")
check(numbers["mixed_length_pages_bytes"] == 390 * mib, "Mixed length page arithmetic")
check(numbers["mixed_length_tail_tokens"] == 25, "Tail token arithmetic")
check(numbers["mixed_length_tail_bytes"] == 3.125 * mib, "Tail byte arithmetic")
check(numbers["shared_prefix_bytes"] == 256 * mib, "Prefix arithmetic")
check(numbers["gpu_example_slot_ids"] == [126, 127, 32, 33, 144], "GPU slots")
check(numbers["houmo_slot_ranges"] == [[3, 7], [9, 13], [15, 19]], "Houmo input ranges")

# Check selected verbatim snippets against actual files as ordered normalized lines.
# This permits explicitly documented omitted lines and indentation changes.
def normalized_lines(text):
    # Selected snippets contain no literal strings with #; inline source comments
    # are explicitly omitted in the article.
    lines = [line.split("#", 1)[0].strip() for line in text.splitlines()]
    return [line for line in lines if line]


def is_subsequence(needles, haystack):
    cursor = iter(haystack)
    return all(any(line == needle for line in cursor) for needle in needles)


checked_snippets = []
for block in blocks:
    if block["language"] != "python":
        continue
    code = block["text"]
    # Select self-contained source extracts, not teaching pseudocode or merged examples.
    prefixes = (
        "num_layers: int = -1,",
        "self.kvcache_config.num_layers = num_decoder_layers",
        "if isinstance(kv_cache_shape[0], list):",
        "if self.use_cache:",
        "kv_config = KVCacheConfig(",
        "placeholder_block_size = (",
        "valid_length_data = np.asarray",
        'if layer_type == "sliding_attention"',
        "cache = self.prefill.get_dev_input(input_name)",
        "return FullAttentionSpec(",
        "return (\n    self.block_size",
        "kv_cache_raw_tensors: dict[str, torch.Tensor] = {}",
        "for layer_name, kv_cache in kv_caches.items():",
        "slot_ids = block_numbers * block_size + local_block_offsets",
        "reshape_and_cache_flash(",
        "kernel_block_ids = (",
        "if not parent_block_hash:",
        "def get_export_cfg(self) -> dict[str, list[str]]:",
        "input_names_mapping = {",
        "if llm_batch > 1:",
        "self.input_names = []",
        "def get_input_name(self, id):",
        "input_names = BaseConverter.xh1_hmonnx_compatible(input_names)",
    )
    if not code.startswith(prefixes):
        continue
    matched = [str(path.relative_to(WORKSPACE)) for path in sorted(source_paths)
               if is_subsequence(normalized_lines(code), normalized_lines(path.read_text()))]
    check(bool(matched), f"Snippet source mismatch near document line {block['line']}")
    checked_snippets.append({"document_line": block["line"], "matching_source_files": matched})

fingerprints = []
for path in sorted(source_paths):
    fingerprints.append({"path": str(path.relative_to(WORKSPACE)),
                         "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})

git = {}
for repo in ["vllm-postmo", "houmo-vllm-18f6bf5"]:
    def run_git(*args):
        return subprocess.run(["git", "-C", str(WORKSPACE / repo), *args],
                              check=True, capture_output=True, text=True).stdout.strip()
    git[repo] = {"head": run_git("rev-parse", "HEAD"),
                 "tracked_status": run_git("status", "--short", "--untracked-files=no")}
    check(not git[repo]["tracked_status"], f"Tracked source changes found in {repo}")

report = {
    "document": str(DOC.relative_to(WORKSPACE)),
    "document_sha256": hashlib.sha256(DOC.read_bytes()).hexdigest(),
    "status": "passed" if not errors else "failed",
    "errors": errors,
    "chapters": len(chapters), "figures": len(figures),
    "code_fences": dict(Counter(item["language"] for item in blocks)),
    "anchors": len(ids), "local_source_links": len(local_targets),
    "relative_link_targets": sorted(relative_targets),
    "image_assets": image_assets,
    "unique_source_files": len(source_paths),
    "verbatim_snippets_checked": checked_snippets,
    "numerical_examples": numbers,
    "git": git,
    "limitations": ["Mermaid declarations checked; Mermaid syntax/layout not render-tested. Figure 8 SVG was rendered with Inkscape and visually reviewed separately.",
                    "No hardware inference, export, model compilation or performance tests.",
                    "Remote sources reviewed separately; this script does not test external URLs.",
                    "Normalized excerpt checks verify selected line sequences, not runtime semantics."],
}
output_dir = (TASK / "results").resolve()
check(output_dir.is_relative_to(TASK), "Output directory escaped task root")
output_dir.mkdir(exist_ok=True)
(output_dir / "validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
(output_dir / "source-fingerprints.json").write_text(json.dumps(fingerprints, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({key: report[key] for key in ["status", "errors", "chapters", "figures", "code_fences", "unique_source_files"]}, ensure_ascii=False))
raise SystemExit(bool(errors))
