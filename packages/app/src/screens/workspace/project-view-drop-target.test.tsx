// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({
      sessions: {
        mac: {
          workspaces: new Map([
            ["one", { id: "one" }],
            ["old", { id: "old", archivingAt: 1 }],
          ]),
        },
      },
    }),
  },
}));
import { ProjectViewDropTarget } from "./project-view-drop-target";
import { PROJECT_VIEW_DRAG_MIME } from "./project-view-drag";
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function drag(target: HTMLElement, type: string, serialized: string, x = 395, y = 150) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    clientX: x,
    clientY: y,
    dataTransfer: { types: [PROJECT_VIEW_DRAG_MIME], getData: () => serialized },
  });
  act(() => target.dispatchEvent(event));
  return event;
}
it("previews each drop location, clears on drag end, and ignores invalid or unknown workspaces", () => {
  const drop = vi.fn();
  render(
    <ProjectViewDropTarget onDrop={drop} testID="target">
      <div>Workspace</div>
    </ProjectViewDropTarget>,
  );
  const target = screen.getByTestId("target");
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 400,
    height: 300,
  } as DOMRect);
  for (const [position, x, y] of [
    ["right", 395, 150],
    ["left", 5, 150],
    ["top", 200, 5],
    ["bottom", 200, 295],
    ["center", 200, 150],
  ] as const) {
    drag(target, "dragover", "", x, y);
    expect(screen.getByTestId(`target-preview-${position}`)).toBeTruthy();
  }
  act(() => window.dispatchEvent(new Event("dragend")));
  expect(screen.queryByText("Move project here")).toBeNull();
  for (const value of [
    "{",
    JSON.stringify({ version: 1, serverId: "remote", workspaceId: "one" }),
    JSON.stringify({ version: 1, serverId: "mac", workspaceId: "old" }),
  ])
    drag(target, "drop", value);
  expect(drop).not.toHaveBeenCalled();
  drag(target, "drop", JSON.stringify({ version: 1, serverId: "mac", workspaceId: "one" }));
  expect(drop).toHaveBeenCalledExactlyOnceWith({ serverId: "mac", workspaceId: "one" }, "right");
});

it("isolates the whole project drag lifecycle from an inner file-drop counter", () => {
  let entered = 0;
  const enter = vi.fn(() => {
    entered++;
  });
  const leave = vi.fn(() => {
    entered--;
  });
  render(
    <ProjectViewDropTarget onDrop={vi.fn()} testID="target">
      <div data-testid="file-zone" onDragEnter={enter} onDragLeave={leave} />
    </ProjectViewDropTarget>,
  );
  const fileZone = screen.getByTestId("file-zone");
  drag(fileZone, "dragenter", "");
  drag(fileZone, "dragleave", "");
  drag(fileZone, "dragenter", "");
  drag(fileZone, "drop", JSON.stringify({ version: 1, serverId: "mac", workspaceId: "one" }));
  expect(entered).toBe(0);
  for (const type of ["dragenter", "dragleave"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer: { types: ["Files"] } });
    act(() => fileZone.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  }
  expect(entered).toBe(0);
});
