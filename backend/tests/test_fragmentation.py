"""Fragmentation tests: known line ranges, stable IDs, fallbacks."""

from __future__ import annotations

from pathlib import Path

from app.fragmentation.base import Fragment, SplitOptions
from app.fragmentation.registry import FragmentFileResult, fragment_file

from tests.conftest import SAMPLE_PROJECT


def _read(rel: str) -> str:
    return (SAMPLE_PROJECT / rel).read_text(encoding="utf-8")


def _frag(text: str, rel: str, options: SplitOptions | None = None) -> FragmentFileResult:
    return fragment_file(rel_path=rel, text=text, options=options or SplitOptions())


def _by_symbol(result: FragmentFileResult) -> dict[str, Fragment]:
    return {f.symbol_path: f for f in result.fragments}


# ---------------------------------------------------------------------------
# Tree-sitter: Python
# ---------------------------------------------------------------------------


def test_python_structural_fragments() -> None:
    result = _frag(_read("src/calculator.py"), "src/calculator.py")
    assert result.method == "tree-sitter-python"
    assert result.warnings == []
    frags = _by_symbol(result)
    assert set(frags) == {
        "Calculator",
        "Calculator.__init__",
        "Calculator.add",
        "Calculator.helper",
        "helper",
    }

    cls = frags["Calculator"]
    assert (cls.kind, cls.start_line, cls.end_line) == ("class", 9, 20)

    add = frags["Calculator.add"]
    assert (add.kind, add.start_line, add.end_line) == ("method", 15, 16)
    assert add.parent_symbol_path == "Calculator"

    # Decorated method starts at the decorator line.
    helper_m = frags["Calculator.helper"]
    assert (helper_m.kind, helper_m.start_line, helper_m.end_line) == ("method", 18, 20)

    # Module-level function with the same name: different symbol, no parent.
    helper_f = frags["helper"]
    assert (helper_f.kind, helper_f.start_line, helper_f.end_line) == ("function", 23, 25)
    assert helper_f.parent_symbol_path is None


def test_python_fragment_text_matches_lines() -> None:
    result = _frag(_read("src/calculator.py"), "src/calculator.py")
    add = next(f for f in result.fragments if f.symbol_path == "Calculator.add")
    expected = (
        "    def add(self, a: float, b: float) -> float:\n"
        "        return round(a + b, self.precision)"
    )
    assert add.text == expected


# ---------------------------------------------------------------------------
# Tree-sitter: JavaScript / TypeScript
# ---------------------------------------------------------------------------


def test_javascript_fragments() -> None:
    result = _frag(_read("src/utils.js"), "src/utils.js")
    assert result.method == "tree-sitter-javascript"
    frags = _by_symbol(result)
    assert set(frags) == {
        "plainSum",
        "arrow",
        "Registry",
        "Registry.constructor",
        "Registry.register",
    }
    assert (frags["plainSum"].kind, frags["plainSum"].start_line, frags["plainSum"].end_line) == (
        "function",
        3,
        5,
    )
    assert (frags["arrow"].kind, frags["arrow"].start_line) == ("function", 7)
    assert (frags["Registry"].kind, frags["Registry"].start_line, frags["Registry"].end_line) == (
        "class",
        9,
        17,
    )
    assert frags["Registry.register"].kind == "method"


def test_typescript_fragments() -> None:
    result = _frag(_read("web/types.ts"), "web/types.ts")
    assert result.method == "tree-sitter-typescript"
    frags = _by_symbol(result)
    assert (frags["Point"].kind, frags["Point"].start_line, frags["Point"].end_line) == (
        "interface",
        1,
        4,
    )
    assert frags["Handler"].kind == "type_alias"
    assert (frags["Mode"].kind, frags["Mode"].start_line, frags["Mode"].end_line) == ("enum", 8, 11)
    assert frags["distance"].kind == "function"


def test_tsx_supported() -> None:
    text = "export const App = () => <div className='x'>hi</div>;\n"
    result = _frag(text, "app.tsx")
    assert result.method == "tree-sitter-tsx"
    assert any(f.name == "App" for f in result.fragments)


# ---------------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------------


def test_markdown_sections() -> None:
    result = _frag(_read("docs/guide.md"), "docs/guide.md")
    assert result.method == "markdown-headings"
    frags = _by_symbol(result)
    assert set(frags) == {"Guide", "Guide > Setup", "Guide > Setup > Windows", "Guide > Usage"}

    assert (frags["Guide"].start_line, frags["Guide"].end_line) == (1, 3)
    assert (frags["Guide > Setup"].start_line, frags["Guide > Setup"].end_line) == (5, 7)
    # The fenced block's fake heading is ignored; section spans to the fence end.
    assert (
        frags["Guide > Setup > Windows"].start_line,
        frags["Guide > Setup > Windows"].end_line,
    ) == (9, 14)
    assert frags["Guide > Setup > Windows"].parent_symbol_path == "Guide > Setup"
    assert (frags["Guide > Usage"].start_line, frags["Guide > Usage"].end_line) == (16, 18)
    # The fake heading inside the code fence must not become a fragment.
    assert all((f.name or "").strip() != "not a heading inside a fence" for f in result.fragments)


