"""Pure metric computations over numpy arrays (unit-testable, no IO).

Definitions:

- neighbor_retention@k  — mean share of the ORIGINAL-space k nearest
  neighbors (cosine over embeddings) that remain within the projection's
  k nearest neighbors (euclidean over projection coordinates). 1.0 = the map
  kept every original neighbor close; 0.0 = none kept.
- trustworthiness@k     — rank-based, over the FULL population: queries are
  the sampled rows (the same population as retention), but neighbor ranks
  span ALL N points (original = cosine, projection = euclidean).
  1 − normalized penalty for FALSE neighbors (points close in the
  projection but far in the original space). Formula identical to
  sklearn.manifold.trustworthiness; sklearn itself would rank only WITHIN
  the sample — a different, incomparable task at sample < N.
- relation_precision@k  — among sampled fragments that HAVE known structural
  relations, the mean share of their original-space top-k neighbors that are
  among those known relations. NOT a classical precision: unknown pairs are
  treated as UNKNOWN (corpus incompleteness), never as negatives.
- relation_coverage@k   — share of known relation ARC directions (both ends
  embedded) whose target appears in the source's original-space top-k.
  Relations are treated as symmetric: every pair contributes one arc per
  sampled endpoint (two arcs when both ends are sampled) — top-k
  neighborhoods are directional, so each direction is checked on its own.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

import numpy as np

METRIC_EXPLANATIONS: dict[str, str] = {
    "neighbor_retention": (
        "Средняя доля k ближайших соседей ИСХОДНОГО пространства (cosine), "
        "оставшихся в k ближайших окрестниках проекции (euclidean). 1.0 — карта "
        "сохранила всех соседей, 0.0 — никого. Для UMAP осмысленна только "
        "локальная сохранность (нелинейная проекция искажает глобальные расстояния)."
    ),
    "trustworthiness": (
        "1 минус нормированный штраф за «ложных соседей» — точки, попавшие в топ-k "
        "проекции (euclidean), но далёкие в топ-k ИСХОДНОГО пространства (cosine). "
        "Запросы — точки выборки, ранги и соседи — среди ВСЕХ N точек (та же "
        "популяция, что у neighbor_retention; формула sklearn, но без её сужения "
        "до выборки). 1.0 — ложных соседей нет."
    ),
    "relation_precision": (
        "Доля топ-k соседей ИСХОДНОГО пространства, приходящихся на ИЗВЕСТНЫЕ "
        "структурные связи фрагмента (усреднение по фрагментам, у которых есть "
        "хотя бы одна известная связь). ВАЖНО: отсутствие известной связи НЕ "
        "считается доказательством отсутствия связи (корпус связей неполон) — "
        "это мера согласия с известными связями, а не классический precision. "
        "baseline — ожидаемое согласие при случайном ранжировании "
        "(|known|/(N−1)); lift = value/baseline. Связи belongs_to почти "
        "тривиальны (текст родителя содержит текст ребёнка), поэтому смотрите "
        "разбивку по видам связей и lift, а не смешанное значение."
    ),
    "relation_coverage": (
        "Доля НАПРАВЛЕНИЙ известных структурных пар (оба конца с векторами), у "
        "которых цель попала в топ-k соседей источника в ИСХОДНОМ пространстве. "
        "Связь трактуется симметрично: пара даёт по направлению на каждый её "
        "попавший в выборку конец (два направления, если оба конца в выборке) — "
        "топ-k окрестности несимметричны, каждое направление проверяется отдельно. "
        "baseline — ожидаемая доля при случайном ранжировании (k/(N−1)); "
        "lift = value/baseline. Низкое значение при малом числе известных пар — "
        "не вывод о геометрии, а следствие неполноты корпуса."
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
    """Indices of the k best rows of a score vector (higher = closer), self excluded.

    Ties are broken by ASCENDING POSITION (stable full argsort) — exactly the
    rule neighbor_search.knn uses, so metric neighborhoods and UI neighbors
    never disagree at the k boundary (duplicate fragments → identical scores
    are common). argpartition was faster but picked among boundary ties
    arbitrarily.
    """
    scores = similarity_or_negdist.copy()
    scores[self_index] = -np.inf
    k_eff = int(min(k, scores.shape[0] - 1))
    if k_eff <= 0:
        return np.empty(0, dtype=np.int64)
    # descending by score, stable by position: negate, then stable ascending
    return np.argsort(-scores, kind="stable")[:k_eff]


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
    """Rank-based trustworthiness over the FULL population; (value, k_used).

    Queries are the sampled rows — the same population neighbor_retention
    uses — but ranks and neighborhoods span ALL N points: original space =
    cosine over embeddings, projection = euclidean over coordinates. sklearn's
    own implementation would rank only WITHIN the sample (a different task at
    sample < N, incomparable with retention), so the formula is implemented
    here directly, matching sklearn value-for-value when the sample IS the
    whole population (cross-checked in tests):

        T(k) = 1 − 2 / (S·k·(2N−3k−1)) · Σ_{i∈S} Σ_{j∈U_i} (r_orig(i,j) − k)

    U_i — points in the projection's top-k but not in the original top-k;
    r_orig — 1-based original-space rank, self excluded, ties by ascending
    position (the deterministic order used everywhere in this module).
    k is capped so the normalizer stays positive: k ≤ (2N−2)/3; the ACTUAL
    k used is returned, so the stored result never lies about its parameters.
    """
    data = np.asarray(vectors, dtype=np.float32)
    n = int(data.shape[0])
    s = len(idx)
    if s < 4:
        raise MetricsInputError("trustworthiness needs at least 4 sampled points")
    k_used = int(max(1, min(k, max(1, min((2 * n - 2) // 3, n - 1)))))

    orig = original_topk(vectors, idx, k_used)  # (S, k) cosine, against all N
    proj = projection_topk(coords, idx, k_used)  # (S, k) euclidean, against all N

    norms = np.linalg.norm(data, axis=1, keepdims=True)
    safe = np.where(norms == 0, 1.0, norms)
    unit = data / safe
    sims = unit[idx] @ unit.T  # (S, N) cosine; self excluded from ranks below
    sims[np.arange(s), idx] = -np.inf
    positions = np.arange(n, dtype=np.int64)

    penalty = 0.0
    for row in range(s):
        orig_set = {int(j) for j in orig[row] if j >= 0}
        false_nn = np.asarray(
            [int(j) for j in proj[row] if j >= 0 and int(j) not in orig_set], dtype=np.int64
        )
        if false_nn.size == 0:
            continue
        sims_row = sims[row]
        target = sims_row[false_nn][:, None]  # (m, 1)
        # rank = 1 + #{strictly closer} + #{equal score at an earlier position}
        greater = (sims_row[None, :] > target).sum(axis=1)
        equal_before = (
            (sims_row[None, :] == target) & (positions[None, :] < false_nn[:, None])
        ).sum(axis=1)
        penalty += float(np.sum(greater + equal_before + 1 - k_used))

    normalizer = s * k_used * (2 * n - 3 * k_used - 1)
    return 1.0 - 2.0 * penalty / float(normalizer), k_used


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
    *,
    n_population: int,
    k: int,
) -> dict[str, object]:
    """precision@k / coverage@k against KNOWN relations (incompleteness-aware).

    Also returns the RANDOM-RANKING baseline and lift for both metrics
    (audit #4): without a baseline a high agreement means nothing —
    belongs_to pairs (parent text contains child text) agree almost
    regardless of the embedding quality.

        precision baseline = mean(|known_i| / (N-1)) over the same points
        coverage  baseline = k / (N-1)
        lift                 = value / baseline
    """
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
    known_sizes: list[float] = []
    for row, self_i in enumerate(idx):
        known = partners.get(int(self_i))
        if not known:
            continue
        neighbors = {int(j) for j in orig_topk[row] if j >= 0}
        if not neighbors:
            continue
        per_point.append(len(neighbors & known) / len(neighbors))
        known_sizes.append(len(known))
    precision: float | None = float(np.mean(per_point)) if per_point else None

    # coverage over ARC DIRECTIONS whose SOURCE end was sampled: top-k
    # neighborhoods are directional, so a pair with both ends in the sample
    # contributes two arcs and each is checked on its own (the old code
    # checked an arbitrary single direction chosen by id sort order)
    sampled = {int(i) for i in idx}
    topk_of_sampled = {
        int(self_i): {int(j) for j in orig_topk[row] if j >= 0} for row, self_i in enumerate(idx)
    }
    considered = 0
    covered = 0
    for ia, ib in embedded_pairs:
        for src, dst in ((ia, ib), (ib, ia)):
            if src not in sampled:
                continue
            considered += 1
            if dst in topk_of_sampled[src]:
                covered += 1
    coverage: float | None = float(covered / considered) if considered else None

    # random-ranking baselines
    denom = n_population - 1
    precision_baseline: float | None = None
    if per_point and denom > 0:
        precision_baseline = float(np.mean([s / denom for s in known_sizes]))
    coverage_baseline: float | None = None
    if considered and denom > 0:
        coverage_baseline = k / denom

    def lift(value: float | None, baseline: float | None) -> float | None:
        if value is None or baseline is None or baseline <= 0:
            return None
        return value / baseline

    return {
        "precision": precision,
        "precision_baseline": precision_baseline,
        "precision_lift": lift(precision, precision_baseline),
        "coverage": coverage,
        "coverage_baseline": coverage_baseline,
        "coverage_lift": lift(coverage, coverage_baseline),
        "counts": {
            "n_sampled_with_relations": len(per_point),
            "n_known_pairs_embedded": len(embedded_pairs),
            # arcs whose source was sampled (a pair with both ends sampled → 2)
            "n_pairs_considered": considered,
        },
    }


def _relation_metric_entries(rel: dict[str, object], k_eff: int) -> dict[str, dict[str, object]]:
    """Build the two relation metric blocks (value + baseline + lift + counts)."""
    counts = rel["counts"]
    assert isinstance(counts, dict)
    return {
        "relation_precision": {
            "value": rel["precision"],
            "baseline": rel["precision_baseline"],
            "lift": rel["precision_lift"],
            "k": k_eff,
            "explanation": METRIC_EXPLANATIONS["relation_precision"],
            **counts,
        },
        "relation_coverage": {
            "value": rel["coverage"],
            "baseline": rel["coverage_baseline"],
            "lift": rel["coverage_lift"],
            "k": k_eff,
            "explanation": METRIC_EXPLANATIONS["relation_coverage"],
            **counts,
        },
    }


def compute_metric_bundle(
    vectors: np.ndarray,
    coords: np.ndarray | None,
    ids: Sequence[str],
    k: int,
    sample: int,
    seed: int,
    pairs: set[frozenset[str]],
    pairs_by_kind: Mapping[str, set[frozenset[str]]] | None = None,
) -> dict[str, object]:
    """Run every applicable metric; returns {"metrics": {...}, "warnings": [...]}.

    `pairs_by_kind` (optional) adds a per-relation-kind breakdown of the
    relation metrics over the SAME top-k/sample — mixed values are dominated
    by trivial belongs_to pairs, per-kind numbers are what's interpretable.

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

    rel = relation_metrics(ids, orig, idx, pairs, n_population=n, k=k_eff)
    metrics.update(_relation_metric_entries(rel, k_eff))
    precision = rel["precision"]
    coverage = rel["coverage"]
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
            "n_population": n,
            "explanation": METRIC_EXPLANATIONS["neighbor_retention"],
        }
        try:
            trust_value, trust_k = trustworthiness(vectors, coords, idx, k_eff)
            metrics["trustworthiness"] = {
                "value": trust_value,
                "k": trust_k,
                "n_sampled": len(idx),
                "n_population": n,
                "explanation": METRIC_EXPLANATIONS["trustworthiness"],
            }
            if trust_k != k_eff:
                warnings.append(
                    f"trustworthiness computed with k={trust_k} "
                    f"(the normalizer requires k <= (2N-2)/3, N={n})"
                )
        except (MetricsInputError, ValueError) as exc:
            warnings.append(f"trustworthiness not computed: {exc}")
    else:
        warnings.append(
            "projection metrics skipped: no projection run was given "
            "(relation metrics are computed over the ORIGINAL space)"
        )

    per_kind: dict[str, object] = {}
    if pairs_by_kind:
        for kind in sorted(pairs_by_kind):
            kind_pairs = pairs_by_kind[kind]
            if not kind_pairs:
                continue
            krel = relation_metrics(ids, orig, idx, kind_pairs, n_population=n, k=k_eff)
            per_kind[kind] = _relation_metric_entries(krel, k_eff)

    return {
        "metrics": metrics,
        "per_kind": per_kind,
        "warnings": warnings,
        "sample": {"n_vectors": n, "n_sampled": len(idx), "k": k_eff, "seed": seed},
    }
