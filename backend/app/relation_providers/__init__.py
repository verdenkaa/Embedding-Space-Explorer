"""Structural relation providers.

Two independent sources of relations:
- `extract`: surface relations the parsers can honestly see — imports
  (tree-sitter for Python/JS/TS/TSX) and belongs_to (fragment → parent
  fragment);
- `importer`: the documented `ese-relations/v1` JSON corpus format for
  relations computed elsewhere (calls, tested_by, …). The generic format is
  deliberately decoupled from any concrete repository (e.g. signal_desk):
  a project-specific adapter maps its export onto this format.

Every relation keeps its `origin` (extracted | imported | manual) — the UI
never mixes provenance.
"""

from app.relation_providers.extract import (
    ExtractedRelation,
    ExtractSummary,
    extract_relations,
)
from app.relation_providers.importer import (
    FORMAT_ID,
    ImportEndpoint,
    ImportRelation,
    ImportReport,
    UnresolvedRelation,
    parse_import_payload,
)

__all__ = [
    "FORMAT_ID",
    "ExtractSummary",
    "ExtractedRelation",
    "ImportEndpoint",
    "ImportRelation",
    "ImportReport",
    "UnresolvedRelation",
    "extract_relations",
    "parse_import_payload",
]
