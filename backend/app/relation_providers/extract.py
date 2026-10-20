"""Surface relation extraction via tree-sitter.

What is extracted honestly, without a full semantic analyzer:
- `imports`: import/export-from/require statements in Python/JS/TS/TSX whose
  module resolves to a file of the project. The source endpoint is the
  SMALLEST fragment enclosing the statement — or the file itself when the
  import sits at the top level and belongs to no fragment (file-level
  endpoints are honest first-class citizens, never faked fragment links);
- `belongs_to`: fragment → parent fragment in the same file (from the
  parent_symbol_path recorded at fragmentation time).

Unresolved imports (third-party packages, dynamic paths) are COUNTED and
reported as a summary number — they never become invented relations.
Deeper relations (calls, tested_by, …) arrive through corpus import.
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from app.core.logging import get_logger
from app.source_registry.changes import read_text_safely
from app.storage.models import FileRow, FragmentRow

log = get_logger("relations")

#: Languages we can parse import statements for (tree-sitter configs exist).
SUPPORTED_LANGUAGES: frozenset[str] = frozenset({"python", "javascript", "typescript", "tsx"})

_JS_RESOLVE_SUFFIXES: tuple[str, ...] = (
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.jsx",
)


@dataclass(frozen=True)
class ExtractedRelation:
    kind: str
    source_file_id: str | None
    source_fragment_id: str | None
    target_file_id: str | None
    target_fragment_id: str | None
    detail: str | None = None


@dataclass
class ExtractSummary:
    files_scanned: int = 0
    files_error: int = 0
    imports_resolved: int = 0
    imports_unresolved: int = 0
    belongs_to: int = 0
    #: module specifiers that did not resolve (third-party / dynamic), sampled
    unresolved_samples: list[str] = field(default_factory=list)


def extract_relations(
    files: list[FileRow],
    fragments_by_file: dict[str, list[FragmentRow]],
    progress: Any = None,
) -> tuple[list[ExtractedRelation], ExtractSummary]:
    """Extract all surface relations of the indexed corpus.

    `files` — indexed FileRows; `fragments_by_file` — file_id → fragment rows.
    Pure with respect to the DB (reads only what is passed); the caller
    persists the result. `progress(done, total)` is optional.
    """
    summary = ExtractSummary()
    rel_paths = {f.rel_path.replace("\\", "/"): f.id for f in files}
    parseable = [f for f in files if (f.language or "") in SUPPORTED_LANGUAGES]

    relations: list[ExtractedRelation] = []
    for done, file_row in enumerate(parseable):
        if progress is not None:
            progress(done, len(parseable))
        text, err = read_text_safely(file_row.abs_path)
        if text is None or err is not None:
            summary.files_error += 1
            continue
        summary.files_scanned += 1
        frags = fragments_by_file.get(file_row.id, [])
        for spec, spec_line in _import_specifiers(file_row.language or "", text):
            target_id = _resolve_module(
                spec, file_row.rel_path.replace("\\", "/"), file_row.language or "", rel_paths
            )
            if target_id is None:
                summary.imports_unresolved += 1
                if len(summary.unresolved_samples) < 20:
                    summary.unresolved_samples.append(spec)
                continue
            if target_id == file_row.id:
                continue  # self-import: nothing structural to show
            summary.imports_resolved += 1
            source_fragment = _enclosing_fragment(frags, spec_line)
            relations.append(
                ExtractedRelation(
                    kind="imports",
                    source_file_id=file_row.id,
                    source_fragment_id=source_fragment,
                    target_file_id=target_id,
                    target_fragment_id=None,
                    detail=spec,
                )
            )

    # belongs_to: fragment → parent fragment (same file, by symbol_path).
    # Several fragments may share a symbol_path (overloads/namesakes differ
    # only by ordinal) and an oversized parent exists ONLY as line chunks
    # "<symbol>#part<k>" — a flat {path: id} dict was "last wins" and linked
    # children to an arbitrary sibling, while children of chunked parents
    # lost belongs_to entirely (audit #9).
    for file_row in files:
        frags = fragments_by_file.get(file_row.id, [])
        by_symbol: dict[str, list[FragmentRow]] = defaultdict(list)
        for f in frags:
            by_symbol[f.symbol_path].append(f)
            chunk_match = _CHUNK_SUFFIX.match(f.symbol_path)
            if chunk_match:
                # index the chunk under its base symbol too, so children of
                # a chunked parent can find their enclosing part
                by_symbol[chunk_match.group(1)].append(f)
        for frag in frags:
            parent = frag.parent_symbol_path
            if not parent:
                continue
            parent_id = _resolve_parent(by_symbol.get(parent, ()), frag)
            if parent_id is None or parent_id == frag.id:
                continue
            summary.belongs_to += 1
            relations.append(
                ExtractedRelation(
                    kind="belongs_to",
                    source_file_id=file_row.id,
                    source_fragment_id=frag.id,
                    target_file_id=file_row.id,
                    target_fragment_id=parent_id,
                )
            )

    if progress is not None:
        progress(len(parseable), len(parseable))
    return relations, summary


# ---------------------------------------------------------------------------
# Internals: tree-sitter walk for import specifiers
# ---------------------------------------------------------------------------

# An import "spec" carries the raw module string AND its 1-based statement
# line, so the caller can attribute it to the smallest enclosing fragment.
_IMPORT_NODE_TYPES_PY = ("import_statement", "import_from_statement")
_IMPORT_NODE_TYPES_JS = ("import_statement", "export_statement", "call_expression")


def _import_specifiers(language: str, text: str) -> list[tuple[str, int]]:
    """(module specifier, 1-based statement line) of every import-like node."""
    try:
        from tree_sitter import Parser

        from app.fragmentation.treesitter_splitter import get_language

        parser = Parser(get_language(language))
        tree = parser.parse(text.encode("utf-8"))
    except Exception as exc:  # pragma: no cover - defensive (parser load)
        log.warning("relation extraction: parser failed for %s: %r", language, exc)
        return []

    specs: list[tuple[str, int]] = []
    node_types = _IMPORT_NODE_TYPES_PY if language == "python" else _IMPORT_NODE_TYPES_JS

    def walk(node: Any) -> None:
        if node.type in node_types:
            line = int(node.start_point[0]) + 1
            for raw in _specs_of_node(node, language):
                specs.append((raw, line))
        for child in node.children:
            walk(child)

    walk(tree.root_node)
    # de-duplicate identical (module, line) pairs; keep the FIRST line for a
    # module imported repeatedly (the relation target is the same file)
    seen: set[str] = set()
    unique: list[tuple[str, int]] = []
    for spec, line in specs:
        if spec and spec not in seen:
            seen.add(spec)
            unique.append((spec, line))
    return unique


def _specs_of_node(node: Any, language: str) -> list[str]:
    if language == "python":
        if node.type == "import_statement":
            return [
                _text_of(descendant)
                for child in node.children
                if child.type in ("dotted_name", "aliased_import")
                for descendant in (_dotted_of(child),)
                if descendant is not None
            ]
        if node.type == "import_from_statement":
            # module_name field: dotted_name or relative_import
            module = node.child_by_field_name("module_name")
            if module is None:
                return []
            if module.type == "relative_import":
                prefix = ""
                name = ""
                for child in module.children:
                    if child.type == "import_prefix":
                        prefix = _text_of(child)
                    elif child.type == "dotted_name":
                        name = _text_of(child)
                return [f"{prefix}{name}"] if (prefix or name) else []
            return [_text_of(module)]
        return []

    # js/ts: string literal source of import/export, require("...")
    if node.type in ("import_statement", "export_statement"):
        source = node.child_by_field_name("source")
        if source is not None:
            return [_unquote(_text_of(source))]
        return []
    if node.type == "call_expression":
        fn = node.child_by_field_name("function")
        args = node.child_by_field_name("arguments")
        if fn is None or args is None or _text_of(fn) != "require":
            return []
        for arg in args.children:
            if arg.type in ("string", "template_string"):
                value = _unquote(_text_of(arg))
                if value:
                    return [value]
        return []
    return []


def _dotted_of(node: Any) -> Any | None:
    if node.type == "dotted_name":
        return node
    for child in node.children:
        if child.type == "dotted_name":
            return child
    return None


def _text_of(node: Any) -> str:
    return node.text.decode("utf-8", errors="replace") if node is not None else ""


def _unquote(raw: str) -> str:
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ("'", '"', "`"):
        return raw[1:-1]
    return raw


#: chunk parts produced by `chunk_line_range` for an oversized symbol
_CHUNK_SUFFIX = re.compile(r"^(.+)#part\d+$")


def _resolve_parent(candidates: Sequence[FragmentRow], child: FragmentRow) -> str | None:
    """The parent fragment the child ACTUALLY belongs to.

    Candidates share the parent symbol_path (overloads/namesakes) or are
    line chunks of it. The candidate whose line range CONTAINS the child
    wins; among several containing ones (chunks overlap) the smallest, then
    the earliest, then the lexicographically smallest id — deterministic.
    When nothing contains the child (e.g. it straddles a chunk boundary) the
    closest candidate by start line is used, never an arbitrary "last one".
    """
    if not candidates:
        return None
    containing = [
        c
        for c in candidates
        if c.id != child.id and c.start_line <= child.start_line and child.end_line <= c.end_line
    ]
    if containing:
        best = min(
            containing,
            key=lambda c: (c.end_line - c.start_line, c.start_line, c.id),
        )
        return best.id
    best = min(candidates, key=lambda c: (abs(c.start_line - child.start_line), c.id))
    return best.id if best.id != child.id else None


def _enclosing_fragment(frags: list[FragmentRow], line: int) -> str | None:
    """Smallest fragment whose [start_line, end_line] contains `line`."""
    best: FragmentRow | None = None
    for frag in frags:
        encloses = frag.start_line <= line <= frag.end_line
        smaller = best is None or (frag.end_line - frag.start_line) < (
            best.end_line - best.start_line
        )
        if encloses and smaller:
            best = frag
    return best.id if best is not None else None


def _resolve_module(
    spec: str, source_rel_path: str, language: str, rel_paths: dict[str, str]
) -> str | None:
    """Map an import specifier to a project file id (None = unresolved)."""
    if not spec:
        return None
    if language == "python":
        return _resolve_python(spec, source_rel_path, rel_paths)
    return _resolve_js(spec, source_rel_path, rel_paths)


def _resolve_python(spec: str, source_rel_path: str, rel_paths: dict[str, str]) -> str | None:
    if spec.startswith("."):
        dots = len(spec) - len(spec.lstrip("."))
        rest = spec.lstrip(".")
        base_parts = source_rel_path.split("/")[:-1]
        up = dots - 1  # "." = current package
        if up > len(base_parts):
            return None
        base = base_parts[: len(base_parts) - up] if up else base_parts
        parts = base + ([p for p in rest.split(".") if p] if rest else [])
    else:
        parts = [p for p in spec.split(".") if p]
    if not parts:
        return None
    joined = "/".join(parts)
    for candidate in (f"{joined}.py", f"{joined}/__init__.py"):
        file_id = rel_paths.get(candidate)
        if file_id is not None:
            return file_id
    return None


def _resolve_js(spec: str, source_rel_path: str, rel_paths: dict[str, str]) -> str | None:
    if not spec.startswith("."):
        return None  # bare specifier = third-party package: honestly unresolved
    base_dir = source_rel_path.split("/")[:-1]
    # normalize ./ and ../ segments
    parts: list[str] = []
    for segment in spec.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if parts:
                parts.pop()
            continue
        parts.append(segment)
    joined = "/".join([*base_dir, *parts])
    for suffix in _JS_RESOLVE_SUFFIXES:
        file_id = rel_paths.get(joined + suffix)
        if file_id is not None:
            return file_id
    return None
