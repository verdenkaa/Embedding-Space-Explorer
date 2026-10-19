"""Pure metric computations over numpy arrays (unit-testable, no IO).

Definitions:

- neighbor_retention@k  — mean share of the ORIGINAL-space k nearest
  neighbors (cosine over embeddings) that remain within the projection's
  k nearest neighbors (euclidean over projection coordinates). 1.0 = the map
  kept every original neighbor close; 0.0 = none kept.
- trustworthiness@k     — sklearn.manifold.trustworthiness on the sample:
  1 − normalized penalty for FALSE neighbors (points close in the
  projection but far in the original space).
- relation_precision@k  — among sampled fragments that HAVE known structural
  relations, the mean share of their original-space top-k neighbors that are
  among those known relations. NOT a classical precision: unknown pairs are
  treated as UNKNOWN (corpus incompleteness), never as negatives.
- relation_coverage@k   — share of known relation pairs (both ends embedded)
  whose target appears in the source's original-space top-k (checked in both
  directions — the relation semantics are treated as symmetric here, which
  is documented in the explanation).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

import numpy as np

METRIC_EXPLANATIONS: dict[str, str] = {
    "neighbor_retention": (
        "Средняя доля k ближайших соседей ИСХОДНОГО пространства (cosine), "
        "оставшихся в k ближайших окрестниках проекции (euclidean). 1.0 — карта "
        "сохранила всех соседей, 0.0 — никого. Для UMAP осмысленна только "
        "локальная сохранность (нелинейная проекция искажает глобальные расстояния)."
    ),
    "trustworthiness": (
        "sklearn.manifold.trustworthiness на выборке: 1 минус нормированный штраф "
        "за «ложных соседей» — точки, ставшие близкими в проекции, но далёкими в "
        "исходном пространстве. 1.0 — ложных соседей нет."
    ),
    "relation_precision": (
        "Доля топ-k соседей ИСХОДНОГО пространства, приходящихся на ИЗВЕСТНЫЕ "
        "структурные связи фрагмента (усреднение по фрагментам, у которых есть "
        "хотя бы одна известная связь). ВАЖНО: отсутствие известной связи НЕ "
        "считается доказательством отсутствия связи (корпус связей неполон) — "
        "это мера согласия с известными связями, а не классический precision."
    ),
    "relation_coverage": (
        "Доля известных структурных пар (оба конца с векторами), у которых цель "
        "попала в топ-k соседей источника в ИСХОДНОМ пространстве (проверено в "
        "обе стороны: связь трактуется симметрично). Низкое значение при малом "
        "числе известных пар — не вывод о геометрии, а следствие неполноты корпуса."
    ),
}


class MetricsInputError(ValueError):
    """Raised when metric inputs are unusable (before any computation)."""


def sample_indices(n: int, sample: int, seed: int) -> np.ndarray:
    """Deterministic sorted sample of point indices (reproducibility, §9.2)."""
    if n <= 0:
        raise MetricsInputError("no vectors to measure")
    size = min(max(sample, 1), n)
    rng = np.random.default_rng(seed)
    idx = np.sort(rng.choice(n, size=size, replace=False))
    return idx.astype(np.int64)


def _topk_excluding_self(similarity_or_negdist: np.ndarray, self_index: int, k: int) -> np.ndarray:
    """Indices of the k best rows of a score vector (higher = closer), self excluded."""
    scores = similarity_or_negdist.copy()
    scores[self_index] = -np.inf
    k_eff = int(min(k, scores.shape[0] - 1))
    if k_eff <= 0:
        return np.empty(0, dtype=np.int64)
    part = np.argpartition(scores, -k_eff)[-k_eff:]
    return part[np.argsort(scores[part], kind="stable")]


def original_topk(vectors: np.ndarray, idx: np.ndarray, k: int) -> np.ndarray:
    """(S, k) int array: cosine top-k in the ORIGINAL space for each sampled row."""
    data = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(data, axis=1, keepdims=True)
    safe = np.where(norms == 0, 1.0, norms)
    unit = data / safe
    zero_rows = (norms == 0).ravel()
    sims = unit[idx] @ unit.T  # (S, N)
    sims[zero_rows[idx], :] = 0.0  # directionless query: no honest ranking
    out = np.empty((len(idx), k), dtype=np.int64)
    for row, self_i in enumerate(idx):
        top = _topk_excluding_self(sims[row], int(self_i), k)
        padded = np.full(k, -1, dtype=np.int64)
        padded[: top.shape[0]] = top
        out[row] = padded
    return out


def projection_topk(coords: np.ndarray, idx: np.ndarray, k: int) -> np.ndarray:
    """(S, k) int array: euclidean top-k in PROJECTION coordinates for sampled rows."""
    data = np.asarray(coords, dtype=np.float32)
    out = np.empty((len(idx), k), dtype=np.int64)
    for row, self_i in enumerate(idx):
        diff = data - data[self_i]
        dist = np.sqrt(np.einsum("ij,ij->i", diff, diff))
        top = _topk_excluding_self(-dist, int(self_i), k)
        padded = np.full(k, -1, dtype=np.int64)
        padded[: top.shape[0]] = top
        out[row] = padded
    return out


def neighbor_retention(orig_topk: np.ndarray, proj_topk: np.ndarray) -> float:
    """Mean |orig∩proj| / k over sampled points (rows with valid neighbors only)."""
    shares: list[float] = []
    for orig_row, proj_row in zip(orig_topk, proj_topk, strict=True):
        orig_set = {int(i) for i in orig_row if i >= 0}
        proj_set = {int(i) for i in proj_row if i >= 0}
        if not orig_set:
            continue
        shares.append(len(orig_set & proj_set) / len(orig_set))
    if not shares:
        raise MetricsInputError("no sampled points with computable neighbors")
    return float(np.mean(shares))


def trustworthiness(
    vectors: np.ndarray, coords: np.ndarray, idx: np.ndarray, k: int
) -> tuple[float, int]:
    """sklearn trustworthiness on the sampled rows; returns (value, k_used).

    sklearn requires n_neighbors < n_samples / 2 — on small samples k is
    reduced and the ACTUAL k used is returned, so the stored result never
    lies about its parameters.
    """
    from sklearn.manifold import trustworthiness as sk_trustworthiness

    n = len(idx)
    if n < 4:
        raise MetricsInputError("trustworthiness needs at least 4 sampled points")
    k_used = int(max(1, min(k, (n - 1) // 2)))
    value = float(
        sk_trustworthiness(
            np.asarray(vectors, dtype=np.float32)[idx],
            np.asarray(coords, dtype=np.float32)[idx],
            n_neighbors=k_used,
        )
    )
    return value, k_used


def relation_pairs_from_rows(
    rows: Iterable[tuple[str | None, str | None, str | None, str | None, str]],
    kinds: Sequence[str] | None = None,
) -> set[frozenset[str]]:
    """Known relation pairs as a set of frozensets(fragment_id_a, fragment_id_b).

    Only rows with BOTH ends resolved to fragments count; `kinds` (None = all)
    filters by relation kind. Direction is dropped (the metrics treat structural
    relatedness as symmetric — documented in the explanations).
    """
    pairs: set[frozenset[str]] = set()
    kind_filter = set(kinds) if kinds else None
    for source_frag, target_frag, _source_file, _target_file, kind in rows:
        if kind_filter is not None and kind not in kind_filter:
            continue
        if source_frag and target_frag and source_frag != target_frag:
            pairs.add(frozenset((source_frag, target_frag)))
    return pairs


def relation_metrics(
    ids: Sequence[str],
    orig_topk: np.ndarray,
    idx: np.ndarray,
    pairs: set[frozenset[str]],
) -> dict[str, object]:
    """precision@k / coverage@k against KNOWN relations (incompleteness-aware)."""
    index_of = {fid: i for i, fid in enumerate(ids)}
    # per-fragment known partners (only pairs whose both ends have vectors)
    partners: dict[int, set[int]] = {}
    embedded_pairs: list[tuple[int, int]] = []
    for pair in pairs:
        a, b = sorted(pair)
        ia, ib = index_of.get(a), index_of.get(b)
        if ia is None or ib is None:
            continue
        partners.setdefault(ia, set()).add(ib)
        partners.setdefault(ib, set()).add(ia)
        embedded_pairs.append((ia, ib))

    # precision over sampled points that HAVE known partners
    per_point: list[float] = []
    for row, self_i in enumerate(idx):
        known = partners.get(int(self_i))
        if not known:
            continue
        neighbors = {int(j) for j in orig_topk[row] if j >= 0}
        if not neighbors:
            continue
        per_point.append(len(neighbors & known) / len(neighbors))
    precision: float | None = float(np.mean(per_point)) if per_point else None

    # coverage over known pairs where the SOURCE end was sampled
    sampled = {int(i) for i in idx}
    topk_of_sampled = {
        int(self_i): {int(j) for j in orig_topk[row] if j >= 0} for row, self_i in enumerate(idx)
    }
    considered = 0
    covered = 0
    for ia, ib in embedded_pairs:
        hit = False
        if ia in sampled:
            considered += 1
            hit = ib in topk_of_sampled[ia]
        elif ib in sampled:
            considered += 1
            hit = ia in topk_of_sampled[ib]
        if hit:
            covered += 1
    coverage: float | None = float(covered / considered) if considered else None

    return {
        "relation_precision": precision,
        "relation_coverage": coverage,
        "n_sampled_with_relations": len(per_point),
        "n_known_pairs_embedded": len(embedded_pairs),
        "n_pairs_considered": considered,
    }


def compute_metric_bundle(
    vectors: np.ndarray,
    coords: np.ndarray | None,
    ids: Sequence[str],
    k: int,
    sample: int,
    seed: int,
    pairs: set[frozenset[str]],
) -> dict[str, object]:
    """Run every applicable metric; returns {"metrics": {...}, "warnings": [...]}.

    `coords` are projection coordinates aligned to `ids` (None → only the
    relation metrics are computed — projection quality needs a projection).
    """
    n = len(ids)
    if vectors.shape[0] != n:
        raise MetricsInputError("vectors and ids disagree in length")
    if k < 1:
        raise MetricsInputError("k must be >= 1")

    warnings: list[str] = []
    k_eff = min(k, max(1, n - 1))
    if k_eff != k:
        warnings.append(f"k reduced to {k_eff}: the corpus has only {n} vectors")

    idx = sample_indices(n, sample, seed)
    orig = original_topk(vectors, idx, k_eff)

    metrics: dict[str, object] = {}

    rel = relation_metrics(ids, orig, idx, pairs)
    precision = rel.pop("relation_precision")
    coverage = rel.pop("relation_coverage")
    metrics["relation_precision"] = {
        "value": precision,
        "k": k_eff,
        "explanation": METRIC_EXPLANATIONS["relation_precision"],
        **rel,
    }
    metrics["relation_coverage"] = {
        "value": coverage,
        "k": k_eff,
        "explanation": METRIC_EXPLANATIONS["relation_coverage"],
        **rel,
    }
    if precision is None:
        warnings.append(
            "relation_precision not computed: no sampled fragment has known "
            "relations (extract/import relations first)"
        )
    if coverage is None:
        warnings.append(
            "relation_coverage not computed: no known relation pair has both ends embedded"
        )

    if coords is not None:
        proj = projection_topk(coords, idx, k_eff)
        metrics["neighbor_retention"] = {
            "value": neighbor_retention(orig, proj),
            "k": k_eff,
            "n_sampled": len(idx),
            "explanation": METRIC_EXPLANATIONS["neighbor_retention"],
        }
        try:
            trust_value, trust_k = trustworthiness(vectors, coords, idx, k_eff)
            metrics["trustworthiness"] = {
                "value": trust_value,
                "k": trust_k,
                "n_sampled": len(idx),
                "explanation": METRIC_EXPLANATIONS["trustworthiness"],
            }
            if trust_k != k_eff:
                warnings.append(
                    f"trustworthiness computed with k={trust_k} "
                    f"(sklearn requires k < n_sampled/2, sample={len(idx)})"
                )
        except (MetricsInputError, ValueError) as exc:
            warnings.append(f"trustworthiness not computed: {exc}")
    else:
        warnings.append(
            "projection metrics skipped: no projection run was given "
            "(relation metrics are computed over the ORIGINAL space)"
        )

    return {
        "metrics": metrics,
        "warnings": warnings,
        "sample": {"n_vectors": n, "n_sampled": len(idx), "k": k_eff, "seed": seed},
    }
