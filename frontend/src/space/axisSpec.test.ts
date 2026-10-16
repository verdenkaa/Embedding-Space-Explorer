/**
 * axisSpec tests: parsing/validation of the raw-axes field, including the
 * multi-plot form ("0,1;0,2") — pure logic, no DOM.
 */

import { describe, expect, it } from "vitest";

import { MAX_AXIS_SETS, axesSetsKey, parseAxesInput } from "./axisSpec";

describe("parseAxesInput — single group", () => {
  it("parses comma/space separated indices", () => {
    expect(parseAxesInput("12, 57", 384)).toEqual({
      sets: [[12, 57]],
      multi: false,
      problem: null,
    });
    expect(parseAxesInput("0 1 2", null).sets).toEqual([[0, 1, 2]]);
    expect(parseAxesInput("12, 57, 200, 300", 384).sets).toEqual([[12, 57, 200, 300]]);
  });

  it("empty input is not an error by itself (build gating handles it)", () => {
    expect(parseAxesInput("", 384)).toEqual({ sets: [], multi: false, problem: null });
    expect(parseAxesInput("  ;  ", 384).sets).toEqual([]);
  });

  it("rejects non-integers, duplicates, out-of-range and wrong counts", () => {
    expect(parseAxesInput("12, x", 384).problem).toMatch(/только целые/);
    expect(parseAxesInput("12, 12", 384).problem).toMatch(/не должны повторяться/);
    expect(parseAxesInput("12, 400", 384).problem).toMatch(/вне диапазона 0\.\.383/);
    expect(parseAxesInput("12", 384).problem).toMatch(/от 2 до 4/);
    expect(parseAxesInput("1, 2, 3, 4, 5", 384).problem).toMatch(/от 2 до 4/);
    // without dimHint the range check is skipped (backend re-validates)
    expect(parseAxesInput("12, 400", null).problem).toBeNull();
  });
});

describe("parseAxesInput — multi group", () => {
  it("parses several pairs and flags multi mode", () => {
    const parsed = parseAxesInput("0,1;0,2", 384);
    expect(parsed).toEqual({
      sets: [
        [0, 1],
        [0, 2],
      ],
      multi: true,
      problem: null,
    });
  });

  it("every group must be a PAIR in multi mode", () => {
    expect(parseAxesInput("0,1,2;0,3", 384).problem).toMatch(/ровно 2 оси/);
    expect(parseAxesInput("0,1;7", 384).problem).toMatch(/ровно 2 оси/);
  });

  it("rejects duplicate groups and more than MAX_AXIS_SETS plots", () => {
    expect(parseAxesInput("0,1;0,1", 384).problem).toMatch(/группы не должны повторяться/);
    // reversed pairs are DIFFERENT plots (axis order matters)
    expect(parseAxesInput("0,1;1,0", 384).problem).toBeNull();
    const many = Array.from({ length: MAX_AXIS_SETS + 1 }, (_, i) => `0,${i + 1}`).join(";");
    expect(parseAxesInput(many, 384).problem).toMatch(/не больше 6 групп/);
  });

  it("range and integer checks apply inside every group", () => {
    expect(parseAxesInput("0,1;0,999", 384).problem).toMatch(/вне диапазона/);
    expect(parseAxesInput("0,1;a,2", 384).problem).toMatch(/только целые/);
  });
});

describe("axesSetsKey", () => {
  it("is a stable canonical form for echo comparisons", () => {
    expect(axesSetsKey([[0, 1], [2, 3]])).toBe("0,1;2,3");
    expect(axesSetsKey([])).toBe("");
    expect(axesSetsKey(null)).toBe("");
  });
});
