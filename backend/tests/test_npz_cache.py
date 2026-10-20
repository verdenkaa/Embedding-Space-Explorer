"""Vector cache tests: token-statistics arrays stay parallel and honest.

Truncation honesty (audit fix #1): vectors computed from text the tokenizer
would truncate are FLAGGED, legacy caches without stats report "unknown"
(-1) instead of a fabricated "not truncated".
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from app.vector_store.npz_cache import NpzEmbeddingCache


def _upsert(
    cache: NpzEmbeddingCache,
    ids: list[str],
    *,
    n_tokens: list[int] | None = None,
    truncated: list[bool] | None = None,
) -> None:
    vecs = np.ones((len(ids), 2), dtype=np.float32)
    cache.upsert(
        ids,
        [f"t-{i}" for i in ids],
        [f"f-{i}" for i in ids],
        vecs,
        n_tokens=n_tokens,
        truncated=truncated,
    )


def test_token_stats_roundtrip(tmp_path: Path) -> None:
    cache = NpzEmbeddingCache(path=tmp_path / "c.npz")
    _upsert(cache, ["a", "b", "c"], n_tokens=[10, 200, 30], truncated=[False, True, False])
    assert cache.has_token_stats is True
    assert cache.truncated_count == 1
    cache.save()

    loaded = NpzEmbeddingCache.load(cache.path)
    assert loaded.has_token_stats is True
    assert loaded.n_tokens.tolist() == [10, 200, 30]
    assert loaded.truncated.tolist() == [False, True, False]
    assert loaded.truncated_count == 1


def test_legacy_cache_reports_unknown_not_false(tmp_path: Path) -> None:
    """A cache saved before token stats existed must not claim 'not truncated'."""
    path = tmp_path / "old.npz"
    np.savez(
        path,
        ids=np.array(["a"], dtype=np.str_),
        text_hashes=np.array(["h"], dtype=np.str_),
        frag_hashes=np.array(["f"], dtype=np.str_),
        vectors=np.ones((1, 2), dtype=np.float32),
    )
    cache = NpzEmbeddingCache.load(path)
    assert cache.has_token_stats is False
    assert cache.n_tokens.tolist() == [-1]  # unknown, never 0
    assert cache.truncated.tolist() == [False]
    assert cache.truncated_count == 0

    # saving a legacy cache must not fabricate the stat keys
    cache.save()
    with np.load(cache.path, allow_pickle=False) as data:
        assert "n_tokens" not in data.files
        assert "truncated" not in data.files


def test_upsert_without_stats_marks_unknown(tmp_path: Path) -> None:
    cache = NpzEmbeddingCache(path=tmp_path / "c.npz")
    _upsert(cache, ["a"])
    assert cache.n_tokens.tolist() == [-1]
    assert cache.has_token_stats is False


def test_stats_stay_parallel_through_upsert_and_prune(tmp_path: Path) -> None:
    cache = NpzEmbeddingCache(path=tmp_path / "c.npz")
    _upsert(cache, ["a", "b"], n_tokens=[10, 20], truncated=[False, True])
    # replacing an existing id moves its row to the end — stats must follow
    _upsert(cache, ["a"], n_tokens=[99], truncated=[True])
    assert cache.ids == ["b", "a"]
    assert cache.n_tokens.tolist() == [20, 99]
    assert cache.truncated.tolist() == [True, True]  # b=True from batch 1, a=True new
    assert cache.truncated_count == 2

    # prune keeps the surviving row's stats aligned
    removed = cache.prune({"b": "f-b"})
    assert removed == 1
    assert cache.ids == ["b"]
    assert cache.n_tokens.tolist() == [20]
    assert cache.truncated.tolist() == [True]  # b was flagged in the first batch
    assert cache.truncated_count == 1


def test_upsert_rejects_mismatched_stat_lengths(tmp_path: Path) -> None:
    cache = NpzEmbeddingCache(path=tmp_path / "c.npz")
    vecs = np.ones((2, 2), dtype=np.float32)
    try:
        cache.upsert(["a", "b"], ["t", "t"], ["f", "f"], vecs, n_tokens=[1])
    except ValueError as exc:
        assert "token stat arrays" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("expected ValueError")
