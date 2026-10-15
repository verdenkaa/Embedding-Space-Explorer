"""Stable fragment IDs (TZ §6.2).

Requirements:
- stable while logical boundaries and content are unchanged (line insertions
  ABOVE a fragment must not change its ID — so line numbers are NOT an input);
- different for identical fragments in different files;
- deterministic across machines and reruns.

Scheme:
    fragment_id = sha1(rel_path \n kind \n symbol_path \n ordinal \n content_hash)[:16]

`ordinal` disambiguates fragments with equal (kind, symbol_path) inside one
file (e.g. two overloads or repeated chunk parts); it is the positional index
among those siblings ordered by start line.

Note: identical content at an identical path in two different projects yields
the same ID by design — IDs are portable across re-created projects, which
helps reproducibility. Fragment rows themselves live in per-project databases.
"""

from __future__ import annotations

import hashlib

from app.fragmentation.base import Fragment, RawFragment, SplitOptions, content_hash_of_text


def compute_fragment_id(
    rel_path: str,
    kind: str,
    symbol_path: str,
    ordinal: int,
    content_hash: str,
) -> str:
    payload = "\n".join([rel_path, kind, symbol_path, str(ordinal), content_hash])
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def assign_ordinals(raw: list[RawFragment]) -> dict[int, int]:
    """Return a mapping from index in `raw` to its ordinal.

    Ordinal = number of preceding fragments (in line order) with the same
    (kind, symbol_path). Input must already be sorted by (start_line, end_line).
    """
    seen: dict[tuple[str, str], int] = {}
    ordinals: dict[int, int] = {}
    for idx, frag in enumerate(raw):
        key = (frag.kind, frag.symbol_path)
        ordinals[idx] = seen.get(key, 0)
        seen[key] = ordinals[idx] + 1
    return ordinals


def build_fragments(
    raw: list[RawFragment],
    *,
    rel_path: str,
    method: str,
    language: str,
    lines: list[str],
    line_char_offsets: list[int],
) -> list[Fragment]:
    """Resolve raw fragments: text, hashes, offsets, ordinals, stable IDs."""
    ordered = sorted(raw, key=lambda f: (f.start_line, f.end_line))
    ordinals = assign_ordinals(ordered)
    result: list[Fragment] = []
    for idx, frag in enumerate(ordered):
        # Fragment text is the join of its full lines — consistent between
        # tree-sitter spans and Monaco line ranges (documented in data-model).
        text = "\n".join(lines[frag.start_line - 1 : frag.end_line])
        chash = content_hash_of_text(text)
        start_offset = line_char_offsets[frag.start_line - 1]
        end_line_content = lines[frag.end_line - 1]
        end_offset = line_char_offsets[frag.end_line - 1] + len(end_line_content)
        result.append(
            Fragment(
                fragment_id=compute_fragment_id(
                    rel_path, frag.kind, frag.symbol_path, ordinals[idx], chash
                ),
                kind=frag.kind,
                name=frag.name,
                symbol_path=frag.symbol_path,
                parent_symbol_path=frag.parent_symbol_path,
                start_line=frag.start_line,
                end_line=frag.end_line,
                start_offset=start_offset,
                end_offset=end_offset,
                text=text,
                content_hash=chash,
                method=method,
                language=language,
                ordinal=ordinals[idx],
            )
        )
    return result


def compute_line_offsets(text: str) -> tuple[list[str], list[int]]:
    """Split text into lines (no terminators) and their character offsets."""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()  # trailing newline should not create an empty last line
    offsets: list[int] = []
    pos = 0
    for line in lines:
        offsets.append(pos)
        pos += len(line) + 1  # + '\n'
    return lines, offsets


__all__ = [
    "Fragment",
    "RawFragment",
    "SplitOptions",
    "assign_ordinals",
    "build_fragments",
    "compute_fragment_id",
    "compute_line_offsets",
    "content_hash_of_text",
]
