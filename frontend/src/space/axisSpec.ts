/**
 * Parsing/validation of the raw-axes field ("12, 57", "0,1,2", "0,1;0,2").
 *
 * One group = one plot: a single group of 2..4 axes builds one projection
 * (2D/3D/4D by the axis count); several `;`-separated PAIRS build several
 * 2D projections compared side by side (multi-plot mode, raw_axes only).
 * Pure module — unit-tested without DOM.
 */

/** Hard cap on side-by-side 2D plots (more is unreadable on a normal screen). */
export const MAX_AXIS_SETS = 6;

export interface AxesParseResult {
  /** Parsed groups in input order (empty when nothing parseable). */
  sets: number[][];
  /** true when the input describes several plots ("a,b;c,d"). */
  multi: boolean;
  /** Human-facing problem (ru) or null when the input is valid. */
  problem: string | null;
}

export function parseAxesInput(text: string, dimHint: number | null): AxesParseResult {
  const groups = text
    .split(";")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
  if (groups.length === 0) {
    return { sets: [], multi: false, problem: null };
  }

  const sets: number[][] = [];
  for (const group of groups) {
    const tokens = group
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const nums: number[] = [];
    for (const token of tokens) {
      if (!/^\d+$/.test(token)) {
        return fail(sets, "только целые неотрицательные индексы через запятую");
      }
      nums.push(Number.parseInt(token, 10));
    }
    if (new Set(nums).size !== nums.length) {
      return fail(sets, "оси внутри одной группы не должны повторяться");
    }
    if (dimHint !== null) {
      const bad = nums.find((n) => n >= dimHint);
      if (bad !== undefined) {
        return fail(sets, `индекс ${bad} вне диапазона 0..${dimHint - 1}`);
      }
    }
    sets.push(nums);
  }

  if (sets.length > MAX_AXIS_SETS) {
    return fail(sets, `не больше ${MAX_AXIS_SETS} групп через «;» (графиков рядом)`);
  }
  const seen = new Set(sets.map((s) => s.join(",")));
  if (seen.size !== sets.length) {
    return fail(sets, "группы не должны повторяться");
  }

  if (sets.length > 1) {
    const bad = sets.find((s) => s.length !== 2);
    if (bad !== undefined) {
      return fail(
        sets,
        "для нескольких графиков каждая группа — ровно 2 оси (например 0,1;0,2)",
      );
    }
    return { sets, multi: true, problem: null };
  }

  const only = sets[0];
  if (only.length < 2 || only.length > 4) {
    return fail(sets, "нужно от 2 до 4 осей");
  }
  return { sets, multi: false, problem: null };
}

function fail(sets: number[][], problem: string): AxesParseResult {
  return { sets, multi: sets.length > 1, problem };
}

/** Canonical text of parsed sets (for store sync comparisons). */
export function axesSetsKey(sets: number[][] | null): string {
  return (sets ?? []).map((s) => s.join(",")).join(";");
}
