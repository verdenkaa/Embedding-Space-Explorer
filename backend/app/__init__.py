"""Embedding Space Explorer backend package."""

# Single source of truth for versions reported by /api/health and stored in
# experiments / project manifests.
__version__ = "0.6.0"

# Data schema version. Bump on breaking changes to the project database layout
# or on-disk formats; migrations live in the storage module.
# v2: stage 1 — introduces project.db (its own internal db_schema_version = 1).
# v3: stage 2 — embeddings (db schema v2: additive embedding_runs table).
# v4: stage 3 — projections (db schema v3: additive projection_runs table).
# v5: stage 3 rework — raw-axes method + projection presets (db schema v4).
SCHEMA_VERSION = 5
