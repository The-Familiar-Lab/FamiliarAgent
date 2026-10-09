import { describe, expect, it } from "vitest";
import {
  closeProjectView,
  EMPTY_PROJECT_VIEWS,
  layoutProjectViews,
  MAX_PROJECT_VIEWS,
  reorderProjectViews,
  showProjectView,
  visibleProjectViews,
} from "./project-views";
import {
  getWorkspaceSelectionKey,
  reconcileRetainedWorkspaceSelections,
  WORKSPACE_DECK_INACTIVE_TTL_MS,
} from "./workspace-deck-retention";
const a = { serverId: "mac", workspaceId: "one" };
const b = { serverId: "mac", workspaceId: "two" };
const c = { serverId: "linux", workspaceId: "one" };
describe("project views", () => {
  it("keeps same-server projects and same-ID cross-server projects independently visible", () => {
    let state = showProjectView(EMPTY_PROJECT_VIEWS, a);
    state = showProjectView(state, b, true);
    state = showProjectView(state, c, true);
    expect(visibleProjectViews(state, c)).toEqual([a, b, c]);
    expect(visibleProjectViews(state, c, true)).toEqual([c]);
    const moved = reorderProjectViews(state, [c, a, b].map(getWorkspaceSelectionKey));
    expect(visibleProjectViews(moved, c)).toEqual([c, a, b]);
    expect(moved.views[1]).toBe(a);
  });
  it("closes only the selected view and retains other sessions' view identities", () => {
    const state = showProjectView(showProjectView(EMPTY_PROJECT_VIEWS, a), b, true);
    const next = closeProjectView(state, a);
    expect(next.views).toEqual([b]);
    expect(state.views).toEqual([a, b]);
    expect(visibleProjectViews(next, b)).toEqual([b]);
    expect(reorderProjectViews(next, ["unknown"])).toBe(next);
  });
  it("bounds concurrent render work and retained tabs while single view preserves open projects", () => {
    let state = EMPTY_PROJECT_VIEWS;
    for (let n = 0; n < 15; n++)
      state = showProjectView(state, { serverId: "mac", workspaceId: String(n) }, true);
    expect(state.views).toHaveLength(MAX_PROJECT_VIEWS);
    expect(visibleProjectViews(state, state.views.at(-1)!)).toHaveLength(4);
    const single = layoutProjectViews(state, null, state.views.at(-1)!);
    expect(single.views).toBe(state.views);
    expect(visibleProjectViews(single, state.views.at(-1)!)).toHaveLength(1);
  });
  it("pins every visible instance past the inactive TTL without keeping other hidden instances forever", () => {
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
