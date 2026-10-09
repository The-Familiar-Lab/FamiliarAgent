// @vitest-environment jsdom
import React, { useCallback, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const test = vi.hoisted(() => ({
  a: { serverId: "mac", workspaceId: "one" },
  b: { serverId: "linux", workspaceId: "two" },
  c: { serverId: "linux", workspaceId: "one" },
  active: { serverId: "mac", workspaceId: "one" },
  navigate: vi.fn(),
  mounts: vi.fn(),
  unmounts: vi.fn(),
  toast: { show: vi.fn() },
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => test.active,
  navigateToWorkspace: test.navigate,
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => test.toast }));
vi.mock("@/stores/project-view-store", async (original) => ({
  ...(await original<typeof import("@/stores/project-view-store")>()),
  useProjectViewsHydrated: () => true,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({
      sessions: {
        mac: { workspaces: new Map([["one", { id: "one" }]]) },
        linux: {
          workspaces: new Map([
            ["two", { id: "two" }],
            ["one", { id: "one" }],
          ]),
        },
      },
    }),
  },
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useHasHydratedWorkspaces: () => true,
  useWorkspaceExists: () => true,
}));
vi.mock("./project-views-bar", () => ({ ProjectViewsBar: () => null }));
vi.mock("@/components/resize-handle", () => ({
  ResizeHandle: ({
    groupId,
    onPreviewResizeSplit,
    onResizeSplit,
  }: {
    groupId: string;
    onPreviewResizeSplit: (id: string, sizes: number[]) => void;
    onResizeSplit: (id: string, sizes: number[]) => void;
  }) => {
    const preview = useCallback(
      () => onPreviewResizeSplit(groupId, [0.3, 0.7]),
      [groupId, onPreviewResizeSplit],
    );
    const commit = useCallback(() => onResizeSplit(groupId, [0.3, 0.7]), [groupId, onResizeSplit]);
    return (
      <button
        type="button"
        aria-label={`Resize ${groupId}`}
        onMouseOver={preview}
        onClick={commit}
      />
    );
  },
}));
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
import { useProjectViewStore } from "@/stores/project-view-store";
import {
  EMPTY_PROJECT_VIEWS,
  dockProjectView,
  showProjectView,
  projectLayoutKeys,
} from "./project-views";
import { PROJECT_VIEW_DRAG_MIME } from "./project-view-drag";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
  test.active = test.a;
  useProjectViewStore.setState({
    state: dockProjectView(
      showProjectView(EMPTY_PROJECT_VIEWS, test.a),
      test.b,
      "mac:one",
      "right",
      "first",
    ),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("preserves instances and drafts across nested docking, pane collapse, and tab reordering", () => {
  const { rerender } = render(<WorkspaceDeck recoveryRequested={false} />);
  const draft = screen.getByLabelText("mac:one") as HTMLInputElement;
  fireEvent.change(draft, { target: { value: "unfinished prompt" } });
  fireEvent.pointerDown(screen.getByLabelText("linux:two"));
  expect(test.navigate).toHaveBeenCalledWith(test.b);
  test.active = test.c;
  act(() => {
    useProjectViewStore.getState().dock(test.c, "linux:two", "bottom");
  });
  rerender(<WorkspaceDeck recoveryRequested={false} />);
  test.active = test.b;
  act(() => {
    const store = useProjectViewStore.getState();
    store.dock(test.b, "mac:one", "top");
    store.reorder(["linux:one", "linux:two", "mac:one"]);
    store.close(test.c);
  });
  rerender(<WorkspaceDeck recoveryRequested={false} />);
  expect(screen.getByLabelText("mac:one")).toBe(draft);
  expect(draft.value).toBe("unfinished prompt");
  expect(screen.getByLabelText("linux:two").getAttribute("data-focused")).toBe("true");
  expect(test.mounts).toHaveBeenCalledTimes(3);
  expect(test.unmounts).not.toHaveBeenCalled();
});

it("keeps the DOM sibling order stable when focus and tab order change", () => {
  const { rerender } = render(<WorkspaceDeck recoveryRequested={false} />);
  const a = screen.getByTestId("workspace-deck-entry-mac:one");
  const b = screen.getByTestId("workspace-deck-entry-linux:two");
  const parent = a.parentElement!;
  const before = [...parent.children];
  const observer = vi.fn();
  const mutation = new MutationObserver(observer);
  mutation.observe(parent, { childList: true });
  test.active = test.b;
  act(() => {
    useProjectViewStore.getState().reorder(["linux:two", "mac:one"]);
  });
  rerender(<WorkspaceDeck recoveryRequested={false} />);
  expect([...parent.children]).toEqual(before);
  expect(mutation.takeRecords()).toEqual([]);
  expect(a.parentElement).toBe(b.parentElement);
  mutation.disconnect();
});

it("commits resize only when released and keeps workspace instances during preview", () => {
  render(<WorkspaceDeck recoveryRequested={false} />);
  const before = useProjectViewStore.getState().state;
  fireEvent.mouseOver(screen.getByLabelText("Resize first"));
  expect(useProjectViewStore.getState().state).toBe(before);
  fireEvent.click(screen.getByLabelText("Resize first"));
  expect(useProjectViewStore.getState().state.layout).toMatchObject({ sizes: [0.3, 0.7] });
  expect(test.mounts).toHaveBeenCalledTimes(2);
  expect(test.unmounts).not.toHaveBeenCalled();
});

it("docks a known sidebar workspace through native drop and leaves files to the existing upload handler", () => {
  render(<WorkspaceDeck recoveryRequested={false} />);
  const target = screen.getByTestId("project-view-drop-mac:one");
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 400,
    height: 300,
  } as DOMRect);
  const transfer = {
    types: [PROJECT_VIEW_DRAG_MIME],
    getData: () => JSON.stringify({ version: 1, ...test.c }),
  };
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.assign(drop, { dataTransfer: transfer, clientX: 390, clientY: 150 });
  act(() => target.dispatchEvent(drop));
  expect(drop.defaultPrevented).toBe(true);
  expect(projectLayoutKeys(useProjectViewStore.getState().state.layout)).toEqual([
    "mac:one",
    "linux:one",
    "linux:two",
  ]);
  expect(test.navigate).toHaveBeenCalledWith(test.c);
  const fileHandler = vi.fn();
  target.addEventListener("drop", fileHandler);
  const fileDrop = new Event("drop", { bubbles: true, cancelable: true });
  Object.assign(fileDrop, { dataTransfer: { types: ["Files"] } });
  act(() => target.dispatchEvent(fileDrop));
  expect(fileDrop.defaultPrevented).toBe(false);
  expect(fileHandler).toHaveBeenCalledOnce();
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
