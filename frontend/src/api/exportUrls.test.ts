import { describe, expect, it } from "vitest";

import { exportUrls } from "./client";
import { fileNameFromDisposition } from "./download";

describe("exportUrls", () => {
  it("builds the projection points URL with the format", () => {
    expect(exportUrls.projectionPoints("p1", "proj1")).toBe(
      "/api/projects/p1/exports/projection/proj1/points?format=csv",
    );
    expect(exportUrls.projectionPoints("p1", "proj1", "json")).toContain("format=json");
  });

  it("encodes relation filters and omits empty ones", () => {
    const url = exportUrls.relations("p1", { kind: "imports", origin: "" }, "json");
    expect(url).toContain("format=json");
    expect(url).toContain("kind=imports");
    expect(url).not.toContain("origin");
    expect(exportUrls.relations("p1")).toBe("/api/projects/p1/exports/relations?format=csv");
  });

  it("builds metric/experiment/fragments URLs", () => {
    expect(exportUrls.metricRun("p1", "m1")).toBe("/api/projects/p1/exports/metrics/m1");
    expect(exportUrls.experiment("p1", "e1")).toBe("/api/projects/p1/exports/experiments/e1");
    expect(exportUrls.fragments("p1")).toBe("/api/projects/p1/exports/fragments");
  });
});

describe("fileNameFromDisposition", () => {
  it("parses a plain filename", () => {
    expect(fileNameFromDisposition("attachment; filename=points.csv", "f.csv")).toBe("points.csv");
  });

  it("parses a quoted filename", () => {
    expect(
      fileNameFromDisposition('attachment; filename="projection_ab12_points.csv"', "f.csv"),
    ).toBe("projection_ab12_points.csv");
  });

  it("decodes the RFC 5987 form", () => {
    expect(
      fileNameFromDisposition("attachment; filename*=UTF-8''%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5.csv", "f.csv"),
    ).toBe("данные.csv");
  });

  it("falls back when the header is missing or unparseable", () => {
    expect(fileNameFromDisposition(null, "fallback.csv")).toBe("fallback.csv");
    expect(fileNameFromDisposition("inline", "fallback.csv")).toBe("fallback.csv");
  });
});