def test_markdown_without_headings_falls_back() -> None:
    result = _frag("just text\nno headings here\n", "plain.md")
    assert result.method == "fallback-lines"
    assert any("no headings" in w for w in result.warnings)


# ---------------------------------------------------------------------------
# Fallback chunking
# ---------------------------------------------------------------------------


def test_fallback_chunks_with_overlap() -> None:
    result = _frag(_read("notes/lorem.txt"), "notes/lorem.txt")
    assert result.method == "fallback-lines"
    spans = [(f.start_line, f.end_line) for f in result.fragments]
    assert spans == [(1, 80), (71, 150), (141, 200)]
    assert [f.symbol_path for f in result.fragments] == ["chunk#0", "chunk#1", "chunk#2"]


def test_unsupported_extension_uses_fallback() -> None:
    result = _frag("a := 1\n", "weird.xyz")
    assert result.method == "fallback-lines"
    assert result.language is None
    assert len(result.fragments) == 1


def test_oversized_node_chunked() -> None:
    body = "\n".join(f"    x{i} = {i}" for i in range(300))
    text = f"def big():\n{body}\n"
    result = _frag(text, "big.py")
    parts = [f for f in result.fragments if f.symbol_path.startswith("big#part")]
    assert len(parts) >= 2
    assert parts[0].start_line == 1
    assert all(p.kind == "chunk" for p in parts)
    assert all(p.end_line - p.start_line + 1 <= 200 for p in parts)


def test_parse_error_does_not_crash() -> None:
    result = _frag("def broken(:\n    pass\n", "broken.py")
    assert result.ok is True
    # tree-sitter error recovery keeps whatever structure it can parse and
    # reports a warning; the indexer never crashes on bad syntax.
    assert any("syntax errors" in w for w in result.warnings)
    assert result.method == "tree-sitter-python"
    recovered = [f for f in result.fragments if f.symbol_path == "broken"]
    assert len(recovered) == 1
    assert (recovered[0].start_line, recovered[0].end_line) == (1, 2)


def test_python_without_defs_falls_back() -> None:
    result = _frag("import os\nimport sys\n\nprint(os.name)\n", "script.py")
    assert result.method == "fallback-lines"
    assert any("no structural fragments" in w for w in result.warnings)


# ---------------------------------------------------------------------------
# Stable IDs
# ---------------------------------------------------------------------------


def test_ids_deterministic() -> None:
    text = _read("src/calculator.py")
    a = _frag(text, "src/calculator.py")
    b = _frag(text, "src/calculator.py")
    assert [f.fragment_id for f in a.fragments] == [f.fragment_id for f in b.fragments]


def test_ids_survive_line_shift_above() -> None:
    text = _read("src/calculator.py")
    before = {f.symbol_path: f for f in _frag(text, "src/calculator.py").fragments}
    shifted = "## comment 1\n## comment 2\n## comment 3\n" + text
    after = {f.symbol_path: f for f in _frag(shifted, "src/calculator.py").fragments}
    assert set(before) == set(after)
    for symbol in before:
        # Same content, same ID — even though every line moved by 3.
        assert before[symbol].fragment_id == after[symbol].fragment_id
        assert after[symbol].start_line == before[symbol].start_line + 3


def test_id_changes_with_content() -> None:
    text = _read("src/calculator.py")
    before = {f.symbol_path: f for f in _frag(text, "src/calculator.py").fragments}
    changed = text.replace("return round(a + b, self.precision)", "return a + b")
    after = {f.symbol_path: f for f in _frag(changed, "src/calculator.py").fragments}
    assert before["Calculator.add"].fragment_id != after["Calculator.add"].fragment_id
    # Untouched fragments keep their IDs.
    assert before["Calculator.__init__"].fragment_id == after["Calculator.__init__"].fragment_id
    assert before["helper"].fragment_id == after["helper"].fragment_id


def test_same_text_different_files_different_ids() -> None:
    text = _read("src/calculator.py")
    a = {f.symbol_path: f.fragment_id for f in _frag(text, "src/calculator.py").fragments}
    b = {f.symbol_path: f.fragment_id for f in _frag(text, "src/calculator_copy.py").fragments}
    assert set(a) == set(b)
    assert all(a[k] != b[k] for k in a)


def test_same_name_functions_in_one_file_unique() -> None:
    text = "def dup():\n    return 1\n\n\ndef dup():\n    return 2\n"
    result = _frag(text, "dup.py")
    dups = [f for f in result.fragments if f.symbol_path == "dup"]
    assert len(dups) == 2
    assert dups[0].fragment_id != dups[1].fragment_id
    assert [f.ordinal for f in dups] == [0, 1]


def test_fixture_copy_is_complete(sample_project: Path) -> None:
    # The writable copy must include the "forbidden" fixture files too.
    assert (sample_project / ".env").exists()
    assert (sample_project / "node_modules" / "pkg" / "index.js").exists()
