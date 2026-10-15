"""Fragmentation: turning source files into traceable fragments.

A *fragment* is a contiguous line range of a file with a kind (function,
class, section, chunk...), an optional symbol name, and a deterministic
stable ID. Splitters are pluggable (TZ §6.2): tree-sitter for supported
languages, headings for Markdown, size-limited chunks as the fallback.
"""
