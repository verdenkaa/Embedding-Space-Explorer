"""Tree-sitter based structural splitter (TZ §6.2).

Supported languages (stage 1 starting set): Python, JavaScript, TypeScript,
TSX. Extracts functions, methods, classes and other named structural nodes
with correct line ranges (decorators included), nesting (symbol paths and
parent links), and chunking of oversized nodes.

Parse errors never crash indexing: they produce a warning; if the tree yields
no structural fragments at all, the caller applies fallback chunking.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

from app.fragmentation.base import RawFragment, SplitOptions, SplitResult
from app.fragmentation.fallback_splitter import chunk_line_range

_LANG_CACHE: dict[str, Any] = {}
_LANG_LOCK = threading.Lock()


@dataclass(frozen=True)
class TargetSpec:
    """What to do with a tree-sitter node type."""

    kind: str
    #: node opens a naming scope (classes, functions, interfaces...)
    scope: bool = False
    #: when True, kind becomes "method" if the immediate parent scope is a class
    method_inside_class: bool = False
    name_field: str = "name"


@dataclass(frozen=True)
class LanguageConfig:
    language_id: str  # "python" | "javascript" | "typescript" | "tsx"
    module: str  # importable module name
    language_attr: str  # attribute holding the language pointer(s)
    targets: dict[str, TargetSpec] = field(default_factory=dict)
    #: python-style: decorated_definition wraps the real definition
    merge_decorators: bool = False
    class_kinds: tuple[str, ...] = ("class",)


_PY_TARGETS = {
    "class_definition": TargetSpec(kind="class", scope=True),
    "function_definition": TargetSpec(kind="function", scope=True, method_inside_class=True),
}

_JS_TARGETS = {
    "function_declaration": TargetSpec(kind="function", scope=True),
    "generator_function_declaration": TargetSpec(kind="function", scope=True),
    "class_declaration": TargetSpec(kind="class", scope=True),
    "class": TargetSpec(kind="class", scope=True),  # class expressions (rare, named)
    "method_definition": TargetSpec(kind="method", scope=True),
    "field_definition": TargetSpec(kind="method", scope=True),
    "variable_declarator": TargetSpec(kind="function", scope=True),
}

_TS_EXTRA_TARGETS = {
    "interface_declaration": TargetSpec(kind="interface", scope=True),
    "type_alias_declaration": TargetSpec(kind="type_alias", scope=False),
    "enum_declaration": TargetSpec(kind="enum", scope=True),
    "abstract_class_declaration": TargetSpec(kind="class", scope=True),
    "function_signature": TargetSpec(kind="function", scope=False),
    "method_signature": TargetSpec(kind="method", scope=False),
}

_VALUE_TYPES_FOR_VAR = {
    "arrow_function",
    "function_expression",
    "function",
    "class_expression",
    "class",
    "object",  # const x = { ... } — a named structural unit worth tracing
}

LANGUAGE_CONFIGS: dict[str, LanguageConfig] = {
    "python": LanguageConfig(
        language_id="python",
        module="tree_sitter_python",
        language_attr="language",
        targets=_PY_TARGETS,
        merge_decorators=True,
    ),
    "javascript": LanguageConfig(
        language_id="javascript",
        module="tree_sitter_javascript",
        language_attr="language",
        targets=_JS_TARGETS,
    ),
    "typescript": LanguageConfig(
        language_id="typescript",
        module="tree_sitter_typescript",
        language_attr="language_typescript",
        targets={**_JS_TARGETS, **_TS_EXTRA_TARGETS},
    ),
    "tsx": LanguageConfig(
        language_id="tsx",
        module="tree_sitter_typescript",
        language_attr="language_tsx",
        targets={**_JS_TARGETS, **_TS_EXTRA_TARGETS},
    ),
}


def get_language(language_id: str) -> Any:
    """Load and cache a tree-sitter Language by config id."""
    with _LANG_LOCK:
        if language_id in _LANG_CACHE:
            return _LANG_CACHE[language_id]
    cfg = LANGUAGE_CONFIGS[language_id]
    import importlib

    from tree_sitter import Language

    module = importlib.import_module(cfg.module)
    pointer = getattr(module, cfg.language_attr)()
    lang = Language(pointer)
    with _LANG_LOCK:
        _LANG_CACHE[language_id] = lang
    return lang


@dataclass
class TreeSitterSplitter:
    """Structural splitter for one language id."""

    language_id: str

    def __post_init__(self) -> None:
        self._cfg = LANGUAGE_CONFIGS[self.language_id]
        self.name = f"tree-sitter-{self.language_id}"

    # -- public API ---------------------------------------------------------

    def split(self, text: str, options: SplitOptions) -> SplitResult:
        result = SplitResult()
        try:
            from tree_sitter import Parser

            parser = Parser(get_language(self.language_id))
            source = text.encode("utf-8")
            tree = parser.parse(source)
        except Exception as exc:  # pragma: no cover - defensive
            result.ok = False
            result.warnings.append(f"tree-sitter failed: {exc!r}; fallback applied")
            return result

        if tree.root_node.has_error:
            result.warnings.append(
                "tree-sitter reported syntax errors; structural fragments may be incomplete"
            )

        stack: list[tuple[str, bool]] = []  # (name, is_class_scope)
        self._visit(tree.root_node, stack, result, options)
        result.fragments.sort(key=lambda f: (f.start_line, f.end_line))
        return result

    # -- internals ----------------------------------------------------------

    def _visit(
        self,
        node: Any,
        stack: list[tuple[str, bool]],
        result: SplitResult,
        options: SplitOptions,
    ) -> None:
        cfg = self._cfg

        # Anonymous tokens (keywords, punctuation) are never targets and are
        # always leaves — skip them entirely.
        if not node.is_named:
            return

        if cfg.merge_decorators and node.type == "decorated_definition":
            definition = next(
                (c for c in node.children if c.type in ("function_definition", "class_definition")),
                None,
            )
            if definition is not None:
                self._emit(
                    definition, stack, result, options, start_override=node.start_point[0] + 1
                )
                # Recurse into the definition body for nested defs; the
                # definition itself was already emitted (and pushed scope
                # inside _emit via nested traversal below).
                return

        spec = cfg.targets.get(node.type)
        if spec is not None and self._is_eligible(node, spec):
            self._emit(node, stack, result, options)
            return  # _emit recurses into children with the extended stack

        for child in node.children:
            self._visit(child, stack, result, options)

    def _is_eligible(self, node: Any, spec: TargetSpec) -> bool:
        if node.type == "variable_declarator":
            value = node.child_by_field_name("value")
            return value is not None and value.type in _VALUE_TYPES_FOR_VAR
        if node.type == "field_definition":
            # Class fields are only interesting when they hold functions
            # (arrow-function "methods"); plain data fields are noise.
            value = node.child_by_field_name("value")
            return value is not None and value.type in (
                "arrow_function",
                "function_expression",
                "function",
            )
        return True

    def _node_name(self, node: Any, spec: TargetSpec) -> str | None:
        name_node = node.child_by_field_name(spec.name_field)
        if name_node is None:
            return None
        try:
            raw: bytes = name_node.text
            return raw.decode("utf-8", errors="replace")
        except Exception:  # pragma: no cover - defensive
            return None

    def _emit(
        self,
        node: Any,
        stack: list[tuple[str, bool]],
        result: SplitResult,
        options: SplitOptions,
        start_override: int | None = None,
    ) -> None:
        cfg = self._cfg
        spec = cfg.targets[node.type]
        name = self._node_name(node, spec)

        kind = spec.kind
        if spec.method_inside_class and stack and stack[-1][1]:
            kind = "method"
        if node.type in ("field_definition", "method_definition"):
            kind = "method"
        if node.type == "variable_declarator":
            value = node.child_by_field_name("value")
            if value is not None:
                if value.type in ("class_expression", "class"):
                    kind = "class"
                elif value.type == "object":
                    kind = "object"

        parent_path = ".".join(entry[0] for entry in stack) or None
        own_label = name if name else f"<anon:{node.type}>"
        symbol_path = f"{parent_path}.{own_label}" if parent_path else own_label

        start_line = start_override if start_override is not None else node.start_point[0] + 1
        end_line = node.end_point[0] + 1

        oversized = chunk_line_range(start_line, end_line, options, symbol_path)
        if oversized:
            result.fragments.extend(oversized)
        else:
            result.fragments.append(
                RawFragment(
                    kind=kind,
                    name=name,
                    symbol_path=symbol_path,
                    start_line=start_line,
                    end_line=end_line,
                    parent_symbol_path=parent_path,
                )
            )

        # Descend into the body with this node on the scope stack.
        is_class_scope = kind in cfg.class_kinds
        new_stack = [*stack, (own_label, is_class_scope)] if spec.scope else stack
        for child in node.children:
            # Skip re-visiting the definition handled by decorator merging.
            self._visit(child, new_stack, result, options)
