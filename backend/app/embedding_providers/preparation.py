"""Text preparation modes for embeddings.

Two explicit modes; the exact template is stored with every embedding run —
metadata is never added silently:

- ``raw_fragment``: only the fragment text.
- ``context_enriched``: fragment text prefixed with an explicit context block
  (path, symbol, kind, parent) built from ``CONTEXT_TEMPLATE``.

Comparing modes means two separate runs (never mixed in one cache).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

MODE_RAW = "raw_fragment"
MODE_CONTEXT = "context_enriched"
VALID_MODES = (MODE_RAW, MODE_CONTEXT)

#: The context template. Placeholders: rel_path, symbol_path, kind, parent,
#: language. Persisted verbatim in the embedding run so results are
#: reproducible; changing it creates a NEW run.
CONTEXT_TEMPLATE = (
    "# path: {rel_path}\n"
    "# symbol: {symbol_path}\n"
    "# kind: {kind}\n"
    "# parent: {parent}\n"
    "# language: {language}\n"
    "\n"
    "{text}"
)


@dataclass(frozen=True)
class FragmentText:
    """Everything text preparation may use (no hidden inputs)."""

    text: str
    rel_path: str
    symbol_path: str
    kind: str
    parent_symbol_path: str | None
    language: str


def prepare_text(fragment: FragmentText, mode: str, template: str = CONTEXT_TEMPLATE) -> str:
    """Build the exact string that will be embedded."""
    if mode == MODE_RAW:
        return fragment.text
    if mode == MODE_CONTEXT:
        return template.format(
            rel_path=fragment.rel_path,
            symbol_path=fragment.symbol_path,
            kind=fragment.kind,
            parent=fragment.parent_symbol_path or "-",
            language=fragment.language,
            text=fragment.text,
        )
    raise ValueError(f"unknown preparation mode: {mode!r}")


def prepared_text_hash(prepared: str) -> str:
    """Cache key component: hash of the EXACT prepared text."""
    return hashlib.sha256(prepared.encode("utf-8")).hexdigest()


def render_template_preview(mode: str, template: str = CONTEXT_TEMPLATE) -> str:
    """Human-readable template preview for the UI (filled with placeholders)."""
    if mode == MODE_RAW:
        return "<только текст фрагмента, без метаданных>"
    return template.format(
        rel_path="src/app/calculator.py",
        symbol_path="Calculator.add",
        kind="method",
        parent="Calculator",
        language="python",
        text="def add(self, a, b):\n    return a + b",
    )
