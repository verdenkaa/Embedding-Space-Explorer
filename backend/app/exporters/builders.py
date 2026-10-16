"""CSV builders (pure, unit-testable)."""

from __future__ import annotations

import csv
import io
from collections.abc import Mapping, Sequence

#: Excel on Windows needs the BOM to detect UTF-8 (Cyrillic names/paths).
BOM = "\ufeff"


def _write(header: Sequence[str], rows: Sequence[Sequence[object]]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(header)
    for row in rows:
        writer.writerow(["" if v is None else v for v in row])
    return BOM + buffer.getvalue()


def points_csv(points: Sequence[Mapping[str, object]], axis_labels: Sequence[str]) -> str:
    """Projection points: full traceability + coordinates (one column per axis)."""
    header = [
        "fragment_id",
        "rel_path",
        "kind",
        "name",
        "symbol_path",
        "start_line",
        "end_line",
        *[str(label) for label in axis_labels],
    ]
    rows = [
        [
            p["fragment_id"],
            p["rel_path"],
            p["kind"],
            p["name"],
            p["symbol_path"],
            p["start_line"],
            p["end_line"],
            *p["coords"],  # type: ignore[misc]
        ]
        for p in points
    ]
    return _write(header, rows)


def relations_csv(rows: Sequence[Mapping[str, object]]) -> str:
    """Relations with both endpoints resolved and provenance preserved."""
    header = [
        "id",
        "kind",
        "origin",
        "confidence",
        "detail",
        "source_file",
        "source_symbol",
        "source_start_line",
        "source_end_line",
        "source_fragment_id",
        "target_file",
        "target_symbol",
        "target_start_line",
        "target_end_line",
        "target_fragment_id",
    ]
    return _write(header, [[row.get(col) for col in header] for row in rows])


def fragments_csv(rows: Sequence[Mapping[str, object]]) -> str:
    """Fragment metadata of an explicit selection (paths + line ranges)."""
    header = [
        "fragment_id",
        "rel_path",
        "kind",
        "name",
        "symbol_path",
        "parent_symbol_path",
        "start_line",
        "end_line",
        "method",
        "language",
    ]
    return _write(header, [[row.get(col) for col in header] for row in rows])
