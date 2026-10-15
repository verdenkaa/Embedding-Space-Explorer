"""Embedding Space Explorer backend package."""

# Single source of truth for versions reported by /api/health and stored in
# experiments / project manifests.
__version__ = "0.1.0"

# Data schema version. Bump on breaking changes to the project database layout
# or on-disk formats; migrations live in the storage module (stage 1+).
SCHEMA_VERSION = 1
