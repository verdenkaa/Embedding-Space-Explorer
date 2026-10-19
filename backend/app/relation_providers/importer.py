"""Import of structured relation corpora: `ese-relations/v1`.

The format is deliberately generic and decoupled from any concrete source
repository (e.g. signal_desk): a project-specific adapter maps its export
onto this schema, the importer validates and resolves endpoints, and every
unresolved relation is REPORTED with a reason — never dropped silently.

    {
      "format": "ese-relations/v1",
      "relations": [
        {
          "kind": "calls",                  # required, <= 32 chars
          "source": {"path": "src/a.py",    # required; file rel_path
                     "symbol_path": "C.m",  # optional → fragment endpoint
                     "start_line": 12},     # optional → smallest enclosing
          "target": {"path": "src/b.py"},   # path-only = FILE endpoint
          "confidence": 0.87,               # optional 0..1
          "detail": "free-form note"        # optional <= 512 chars
        }
      ]
    }

Endpoint resolution: `symbol_path` matches a fragment of the file exactly;
`start_line` picks the smallest fragment enclosing the line (both given →
symbol_path wins). Neither → the endpoint stays file-level (valid: many
corpora relate files, not fragments).
"""

from __future__ import annotations

from dataclasses import dataclass, field

FORMAT_ID = "ese-relations/v1"
_MAX_KIND_LEN = 32
_MAX_DETAIL_LEN = 512


class ImportFormatError(ValueError):
    """Raised when the payload does not follow the documented format."""


@dataclass(frozen=True)
class ImportEndpoint:
    path: str
    symbol_path: str | None = None
    start_line: int | None = None


@dataclass(frozen=True)
class ImportRelation:
    kind: str
    source: ImportEndpoint
    target: ImportEndpoint
    confidence: float | None = None
    detail: str | None = None


@dataclass(frozen=True)
class UnresolvedRelation:
    index: int
    reason: str
    kind: str


@dataclass
class ImportReport:
    imported: int = 0
    duplicates: int = 0
    unresolved: list[UnresolvedRelation] = field(default_factory=list)


def parse_import_payload(payload: object) -> list[ImportRelation]:
    """Validate the raw JSON payload against the documented schema.

    Raises ImportFormatError with an actionable message (schema violations
    are caller errors, not per-row skips); per-row resolvability is checked
    later against the project data.
    """
    if not isinstance(payload, dict):
        raise ImportFormatError("payload must be a JSON object")
    fmt = payload.get("format")
    if fmt != FORMAT_ID:
        raise ImportFormatError(f"unsupported format {fmt!r}; this importer speaks '{FORMAT_ID}'")
    raw_relations = payload.get("relations")
    if not isinstance(raw_relations, list):
        raise ImportFormatError("'relations' must be a list")
    if len(raw_relations) > 100_000:
        raise ImportFormatError("too many relations in one import (limit 100000)")

    result: list[ImportRelation] = []
    for i, item in enumerate(raw_relations):
        if not isinstance(item, dict):
            raise ImportFormatError(f"relations[{i}]: expected an object")
        kind = item.get("kind")
        if not isinstance(kind, str) or not kind.strip() or len(kind) > _MAX_KIND_LEN:
            raise ImportFormatError(
                f"relations[{i}].kind must be a non-empty string <= {_MAX_KIND_LEN} chars"
            )
        source = _parse_endpoint(item.get("source"), i, "source")
        target = _parse_endpoint(item.get("target"), i, "target")
        confidence = item.get("confidence")
        if confidence is not None:
            if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
                raise ImportFormatError(f"relations[{i}].confidence must be a number")
            if not 0.0 <= float(confidence) <= 1.0:
                raise ImportFormatError(f"relations[{i}].confidence must be within 0..1")
        detail = item.get("detail")
        if detail is not None and (not isinstance(detail, str) or len(detail) > _MAX_DETAIL_LEN):
            raise ImportFormatError(
                f"relations[{i}].detail must be a string <= {_MAX_DETAIL_LEN} chars"
            )
        result.append(
            ImportRelation(
                kind=kind.strip(),
                source=source,
                target=target,
                confidence=None if confidence is None else float(confidence),
                detail=detail,
            )
        )
    return result


def _parse_endpoint(raw: object, index: int, side: str) -> ImportEndpoint:
    if not isinstance(raw, dict):
        raise ImportFormatError(f"relations[{index}].{side} must be an object")
    path = raw.get("path")
    if not isinstance(path, str) or not path.strip():
        raise ImportFormatError(f"relations[{index}].{side}.path is required")
    symbol_path = raw.get("symbol_path")
    if symbol_path is not None and not isinstance(symbol_path, str):
        raise ImportFormatError(f"relations[{index}].{side}.symbol_path must be a string")
    start_line = raw.get("start_line")
    if start_line is not None and (
        isinstance(start_line, bool) or not isinstance(start_line, int) or start_line < 1
    ):
        raise ImportFormatError(f"relations[{index}].{side}.start_line must be a positive integer")
    return ImportEndpoint(
        path=path.strip().replace("\\", "/"),
        symbol_path=symbol_path,
        start_line=start_line,
    )
