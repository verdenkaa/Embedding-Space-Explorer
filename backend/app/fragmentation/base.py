"""Core fragmentation types shared by all splitters."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel, Field


class SplitOptions(BaseModel):
    """Project-level scanning/segmentation settings (stored in the manifest).

    Every value that can influence results is explicit and persisted
    (no hidden parameters).
    """

    max_file_size_bytes: int = Field(default=1_000_000, ge=1)
    max_fragment_lines: int = Field(default=200, ge=5)
    fallback_chunk_lines: int = Field(default=80, ge=5)
    fallback_overlap_lines: int = Field(default=10, ge=0)
    include_hidden: bool = False
    extra_include_patterns: list[str] = Field(default_factory=list)
    extra_exclude_patterns: list[str] = Field(default_factory=list)
    allow_symlinks_outside_root: bool = False


@dataclass(frozen=True)
class RawFragment:
    """A fragment produced by a splitter, before hashing and ID assignment.

    Line numbers are 1-based inclusive. Splitters do not compute offsets,
    hashes, or IDs — post-processing in `registry.fragment_file` does.
    """

    kind: str
    name: str | None
    symbol_path: str
    start_line: int
    end_line: int
    parent_symbol_path: str | None = None


@dataclass(frozen=True)
class Fragment:
    """A fully resolved fragment ready for storage."""

    fragment_id: str
    kind: str
    name: str | None
    symbol_path: str
    parent_symbol_path: str | None
    start_line: int
    end_line: int
    start_offset: int  # character offset of the first line start
    end_offset: int  # character offset just after the last line content
    text: str
    content_hash: str
    method: str
    language: str
    ordinal: int


@dataclass
class SplitResult:
    """Splitter output: raw fragments plus non-fatal diagnostics."""

    fragments: list[RawFragment] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: False when the splitter could not do its job at all (parse failure);
    #: the caller then applies the fallback strategy.
    ok: bool = True


class Splitter(Protocol):
    """Interface for segmentation strategies."""

    #: Splitter identifier persisted on every fragment, e.g. "tree-sitter-python".
    name: str

    def split(self, text: str, options: SplitOptions) -> SplitResult:
        """Split decoded file text into raw fragments."""
        ...


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def content_hash_of_text(text: str) -> str:
    """Hash used for fragment identity and cache invalidation."""
    return sha256_hex(text.encode("utf-8"))
