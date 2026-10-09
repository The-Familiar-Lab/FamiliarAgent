import { describe, expect, it } from "vitest";
import {
  closeProjectView,
  dockProjectView,
  EMPTY_PROJECT_VIEWS,
  MAX_PROJECT_VIEWS,
  migrateProjectViews,
  projectLayoutKeys,
  reorderProjectViews,
  resizeProjectViews,
  showProjectView,
  visibleProjectViews,
  type ProjectViews,
} from "./project-views";
import {
  getWorkspaceSelectionKey,
  reconcileRetainedWorkspaceSelections,
  WORKSPACE_DECK_INACTIVE_TTL_MS,
} from "./workspace-deck-retention";
const a = { serverId: "mac", workspaceId: "one" };
const b = { serverId: "mac", workspaceId: "two" };
const c = { serverId: "linux", workspaceId: "one" };
const d = { serverId: "linux", workspaceId: "two" };
const key = getWorkspaceSelectionKey;
function pair(): ProjectViews {
  return dockProjectView(showProjectView(EMPTY_PROJECT_VIEWS, a), b, key(a), "right", "pair");
}
describe("project views", () => {
  it("keeps server/workspace identity and focuses an already visible project without moving its pane", () => {
    const state = dockProjectView(pair(), c, key(b), "bottom", "nested");
    const focused = showProjectView(state, a);
    expect(focused.layout).toBe(state.layout);
    expect(focused.views).toBe(state.views);
    expect(focused.focusedKey).toBe(key(a));
    expect(visibleProjectViews(focused, a)).toEqual([a, b, c]);
    expect(visibleProjectViews(focused, a, true)).toEqual([a]);
  });
  it("ordinary navigation replaces only the focused pane, retaining its previous project tab", () => {
    const state = showProjectView(pair(), a);
    const next = showProjectView(state, c);
    expect(projectLayoutKeys(next.layout)).toEqual([key(c), key(b)]);
    expect(next.views).toEqual([a, b, c]);
    const restored = showProjectView(next, a);
    expect(projectLayoutKeys(restored.layout)).toEqual([key(a), key(b)]);
    expect(restored.views).toBe(next.views);
  });
  it("nests all four edge directions around the selected target", () => {
    for (const [position, direction, before] of [
      ["left", "horizontal", true],
      ["right", "horizontal", false],
      ["top", "vertical", true],
      ["bottom", "vertical", false],
    ] as const) {
      const next = dockProjectView(pair(), c, key(b), position, "inside");
      expect(next.layout).toMatchObject({
        kind: "split",
        id: "pair",
        direction: "horizontal",
        children: [
          { kind: "leaf", key: key(a) },
          {
            kind: "split",
            id: "inside",
            direction,
            sizes: [0.5, 0.5],
            children: before
              ? [
                  { kind: "leaf", key: key(c) },
                  { kind: "leaf", key: key(b) },
                ]
              : [
                  { kind: "leaf", key: key(b) },
                  { kind: "leaf", key: key(c) },
                ],
          },
        ],
      });
    }
  });
  it("moves a visible source, collapses its former parent and never duplicates it", () => {
    const state = dockProjectView(pair(), c, key(b), "bottom", "inside");
    const next = dockProjectView(state, b, key(a), "left", "moved");
    expect(projectLayoutKeys(next.layout)).toEqual([key(b), key(a), key(c)]);
    expect(next.layout).toMatchObject({
      kind: "split",
      id: "pair",
      children: [{ id: "moved" }, { kind: "leaf", key: key(c) }],
    });
    expect(next.views).toBe(state.views);
    expect(dockProjectView(next, b, key(b), "top", "self")).toBe(next);
    expect(dockProjectView(next, c, "absent", "left", "unknown")).toBe(next);
  });
  it("center drop replaces only its target and removes the original source pane", () => {
    const next = dockProjectView(pair(), a, key(b), "center", "unused");
    expect(next.layout).toEqual({ kind: "leaf", key: key(a) });
    expect(next.views).toEqual([a, b]);
    const hidden = dockProjectView(pair(), c, key(b), "center", "unused");
    expect(projectLayoutKeys(hidden.layout)).toEqual([key(a), key(c)]);
  });
  it("preserves all four panes at capacity; allows existing moves and explicit center replacement", () => {
    const full = dockProjectView(
      dockProjectView(pair(), c, key(b), "bottom", "three"),
      d,
      key(a),
      "top",
      "four",
    );
    const extra = { serverId: "mac", workspaceId: "extra" };
    expect(dockProjectView(full, extra, key(a), "right", "five")).toBe(full);
    expect(
      projectLayoutKeys(dockProjectView(full, b, key(d), "bottom", "move").layout),
    ).toHaveLength(4);
    const replaced = dockProjectView(full, extra, key(a), "center", "unused");
    expect(projectLayoutKeys(replaced.layout)).toHaveLength(4);
    expect(replaced.views).toContain(a);
    expect(replaced.views).toContain(extra);
  });
  it("closes only the selected view, collapses empty splits and focuses a remaining visible pane", () => {
    const state = dockProjectView(pair(), c, key(b), "bottom", "nested");
    const next = closeProjectView(state, c);
    expect(next.layout).toEqual(pair().layout);
    expect(next.focusedKey).toBe(key(a));
    expect(state.views).toEqual([a, b, c]);
    expect(closeProjectView(closeProjectView(next, a), b)).toEqual(EMPTY_PROJECT_VIEWS);
  });
  it("persists each split size independently, normalizes sizes and ignores invalid/stale resize targets", () => {
    const state = dockProjectView(pair(), c, key(b), "bottom", "nested");
    const resized = resizeProjectViews(state, "nested", [1, 3]);
    expect(resized.layout).toMatchObject({
      sizes: [0.5, 0.5],
      children: [{}, { sizes: [0.25, 0.75] }],
    });
    expect(resizeProjectViews(state, "absent", [1, 3])).toBe(state);
    expect(resizeProjectViews(state, "pair", [NaN, 1])).toBe(state);
    expect(resizeProjectViews(state, "pair", [0, 1])).toBe(state);
    expect(resizeProjectViews(state, "pair", [1])).toBe(state);
    expect(dockProjectView(state, d, key(a), "right", "nested")).toBe(state);
  });
  it("reorders top tabs without altering pane positions or sizes", () => {
    const state = pair();
    const moved = reorderProjectViews(state, [key(b), key(a)]);
    expect(moved.views).toEqual([b, a]);
    expect(moved.layout).toBe(state.layout);
    expect(visibleProjectViews(moved, b)).toEqual([a, b]);
    expect(reorderProjectViews(state, [key(a), key(a)])).toBe(state);
  });
  it("bounds retained tabs without evicting currently visible panes", () => {
    let state = showProjectView(pair(), b);
    for (let n = 0; n < 15; n++)
      state = showProjectView(state, { serverId: "mac", workspaceId: `extra${n}` });
    expect(state.views).toHaveLength(MAX_PROJECT_VIEWS);
    expect(state.views).toContain(a);
    expect(projectLayoutKeys(state.layout)).toEqual([key(a), "mac:extra14"]);
  });
  it("migrates flat saved views with equal geometry, remembered focus, and single-view preservation", () => {
    const legacy = {
      views: [a, b, c],
      shown: [key(b), key(a), key(c)],
      direction: "horizontal" as const,
    };
    const migrated = migrateProjectViews(legacy);
    expect(projectLayoutKeys(migrated.layout)).toEqual([key(a), key(b), key(c)]);
    expect(migrated.focusedKey).toBe(key(c));
    expect(migrated.layout).toMatchObject({
      sizes: [1 / 3, 2 / 3],
      children: [{}, { sizes: [0.5, 0.5] }],
    });
    expect(migrateProjectViews(migrated)).toBe(migrated);
    expect(migrateProjectViews({ ...legacy, direction: null, shown: [key(b)] })).toMatchObject({
      views: [a, b, c],
      layout: { kind: "leaf", key: key(b) },
      focusedKey: key(b),
    });
    expect(migrateProjectViews({ views: [], shown: [], direction: null })).toEqual(
      EMPTY_PROJECT_VIEWS,
    );
  });
  it("pins every visible instance past the inactive TTL without retaining all hidden instances", () => {
    const entries = reconcileRetainedWorkspaceSelections({
      currentEntries: [
        { selection: a, inactiveSince: 0 },
        { selection: b, inactiveSince: 0 },
        { selection: c, inactiveSince: 0 },
      ],
      activeSelection: b,
      visibleSelections: [a, b],
      now: WORKSPACE_DECK_INACTIVE_TTL_MS + 10,
    });
    expect(entries.map((entry) => entry.selection)).toEqual([b, a]);
    expect(entries.every((entry) => entry.inactiveSince === null)).toBe(true);
  });
});
