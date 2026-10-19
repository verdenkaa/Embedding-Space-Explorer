/**
 * ViewBar tests (top bar of the SPACE center column): the view-mode toggle,
 * the projection selectors that only appear for the ACTIVE mode(s), and the
 * cleanup buttons (delete the shown projection / delete everything computed
 * with an inline confirmation).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectionPoints, ProjectionRunDTO } from "../../api/types";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { buildCloud, useSpaceStore } from "../../state/spaceStore";
import { ViewBar } from "./ViewBar";

function run(id: string, nc: number, overrides: Partial<ProjectionRunDTO> = {}): ProjectionRunDTO {
  return {
    id,
    embedding_run_id: "emb1",
    method: "pca",
    method_display_name: "PCA",
    n_components: nc,
    params: {},
    seed: 42,
    axis_labels: Array.from({ length: nc }, (_, i) => `PC${i + 1}`),
    axis_info: null,
    count: 1,
    stale: false,
    cache_ok: true,
    versions: {},
    created_at: "",
    updated_at: "2026-10-15T12:00:00+00:00",
    ...overrides,
  };
}

function points(nc: number, id: string): ProjectionPoints {
  return {
    projection_id: id,
    method: "pca",
    method_display_name: "PCA",
    n_components: nc,
    axis_labels: Array.from({ length: nc }, (_, i) => `PC${i + 1}`),
    axis_info: null,
    stale: false,
    count: 1,
    dropped_orphans: 0,
    points: [
      {
        fragment_id: "fragA",
        file_id: "fa",
        rel_path: "a.py",
        kind: "method",
        name: "m",
        symbol_path: "C.m",
        start_line: 1,
        end_line: 2,
        coords: Array.from({ length: nc }, (_, i) => i * 0.1),
      },
    ],
  };
}

const INVENTORY = [
  run("p3", 3, { stale: true }),
  run("p2a", 2),
  run("p2b", 2, { method: "raw_axes", method_display_name: "Сырые оси", params: { axes: [0, 1] } }),
  run("p4", 4),
  run("pBroken", 3, { cache_ok: false }),
];

beforeEach(() => {
  vi.unstubAllGlobals();
  useProjectStore.setState({ current: { id: "p1", name: "Sample" } as never });
  useExperimentStore.setState({
    projections: INVENTORY,
    deleteProjection: vi.fn(async () => undefined),
    deleteAllProjections: vi.fn(async () => undefined),
    error: null,
  });
  useSpaceStore.setState({
    cloud3d: null,
    clouds2d: [],
    cloud4d: null,
    loading3d: false,
    loading2d: false,
    loading4d: false,
    error: null,
    viewMode: "3d",
    colorBy: "kind",
    gridMode: "simple",
    clusterLabels: null,
  });
});

afterEach(cleanup);

describe("ViewBar selectors follow the active mode", () => {
  it("3D mode shows only the 3D selector with cached 3-component runs", () => {
    render(<ViewBar />);
    const select = screen.getByLabelText("Проекция для 3D-вида") as HTMLSelectElement;
    expect(screen.queryByLabelText("Проекция для 2D-вида")).toBeNull();
    expect(screen.queryByLabelText("Проекция для 4D-вида")).toBeNull();
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("p3");
    expect(values).not.toContain("p2a"); // other component count
    expect(values).not.toContain("pBroken"); // damaged cache is not selectable
    expect(values).not.toContain("p4");
    // staleness travels in the label (honest inventory)
    expect(Array.from(select.options).find((o) => o.value === "p3")?.textContent).toContain(
      "УСТАРЕЛА",
    );
  });

  it("split mode shows the 3D and 2D selectors, 4D mode shows the 4D one", () => {
    useSpaceStore.setState({ viewMode: "split" });
    const { unmount } = render(<ViewBar />);
    expect(screen.getByLabelText("Проекция для 3D-вида")).toBeTruthy();
    expect(screen.getByLabelText("Проекция для 2D-вида")).toBeTruthy();
    expect(screen.queryByLabelText("Проекция для 4D-вида")).toBeNull();
    unmount();

    useSpaceStore.setState({ viewMode: "4d" });
    render(<ViewBar />);
    expect(screen.getByLabelText("Проекция для 4D-вида")).toBeTruthy();
    expect(screen.queryByLabelText("Проекция для 3D-вида")).toBeNull();
  });

  it("view-mode toggle has 3D / 2D / 4D / 3D+2D", () => {
    render(<ViewBar />);
    const toggle = screen.getByRole("group", { name: "Режим представления" });
    expect(toggle.textContent).toContain("3D");
    expect(toggle.textContent).toContain("2D");
    expect(toggle.textContent).toContain("4D");
    fireEvent.click(screen.getByRole("button", { name: /^4D$/ }));
    expect(useSpaceStore.getState().viewMode).toBe("4d");
  });

  it("choosing a projection activates it in the space store", () => {
    useSpaceStore.setState({ viewMode: "split" });
    const setActive = vi.fn(async () => undefined);
    useSpaceStore.setState({ setActiveProjection: setActive });
    render(<ViewBar />);
    fireEvent.change(screen.getByLabelText("Проекция для 3D-вида"), {
      target: { value: "p3" },
    });
    expect(setActive).toHaveBeenCalledWith("3d", "p3");
    // "— нет —" clears the view
    fireEvent.change(screen.getByLabelText("Проекция для 3D-вида"), {
      target: { value: "" },
    });
    expect(setActive).toHaveBeenLastCalledWith("3d", null);
  });
});

describe("ViewBar cleanup", () => {
  it("✕ deletes the projection currently shown in that view", () => {
    useSpaceStore.setState({ cloud3d: buildCloud(points(3, "p3"), run("p3", 3)) });
    render(<ViewBar />);
    const del = screen.getByLabelText("Удалить проекцию 3D-вида");
    expect((del as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(del);
    expect(useExperimentStore.getState().deleteProjection).toHaveBeenCalledWith("p3");
  });

  it("✕ is disabled while nothing is shown", () => {
    render(<ViewBar />);
    const del = screen.getByLabelText("Удалить проекцию 3D-вида");
    expect((del as HTMLButtonElement).disabled).toBe(true);
  });

  it("multi-plot 2D: placeholder in the select, ✕ disabled (use «Удалить все»)", () => {
    useSpaceStore.setState({
      viewMode: "2d",
      clouds2d: [
        buildCloud(points(2, "p2a"), run("p2a", 2)),
        buildCloud(points(2, "p2b"), run("p2b", 2)),
      ],
    });
    render(<ViewBar />);
    const select = screen.getByLabelText("Проекция для 2D-вида") as HTMLSelectElement;
    expect(select.value).toBe("__multi__");
    expect(select.options[0].textContent).toContain("несколько (2)");
    expect((screen.getByLabelText("Удалить проекцию 2D-вида") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("«Удалить все» asks for an inline confirmation before wiping", () => {
    render(<ViewBar />);
    const all = screen.getByRole("button", { name: /Удалить все \(5\)/ });
    fireEvent.click(all);
    // armed: yes/no appear, nothing deleted yet
    expect(useExperimentStore.getState().deleteAllProjections).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Нет" }));
    expect(useExperimentStore.getState().deleteAllProjections).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Удалить все \(5\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Да" }));
    expect(useExperimentStore.getState().deleteAllProjections).toHaveBeenCalledTimes(1);
  });

  it("the bulk button is absent when the inventory is empty", () => {
    useExperimentStore.setState({ projections: [] });
    render(<ViewBar />);
    expect(screen.queryByRole("button", { name: /Удалить все/ })).toBeNull();
  });
});

describe("ViewBar color and grid controls", () => {
  it("color mode offers kind / file / cluster and switches the shared state", () => {
    render(<ViewBar />);
    const group = screen.getByRole("group", { name: "Режим окраски" });
    expect(group.textContent).toContain("тип");
    expect(group.textContent).toContain("файл");
    expect(group.textContent).toContain("кластер");
    // cluster is unavailable until a clustering is applied
    expect(screen.getByRole("button", { name: "кластер" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "файл" }));
    expect(useSpaceStore.getState().colorBy).toBe("file");
    fireEvent.click(screen.getByRole("button", { name: "тип" }));
    expect(useSpaceStore.getState().colorBy).toBe("kind");
  });

  it("cluster coloring enables once labels are applied", () => {
    useSpaceStore.setState({ clusterLabels: new Map([["fragA", 0]]) });
    render(<ViewBar />);
    const clusterBtn = screen.getByRole("button", { name: "кластер" });
    expect(clusterBtn).toHaveProperty("disabled", false);
    fireEvent.click(clusterBtn);
    expect(useSpaceStore.getState().colorBy).toBe("cluster");
  });

  it("grid mode switches off / simple / numbers (default simple)", () => {
    render(<ViewBar />);
    const group = screen.getByRole("group", { name: "Режим координатной сетки" });
    expect(group.textContent).toContain("выкл");
    expect(group.textContent).toContain("простая");
    expect(group.textContent).toContain("цифры");
    expect(useSpaceStore.getState().gridMode).toBe("simple");
    fireEvent.click(screen.getByRole("button", { name: "цифры" }));
    expect(useSpaceStore.getState().gridMode).toBe("numbers");
    fireEvent.click(screen.getByRole("button", { name: "выкл" }));
    expect(useSpaceStore.getState().gridMode).toBe("off");
  });
});
