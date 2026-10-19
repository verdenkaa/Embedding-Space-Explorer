"""Markdown splitter: sections by ATX headings with line ranges.

- A section spans from its heading line up to (not including) the next
  heading of ANY level, or EOF.
- Parent of a section is the nearest previous heading with a SMALLER level.
- Headings inside fenced code blocks (``` or ~~~) are ignored.
- Oversized sections are chunked via the fallback chunker.

Limitation (documented): setext headings (=== / ---) are not recognized.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.fragmentation.base import RawFragment, SplitOptions, SplitResult
from app.fragmentation.fallback_splitter import chunk_line_range

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")


@dataclass
class MarkdownSplitter:
    name: str = "markdown-headings"

    def split(self, text: str, options: SplitOptions) -> SplitResult:
        result = SplitResult()
        if text.strip() == "":
            result.warnings.append("empty markdown document")
            return result

        lines = text.split("\n")
        fence: str | None = None
        headings: list[tuple[int, int, str]] = []  # (line_no, level, title)
        for i, line in enumerate(lines, start=1):
            m_fence = _FENCE_RE.match(line)
            if m_fence:
                marker = m_fence.group(1)[0] * 3
                if fence is None:
                    fence = marker
                elif fence[0] == marker[0]:
                    fence = None
                continue
            if fence is not None:
                continue
            m_head = _HEADING_RE.match(line)
            if m_head:
                headings.append((i, len(m_head.group(1)), m_head.group(2).strip()))

        if not headings:
            result.warnings.append("no headings found; fallback chunking applied")
            result.ok = False
            return result

        # Section ranges: heading line .. line before next heading (any level).
        stack: list[tuple[int, str]] = []  # (level, symbol_path)
        for idx, (line_no, level, title) in enumerate(headings):
            end_line = headings[idx + 1][0] - 1 if idx + 1 < len(headings) else len(lines)
            # Trim trailing empty lines from the section body.
            while end_line > line_no and lines[end_line - 1].strip() == "":
                end_line -= 1

            while stack and stack[-1][0] >= level:
                stack.pop()
            parent = stack[-1][1] if stack else None
            symbol_path = f"{parent} > {title}" if parent else title
            stack.append((level, symbol_path))

            if end_line - line_no + 1 > options.max_fragment_lines:
                # Keep the whole-section fragment? No: chunk it, keeping the
                # heading with the first part (chunk_line_range covers all).
                result.fragments.extend(chunk_line_range(line_no, end_line, options, symbol_path))
                continue

            result.fragments.append(
                RawFragment(
                    kind="section",
                    name=title,
                    symbol_path=symbol_path,
                    start_line=line_no,
                    end_line=end_line,
                    parent_symbol_path=parent,
                )
            )

        # Preamble before the first heading (if any content there).
        first = headings[0][0]
        if first > 1 and any(line.strip() for line in lines[: first - 1]):
            preamble_end = first - 1
            preamble = [
                RawFragment(
                    kind="chunk",
                    name=None,
                    symbol_path="preamble",
                    start_line=1,
                    end_line=preamble_end,
                )
            ]
            result.fragments = preamble + result.fragments
        return result
