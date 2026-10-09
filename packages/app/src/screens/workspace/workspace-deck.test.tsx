// @vitest-environment jsdom
import React, { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const test = vi.hoisted(() => ({
  a: { serverId: "mac", workspaceId: "one" },
  b: { serverId: "linux", workspaceId: "two" },
  active: { serverId: "mac", workspaceId: "one" },
  direction: "horizontal" as "horizontal" | "vertical",
  reversed: false,
  navigate: vi.fn(),
  mounts: vi.fn(),
  unmounts: vi.fn(),
  show: vi.fn(),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => test.active,
  navigateToWorkspace: test.navigate,
}));
vi.mock("@/stores/project-view-store", () => ({
  useProjectViewsHydrated: () => true,
  useProjectViewStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({
        state: {
          views: test.reversed ? [test.b, test.a] : [test.a, test.b],
          shown: ["mac:one", "linux:two"],
          direction: test.direction,
        },
      }),
    { getState: () => ({ show: test.show }) },
  ),
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useHasHydratedWorkspaces: () => true,
  useWorkspaceExists: () => true,
}));
vi.mock("./project-views-bar", () => ({ ProjectViewsBar: () => null }));
vi.mock("@/components/resize-handle", () => ({ ResizeHandle: () => null }));
vi.mock("./workspace-screen", () => ({
  WorkspaceScreen: ({
    serverId,
    workspaceId,
    isRouteFocused,
  }: {
    serverId: string;
    workspaceId: string;
    isRouteFocused: boolean;
  }) => {
    useEffect(() => {
      test.mounts(`${serverId}:${workspaceId}`);
      return () => test.unmounts(`${serverId}:${workspaceId}`);
    }, [serverId, workspaceId]);
    return (
      <input aria-label={`${serverId}:${workspaceId}`} data-focused={String(isRouteFocused)} />
    );
  },
}));
import { WorkspaceDeck, ProjectViewFocus } from "./workspace-deck";
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
  test.active = test.a;
  test.direction = "horizontal";
  test.reversed = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("renders both original workspace instances and changes keyboard ownership without remounting", () => {
  const { rerender } = render(<WorkspaceDeck recoveryRequested={false} />);
  expect(screen.getByLabelText("mac:one").getAttribute("data-focused")).toBe("true");
  expect(screen.getByLabelText("linux:two").getAttribute("data-focused")).toBe("false");
  fireEvent.pointerDown(screen.getByLabelText("linux:two"));
  expect(test.navigate).toHaveBeenCalledWith(test.b);
  test.active = test.b;
  test.direction = "vertical";
  test.reversed = true;
  rerender(<WorkspaceDeck recoveryRequested={false} />);
  expect(screen.getByLabelText("mac:one").getAttribute("data-focused")).toBe("false");
  expect(screen.getByLabelText("linux:two").getAttribute("data-focused")).toBe("true");
  expect(test.mounts).toHaveBeenCalledTimes(2);
  expect(test.unmounts).not.toHaveBeenCalled();
  test.navigate.mockClear();
  fireEvent.focusIn(screen.getByLabelText("linux:two"));
  expect(test.navigate).not.toHaveBeenCalled();
});
it("does not activate an invisible retained project from a late focus event", () => {
  render(
    <ProjectViewFocus active={false} visible={false} selection={test.b}>
      <input aria-label="hidden project" />
    </ProjectViewFocus>,
  );
  fireEvent.focusIn(screen.getByLabelText("hidden project"));
  expect(test.navigate).not.toHaveBeenCalled();
});
