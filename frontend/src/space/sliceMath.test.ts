/**
 * sliceMath tests: the client-side half of the slice contract — membership
 * must match the backend formula (|u - position| <= thickness/2, inclusive)
 * and masks must only apply to clouds of the SAME embedding run.
 */

import { describe, expect, it } from "vitest";

import { brightIndices, cloudSliceMask, inLayer, sliceMasksForCloud } from "./sliceMath";

const IDS = ["fA", "fB", "fC", "fD"];
const U = new Map<string, number>([
  ["fA", -3],
  ["fB", 0],
  ["fC", 2.5],
  ["fD", 9],
]);

describe("inLayer", () => {
  it("inclusive boundaries, exact formula", () => {
    expect(inLayer(0, { position: 0, thickness: 2 })).toBe(true); // |0| <= 1
    expect(inLayer(1, { position: 0, thickness: 2 })).toBe(true); // boundary
    expect(inLayer(-1, { position: 0, thickness: 2 })).toBe(true);
    expect(inLayer(1.01, { position: 0, thickness: 2 })).toBe(false);
    expect(inLayer(5, { position: 0, thickness: 0 })).toBe(false);
    expect(inLayer(5, { position: 5, thickness: 0 })).toBe(true); // zero window at the point
  });
});

describe("cloudSliceMask", () => {
  it("masks by membership and counts unknown fragments honestly", () => {
    const res = cloudSliceMask(IDS, U, { position: 0, thickness: 5 });
    // window [-2.5, 2.5]: fA(-3) out, fB(0) in, fC(2.5) boundary IN, fD(9) out
    expect(Array.from(res.mask)).toEqual([0, 1, 1, 0]);
    expect(res.inLayer).toBe(2);
    expect(res.unknown).toBe(0);
  });

  it("fragments missing from the u map are outside AND counted", () => {
    const partial = new Map<string, number>([["fA", 0]]);
    const res = cloudSliceMask(IDS, partial, { position: 0, thickness: 1 });
    expect(Array.from(res.mask)).toEqual([1, 0, 0, 0]);
    expect(res.unknown).toBe(3);
  });
});

describe("sliceMasksForCloud", () => {
  const source = { embeddingRunId: "emb1", position: 0, thickness: 5, uById: U };

  it("'only' hides out-of-layer points; 'dim' marks them for fading", () => {
    const only = sliceMasksForCloud(IDS, source, "emb1", "only");
    expect(only?.mask && Array.from(only.mask)).toEqual([0, 1, 1, 0]);
    expect(only?.dimMask).toBeNull();
    expect(only?.inLayer).toBe(2);

    const dim = sliceMasksForCloud(IDS, source, "emb1", "dim");
    expect(dim?.mask).toBeNull();
    expect(dim?.dimMask && Array.from(dim.dimMask)).toEqual([1, 0, 0, 1]);
  });

  it("never applies to a cloud of ANOTHER embedding run (honesty)", () => {
    expect(sliceMasksForCloud(IDS, source, "embOTHER", "only")).toBeNull();
  });

  it("display=off disables the overlay", () => {
    expect(sliceMasksForCloud(IDS, source, "emb1", "off")).toBeNull();
  });
});

describe("brightIndices", () => {
  it("no masks -> every index once", () => {
    expect(Array.from(brightIndices(4, null, null))).toEqual([0, 1, 2, 3]);
  });

  it("mask keeps only in-layer points", () => {
    const mask = Uint8Array.from([1, 0, 1, 0]);
    expect(Array.from(brightIndices(4, mask, null))).toEqual([0, 2]);
  });

  it("dimMask removes dimmed points from the bright buffer (drawn once)", () => {
    const dim = Uint8Array.from([0, 1, 1, 0]);
    expect(Array.from(brightIndices(4, null, dim))).toEqual([0, 3]);
  });

  it("mask AND dimMask compose (4D window + dim slice)", () => {
    const mask = Uint8Array.from([1, 1, 1, 0]); // 4D window hides index 3
    const dim = Uint8Array.from([0, 1, 0, 0]); // slice dims index 1
    // bright = in the window and not dimmed -> 0 and 2
    expect(Array.from(brightIndices(4, mask, dim))).toEqual([0, 2]);
  });
});
