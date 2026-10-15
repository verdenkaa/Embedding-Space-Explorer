"""Fallback splitter: size-limited line chunks with overlap (TZ §6.2).

Used for unsupported formats and when a structural parser fails or yields
nothing. Also used to break up oversized structural nodes / sections so no
fragment exceeds `max_fragment_lines` by much.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.fragmentation.base import RawFragment, SplitOptions, SplitResult, Splitter


@dataclass
class FallbackSplitter:
    """Chunks the whole file into overlapping line windows."""

    name: str = "fallback-lines"

    def split(self, text: str, options: SplitOptions) -> SplitResult:
        n_lines = text.count("\n") + (0 if text.endswith("\n") or text == "" else 1)
        if text == "":
            return SplitResult(fragments=[], warnings=["empty file"])
        result = SplitResult()
        step = max(1, options.fallback_chunk_lines - options.fallback_overlap_lines)
        start = 1
        idx = 0
        while start <= n_lines:
            end = min(n_lines, start + options.fallback_chunk_lines - 1)
            result.fragments.append(
                RawFragment(
                    kind="chunk",
                    name=None,
                    symbol_path=f"chunk#{idx}",
                    start_line=start,
                    end_line=end,
                )
            )
            idx += 1
            if end >= n_lines:
                break
            start += step
        return result


def chunk_line_range(
    start_line: int,
    end_line: int,
    options: SplitOptions,
    symbol_path: str,
    kind: str = "chunk",
) -> list[RawFragment]:
    """Chunk an oversized line range (used for big nodes / long sections).

    Produces fragments named "<symbol_path>#part<k>" so their stable IDs stay
    distinct and tied to the original symbol.
    """
    span = end_line - start_line + 1
    if span <= options.max_fragment_lines:
        return []
    chunks: list[RawFragment] = []
    step = max(1, options.max_fragment_lines - options.fallback_overlap_lines)
    start = start_line
    part = 0
    while start <= end_line:
        end = min(end_line, start + options.max_fragment_lines - 1)
        chunks.append(
            RawFragment(
                kind=kind,
                name=None,
                symbol_path=f"{symbol_path}#part{part}",
                start_line=start,
                end_line=end,
            )
        )
        part += 1
        if end >= end_line:
            break
        start += step
    return chunks


class FallbackSplitterProtocol(Splitter, FallbackSplitter):  # pragma: no cover
    """Type-checking bridge asserting FallbackSplitter satisfies Splitter."""
