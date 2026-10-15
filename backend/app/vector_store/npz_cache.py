"""Vector storage: interface + .npz file cache (TZ §2.2, §9).

Vectors live OUTSIDE SQLite: one .npz per embedding run in
`<project>/cache/embeddings/`, with parallel arrays:

    ids          (N,)  unicode — fragment ids
    text_hashes  (N,)  unicode — sha256 of the EXACT prepared text (cache key)
    frag_hashes  (N,)  unicode — fragment content_hash at embed time (staleness)
    vectors      (N, D) float32

A vector-store adapter interface keeps the door open for LanceDB etc. if
measurements ever demand it (TZ §2.2) — nothing else in the app touches .npz.
Saves are atomic (tmp + os.replace).
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np


class VectorStore(Protocol):
    """Adapter interface for vector storage backends."""

    def load(self) -> None: ...
    def save(self) -> None: ...
    def index_of(self, fragment_id: str) -> int | None: ...
    def text_hash_of(self, fragment_id: str) -> str | None: ...
    def upsert(
        self, ids: list[str], text_hashes: list[str], frag_hashes: list[str], vectors: np.ndarray
    ) -> None: ...
    def prune(self, valid: dict[str, str]) -> int: ...


@dataclass
class NpzEmbeddingCache:
    """File-backed vector cache for one embedding run."""

    path: Path
    ids: list[str] = field(default_factory=list)
    text_hashes: list[str] = field(default_factory=list)
    frag_hashes: list[str] = field(default_factory=list)
    vectors: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.float32))
    _index: dict[str, int] = field(default_factory=dict, repr=False)

    # -- lifecycle ---------------------------------------------------------

    @classmethod
    def load(cls, path: Path) -> NpzEmbeddingCache:
        cache = cls(path=path)
        if path.exists():
            try:
                with np.load(path, allow_pickle=False) as data:
                    cache.ids = [str(x) for x in data["ids"]]
                    cache.text_hashes = [str(x) for x in data["text_hashes"]]
                    cache.frag_hashes = [str(x) for x in data["frag_hashes"]]
                    cache.vectors = np.asarray(data["vectors"], dtype=np.float32)
            except (KeyError, ValueError, OSError):
                # Corrupted cache: start empty rather than crash the project
                # (TZ §9.4); the embed job simply recomputes vectors.
                cache.ids, cache.text_hashes, cache.frag_hashes = [], [], []
                cache.vectors = np.zeros((0, 0), dtype=np.float32)
        cache._reindex()
        return cache

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # NOTE: np.savez appends ".npz" when the name doesn't end with it,
        # so the temp file must ALSO end with .npz for os.replace to find it.
        tmp = self.path.with_name(self.path.stem + ".tmp.npz")
        np.savez(
            tmp,
            ids=np.array(self.ids, dtype=np.str_),
            text_hashes=np.array(self.text_hashes, dtype=np.str_),
            frag_hashes=np.array(self.frag_hashes, dtype=np.str_),
            vectors=self.vectors.astype(np.float32),
        )
        os.replace(tmp, self.path)

    # -- queries -------------------------------------------------------------

    def _reindex(self) -> None:
        self._index = {fid: i for i, fid in enumerate(self.ids)}

    def index_of(self, fragment_id: str) -> int | None:
        return self._index.get(fragment_id)

    def text_hash_of(self, fragment_id: str) -> str | None:
        idx = self._index.get(fragment_id)
        return self.text_hashes[idx] if idx is not None else None

    def vector_of(self, fragment_id: str) -> np.ndarray | None:
        idx = self._index.get(fragment_id)
        return self.vectors[idx] if idx is not None else None

    @property
    def dim(self) -> int:
        return int(self.vectors.shape[1]) if self.vectors.ndim == 2 else 0

    def signature(self) -> str:
        """Content signature: ids + prepared-text hashes + dim.

        Projections record it at compute time; a mismatch means vectors were
        added/pruned/recomputed since, so dependent results are stale and
        must be recomputed (TZ §9.3). Re-embedding identical texts does NOT
        change the signature — projections stay fresh.
        """
        digest = hashlib.sha256()
        for fid, thash in zip(self.ids, self.text_hashes, strict=True):
            digest.update(fid.encode("utf-8"))
            digest.update(b"\0")
            digest.update(thash.encode("utf-8"))
            digest.update(b"\n")
        digest.update(f"dim={self.dim}\n".encode())
        return digest.hexdigest()[:32]

    def __len__(self) -> int:
        return len(self.ids)

    # -- mutations -------------------------------------------------------------

    def upsert(
        self,
        ids: list[str],
        text_hashes: list[str],
        frag_hashes: list[str],
        vectors: np.ndarray,
    ) -> None:
        if (
            len(ids) != len(text_hashes)
            or len(ids) != len(frag_hashes)
            or len(ids) != vectors.shape[0]
        ):
            raise ValueError("upsert arrays must have equal length")
        if len(ids) == 0:
            return
        keep_mask = np.ones(len(self.ids), dtype=bool)
        for fid in ids:
            old = self._index.get(fid)
            if old is not None:
                keep_mask[old] = False
        if self.vectors.size and keep_mask.sum() != len(self.ids):
            self.ids = [f for f, k in zip(self.ids, keep_mask, strict=True) if k]
            self.text_hashes = [h for h, k in zip(self.text_hashes, keep_mask, strict=True) if k]
            self.frag_hashes = [h for h, k in zip(self.frag_hashes, keep_mask, strict=True) if k]
            self.vectors = self.vectors[keep_mask]
        self.ids.extend(ids)
        self.text_hashes.extend(text_hashes)
        self.frag_hashes.extend(frag_hashes)
        new_vectors = np.asarray(vectors, dtype=np.float32)
        if self.vectors.size == 0:
            self.vectors = new_vectors
        else:
            self.vectors = np.vstack([self.vectors, new_vectors])
        self._reindex()

    def prune(self, valid: dict[str, str]) -> int:
        """Drop entries for deleted fragments or stale content.

        `valid` maps fragment_id -> current content_hash. Entries whose id is
        absent or whose stored frag_hash differs are removed (they will be
        recomputed by the next embed job). Returns the number removed.
        """
        keep = [
            i
            for i, (fid, fhash) in enumerate(zip(self.ids, self.frag_hashes, strict=True))
            if valid.get(fid) == fhash
        ]
        removed = len(self.ids) - len(keep)
        if removed:
            self.ids = [self.ids[i] for i in keep]
            self.text_hashes = [self.text_hashes[i] for i in keep]
            self.frag_hashes = [self.frag_hashes[i] for i in keep]
            self.vectors = self.vectors[keep] if self.vectors.size else self.vectors
            self._reindex()
        return removed
