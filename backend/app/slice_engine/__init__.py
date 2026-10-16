"""Slice engine: mathematical layer selection in the ORIGINAL space.

Public API of the module (TZ §10.1 `slice_engine`):
- resolve_normal: build a unit D-dim normal from an MVP spec (axis / PCA
  direction / explicit vector);
- compute_slice: signed coordinates along the normal + in-layer mask.
"""

from app.slice_engine.engine import SliceResult, compute_slice, resolve_normal

__all__ = ["SliceResult", "compute_slice", "resolve_normal"]
