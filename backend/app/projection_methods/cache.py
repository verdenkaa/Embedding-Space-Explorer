"""Projection coordinate cache: one .npz per projection run (TZ §9.1).

    <project>/cache/projections/<fingerprint>.npz
        ids        (N,)   unicode   — fragment ids (same order as coords)
        coords     (N, k) float32   — display coordinates (k = 2 or 3)
        axis_info  (k,)   float32   — optional per-axis info (PCA ratios)

Unlike the embedding cache, a damaged file is NOT silently treated as
empty: `load` returns None for both "absent" and "damaged", and the API
turns that into an explicit "recompute the projection" error — serving an
empty cloud as if it were the result would violate honesty (TZ §17.2).
Saves are atomic (tmp + os.replace), as everywhere else.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


@dataclass
class ProjectionCache:
    path: Path
    ids: list[str] = field(default_factory=list)
    coords: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.float32))
    axis_info: np.ndarray | None = None

    @classmethod
    def load(cls, path: Path) -> ProjectionCache | None:
        """Load a cache file; None when absent or damaged (see module doc)."""
        if not path.exists():
            return None
        try:
            with np.load(path, allow_pickle=False) as data:
                ids = [str(x) for x in data["ids"]]
                coords = np.asarray(data["coords"], dtype=np.float32)
                axis_info = (
                    np.asarray(data["axis_info"], dtype=np.float32)
                    if "axis_info" in data.files
                    else None
                )
        except (KeyError, ValueError, OSError):
            return None
        if coords.ndim != 2 or coords.shape[0] != len(ids):
            return None
        return cls(path=path, ids=ids, coords=coords, axis_info=axis_info)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # np.savez appends ".npz" when missing — the tmp name must end with it
        # for os.replace to find the file (same trap as NpzEmbeddingCache).
        tmp = self.path.with_name(self.path.stem + ".tmp.npz")
        ids = np.array(self.ids, dtype=np.str_)
        coords = self.coords.astype(np.float32)
        if self.axis_info is not None:
            np.savez(tmp, ids=ids, coords=coords, axis_info=np.asarray(self.axis_info, np.float32))
        else:
            np.savez(tmp, ids=ids, coords=coords)
        os.replace(tmp, self.path)

    @property
    def n_components(self) -> int:
        return int(self.coords.shape[1]) if self.coords.ndim == 2 else 0

    def __len__(self) -> int:
        return len(self.ids)


__all__ = ["ProjectionCache"]
