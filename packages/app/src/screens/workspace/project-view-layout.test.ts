import { describe, expect, it } from "vitest";
import type { ProjectLayout } from "./project-views";
import {
  computeProjectViewLayout,
  PROJECT_VIEW_DIVIDER_SIZE,
  type ProjectViewRect,
} from "./project-view-layout";

const grid: ProjectLayout = {
  kind: "split",
  id: "columns",
  direction: "horizontal",
  sizes: [0.5, 0.5],
  children: [
    {
      kind: "split",
      id: "left-rows",
      direction: "vertical",
      sizes: [0.5, 0.5],
      children: [
        { kind: "leaf", key: "a" },
        { kind: "leaf", key: "b" },
      ],
    },
    {
      kind: "split",
      id: "right-rows",
      direction: "vertical",
      sizes: [0.5, 0.5],
      children: [
        { kind: "leaf", key: "c" },
        { kind: "leaf", key: "d" },
      ],
    },
  ],
};
function intersection(a: ProjectViewRect, b: ProjectViewRect): number {
  return (
    Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))
  );
}

describe("project view pixel geometry", () => {
  it("reserves divider pixels for a nested 2×2 grid with stable leaf keys", () => {
    const geometry = computeProjectViewLayout(grid, { width: 1001, height: 801 });
    expect([...geometry.leaves]).toEqual([
      ["a", { left: 0, top: 0, width: 500, height: 400 }],
      ["b", { left: 0, top: 401, width: 500, height: 400 }],
      ["c", { left: 501, top: 0, width: 500, height: 400 }],
      ["d", { left: 501, top: 401, width: 500, height: 400 }],
    ]);
    expect(geometry.dividers).toEqual([
      {
        id: "columns",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        rect: { left: 500, top: 0, width: PROJECT_VIEW_DIVIDER_SIZE, height: 801 },
        containerSize: 1000,
      },
      {
        id: "left-rows",
        direction: "vertical",
        sizes: [0.5, 0.5],
        rect: { left: 0, top: 400, width: 500, height: PROJECT_VIEW_DIVIDER_SIZE },
        containerSize: 800,
      },
      {
        id: "right-rows",
        direction: "vertical",
        sizes: [0.5, 0.5],
        rect: { left: 501, top: 400, width: 500, height: PROJECT_VIEW_DIVIDER_SIZE },
        containerSize: 800,
      },
    ]);
  });
  it("previews only the chosen subtree and leaves persisted geometry untouched", () => {
    const bounds = { width: 1001, height: 801 };
    const original = computeProjectViewLayout(grid, bounds);
    const preview = computeProjectViewLayout(grid, bounds, { splitId: "left-rows", sizes: [1, 3] });
    expect(preview.leaves.get("a")?.height).toBe(200);
    expect(preview.leaves.get("b")).toEqual({ left: 0, top: 201, width: 500, height: 600 });
    expect(preview.leaves.get("c")).toEqual(original.leaves.get("c"));
    expect(preview.leaves.get("d")).toEqual(original.leaves.get("d"));
    expect(preview.dividers[1]?.sizes).toEqual([0.25, 0.75]);
    expect(computeProjectViewLayout(grid, bounds)).toEqual(original);
    expect(
      computeProjectViewLayout(grid, bounds, { splitId: "left-rows", sizes: [NaN, 2] }),
    ).toEqual(original);
  });
  it.each([
    { width: 0, height: 0 },
    { width: 0.5, height: 0.25 },
    { width: -5, height: NaN },
  ])("never creates negative or out-of-bounds rectangles for $width × $height", (bounds) => {
    const geometry = computeProjectViewLayout(grid, bounds);
    const width = Math.max(0, bounds.width);
    const height = Number.isFinite(bounds.height) ? Math.max(0, bounds.height) : 0;
    for (const rect of [
      ...geometry.leaves.values(),
      ...geometry.dividers.map((divider) => divider.rect),
    ]) {
      expect(Object.values(rect).every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
      expect(rect.left + rect.width).toBeLessThanOrEqual(width);
      expect(rect.top + rect.height).toBeLessThanOrEqual(height);
    }
    expect(geometry.dividers.every((divider) => divider.containerSize >= 0)).toBe(true);
  });
  it("covers the root exactly without overlaps after a fractional parent resize", () => {
    const bounds = { width: 917.25, height: 583.5 };
    const geometry = computeProjectViewLayout(grid, bounds, {
      splitId: "columns",
      sizes: [0.33, 0.67],
    });
    const rectangles = [
      ...geometry.leaves.values(),
      ...geometry.dividers.map((divider) => divider.rect),
    ];
    for (let i = 0; i < rectangles.length; i++)
      for (let j = i + 1; j < rectangles.length; j++)
        expect(intersection(rectangles[i]!, rectangles[j]!)).toBeCloseTo(0);
    expect(rectangles.reduce((area, rect) => area + rect.width * rect.height, 0)).toBeCloseTo(
      bounds.width * bounds.height,
    );
  });
  it("handles an empty layout and an unsplit project", () => {
    expect(computeProjectViewLayout(null, { width: 100, height: 50 })).toEqual({
      leaves: new Map(),
      dividers: [],
    });
    expect([
      ...computeProjectViewLayout({ kind: "leaf", key: "single" }, { width: 100, height: 50 })
        .leaves,
    ]).toEqual([["single", { left: 0, top: 0, width: 100, height: 50 }]]);
  });
});
