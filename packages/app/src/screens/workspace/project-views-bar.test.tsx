// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  a: { serverId: "mac", workspaceId: "one" },
  b: { serverId: "linux", workspaceId: "two" },
  c: { serverId: "linux", workspaceId: "three" },
  navigate: vi.fn(),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: fixtures.navigate,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [
    { serverId: "mac", label: "Mac" },
    { serverId: "linux", label: "Linux" },
  ],
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspace: (_serverId: string, workspaceId: string) => ({ title: workspaceId }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({
      sessions: {
        mac: { workspaces: new Map([["one", { id: "one" }]]) },
        linux: { workspaces: new Map([["two", { id: "two" }]]) },
      },
    }),
  },
}));
import { useProjectViewStore } from "@/stores/project-view-store";
import { EMPTY_PROJECT_VIEWS, dockProjectView, showProjectView } from "./project-views";
import { PROJECT_VIEW_DRAG_MIME } from "./project-view-drag";
import { ProjectViewsBar } from "./project-views-bar";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
  useProjectViewStore.setState({
    state: dockProjectView(
      showProjectView(EMPTY_PROJECT_VIEWS, fixtures.a),
      fixtures.b,
      "mac:one",
      "right",
      "split",
    ),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bar() {
  return render(
    <ProjectViewsBar active={fixtures.a} state={useProjectViewStore.getState().state} />,
  );
}

it("keeps native drag defaults on the real Pressable and preserves ordinary and keyboard clicks", () => {
  bar();
  const label = screen.getByRole("button", { name: "Focus project one on mac" });
  expect(label.draggable).toBe(true);
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  fireEvent(label, down);
  expect(down.defaultPrevented).toBe(false);
  fireEvent.click(label, { detail: 1 });
  expect(fixtures.navigate).toHaveBeenCalledExactlyOnceWith(fixtures.a);

  const transfer = { setData: vi.fn(), effectAllowed: "none" };
  const drag = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.assign(drag, { dataTransfer: transfer });
  fireEvent(label, drag);
  expect(drag.defaultPrevented).toBe(false);
  expect(transfer.setData).toHaveBeenCalledExactlyOnceWith(
    PROJECT_VIEW_DRAG_MIME,
    JSON.stringify({ version: 1, ...fixtures.a }),
  );
  fireEvent.click(label, { detail: 1 });
  expect(fixtures.navigate).toHaveBeenCalledOnce();
  fireEvent.click(label, { detail: 0 });
  expect(fixtures.navigate).toHaveBeenCalledTimes(2);
});

it("reorders a native tab drop without replacing the visible split tree", () => {
  bar();
  const target = screen.getByRole("button", { name: "Focus project one on mac" }).parentElement!;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 30,
  } as DOMRect);
  const layout = useProjectViewStore.getState().state.layout;
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.assign(drop, {
    clientX: 1,
    clientY: 15,
    dataTransfer: {
      types: [PROJECT_VIEW_DRAG_MIME],
      getData: () => JSON.stringify({ version: 1, ...fixtures.b }),
    },
  });
  act(() => target.dispatchEvent(drop));
  expect(useProjectViewStore.getState().state.views).toEqual([fixtures.b, fixtures.a]);
  expect(useProjectViewStore.getState().state.layout).toBe(layout);
  expect(fixtures.navigate).toHaveBeenCalledExactlyOnceWith(fixtures.b);
});

it("closing the active project selects a remaining visible pane before an older hidden tab", () => {
  const store = useProjectViewStore.getState();
  store.show(fixtures.c);
  store.show(fixtures.a);
  bar();
  fireEvent.click(screen.getByRole("button", { name: "Close project view one" }));
  expect(useProjectViewStore.getState().state.views).toEqual([fixtures.b, fixtures.c]);
  expect(fixtures.navigate).toHaveBeenCalledExactlyOnceWith(fixtures.c);
});
