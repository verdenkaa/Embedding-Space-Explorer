"""Embedding Space Explorer backend package."""

# Single source of truth for versions reported by /api/health and stored in
# experiments / project manifests.
__version__ = "0.9.0"

# Data schema version. Bump on breaking changes to the project database layout
# or on-disk formats; migrations live in the storage module.
# v2: introduces project.db (its own internal db_schema_version = 1).
# v3: embeddings (db schema v2: additive embedding_runs table).
# v4: projections (db schema v3: additive projection_runs table).
# v5: raw-axes method + projection presets (db schema v4).
# v6: relations, clustering runs, manual groups, saved slices
# (db schema v5, additive).
# v7: metric runs and saved experiments (db schema v6, additive).
SCHEMA_VERSION = 7
