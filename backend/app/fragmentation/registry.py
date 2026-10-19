"""Splitter registry: file → strategy selection and fragment assembly.

Extension points: to support a new language, add a LANGUAGE_CONFIGS
entry (tree-sitter) or a dedicated Splitter and map extensions in
`SPLITTER_BY_EXT`. Nothing else in the pipeline changes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import PurePosixPath

from app.fragmentation.base import Fragment, SplitOptions, Splitter
from app.fragmentation.fallback_splitter import FallbackSplitter
from app.fragmentation.markdown_splitter import MarkdownSplitter
from app.fragmentation.stable_id import build_fragments, compute_line_offsets
from app.fragmentation.treesitter_splitter import LANGUAGE_CONFIGS, TreeSitterSplitter

LANGUAGE_BY_EXT: dict[str, str] = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".md": "markdown",
    ".markdown": "markdown",
}

_SPLITTERS: dict[str, Splitter] = {
    "markdown": MarkdownSplitter(),
    **{lang_id: TreeSitterSplitter(lang_id) for lang_id in LANGUAGE_CONFIGS},
}

_FALLBACK = FallbackSplitter()


def language_for_path(rel_path: str) -> str | None:
    suffix = PurePosixPath(rel_path).suffix.lower()
    return LANGUAGE_BY_EXT.get(suffix)


@dataclass
class FragmentFileResult:
    """Outcome of fragmenting one file."""

    fragments: list[Fragment] = field(default_factory=list)
    language: str | None = None
    method: str = _FALLBACK.name
    warnings: list[str] = field(default_factory=list)
    ok: bool = True


def fragment_file(
    *,
    rel_path: str,
    text: str,
    options: SplitOptions,
) -> FragmentFileResult:
    """Fragment decoded file text using the strategy for its extension.

    Guarantees: never raises for bad input; parse failures degrade to the
    fallback chunker with a warning.
    """
    language = language_for_path(rel_path)
    result = FragmentFileResult(language=language)

    splitter: Splitter | None = _SPLITTERS.get(language) if language else None
    split_result = None
    if splitter is not None:
        split_result = splitter.split(text, options)
        result.method = splitter.name
        result.warnings.extend(split_result.warnings)
        if not split_result.ok:
            # Structural strategy declined (parse crash / no structure):
            # fall back to chunks for the whole file.
            fallback = _FALLBACK.split(text, options)
            result.method = _FALLBACK.name
            result.warnings.extend(fallback.warnings)
            split_result = fallback
        elif not split_result.fragments and text.strip():
            # Parser ran fine but found no named units (e.g. a script of plain
            # statements): chunk the file so every line stays traceable.
            result.warnings.append(
                f"no structural fragments found by {splitter.name}; fallback chunking applied"
            )
            fallback = _FALLBACK.split(text, options)
            result.method = _FALLBACK.name
            result.warnings.extend(fallback.warnings)
            split_result = fallback

    if split_result is None:
        # Unsupported extension: fallback only.
        split_result = _FALLBACK.split(text, options)
        result.method = _FALLBACK.name
        result.warnings.extend(split_result.warnings)

    lines, offsets = compute_line_offsets(text)
    result.fragments = build_fragments(
        split_result.fragments,
        rel_path=rel_path,
        method=result.method,
        language=language or "text",
        lines=lines,
        line_char_offsets=offsets,
    )
    return result
