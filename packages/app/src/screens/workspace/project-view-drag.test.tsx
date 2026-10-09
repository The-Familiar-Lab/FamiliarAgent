// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PROJECT_VIEW_DRAG_MIME,
  parseProjectViewDragPayload,
  serializeProjectViewDragPayload,
} from "./project-view-drag";
import { useProjectViewDragSource } from "./use-project-view-drag-source.web";
const selection = { serverId: "host-a", workspaceId: "workspace-a" };
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Source({
  disabled,
  onPointer,
  onClick,
  onMenu,
}: {
  disabled?: boolean;
  onPointer: () => void;
  onClick: () => void;
  onMenu: () => void;
}) {
  const ref = useProjectViewDragSource({ selection, disabled });
  return (
    <div onMouseDown={onPointer} onClick={onClick} onContextMenu={onMenu}>
      <div ref={ref as unknown as React.RefCallback<HTMLDivElement>} data-testid="source">
        Project title
      </div>
      <button type="button" data-testid="reorder">
        Existing reorder area
      </button>
    </div>
  );
}

it("starts a native project drag without arming ancestor reorder and retains click/menu on the same label", () => {
  const pointer = vi.fn(),
    click = vi.fn(),
    menu = vi.fn();
  render(<Source onPointer={pointer} onClick={click} onMenu={menu} />);
  const source = screen.getByTestId("source");
  expect(source.draggable).toBe(true);
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  source.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(false);
  expect(pointer).not.toHaveBeenCalled();
  fireEvent.click(source);
  expect(click).toHaveBeenCalledOnce();
  fireEvent.contextMenu(source);
  expect(menu).toHaveBeenCalledOnce();
  fireEvent.mouseDown(screen.getByTestId("reorder"));
  expect(pointer).toHaveBeenCalledOnce();
  const transfer = { effectAllowed: "none", setData: vi.fn() };
  fireEvent.dragStart(source, { dataTransfer: transfer });
  expect(transfer.effectAllowed).toBe("copyMove");
  expect(transfer.setData).toHaveBeenCalledExactlyOnceWith(
    PROJECT_VIEW_DRAG_MIME,
    JSON.stringify({ version: 1, ...selection }),
  );
  fireEvent.click(source, { detail: 1 });
  expect(click).toHaveBeenCalledOnce();
  fireEvent.mouseDown(source);
  fireEvent.click(source, { detail: 1 });
  expect(click).toHaveBeenCalledTimes(2);
});

it("removes drag interception when disabled or unmounted and keeps keyboard clicks after dragging", () => {
  const props = { onPointer: vi.fn(), onClick: vi.fn(), onMenu: vi.fn() };
  const { rerender, unmount } = render(<Source {...props} />);
  const source = screen.getByTestId("source");
  fireEvent.dragStart(source, { dataTransfer: { setData: vi.fn() } });
  fireEvent.click(source, { detail: 0 });
  expect(props.onClick).toHaveBeenCalledOnce();
  rerender(<Source {...props} disabled />);
  expect(source.draggable).toBe(false);
  fireEvent.mouseDown(source);
  expect(props.onPointer).toHaveBeenCalledOnce();
  const transfer = { setData: vi.fn() };
  fireEvent.dragStart(source, { dataTransfer: transfer });
  expect(transfer.setData).not.toHaveBeenCalled();
  rerender(<Source {...props} />);
  unmount();
  expect(source.draggable).toBe(false);
  fireEvent.dragStart(source, { dataTransfer: transfer });
  expect(transfer.setData).not.toHaveBeenCalled();
});

it("preserves exact server/workspace identity and rejects malformed, extra, or unbounded payloads", () => {
  const payload = { version: 1 as const, ...selection };
  expect(parseProjectViewDragPayload(serializeProjectViewDragPayload(payload))).toEqual(payload);
  for (const value of [
    "null",
    "[]",
    "{",
    JSON.stringify({ ...payload, version: 2 }),
    JSON.stringify({ ...payload, command: "unexpected" }),
    JSON.stringify({ ...payload, workspaceId: " " }),
    JSON.stringify({ ...payload, serverId: "a\n" }),
    JSON.stringify({ ...payload, workspaceId: "x".repeat(4096) }),
  ]) {
    expect(parseProjectViewDragPayload(value)).toBeNull();
  }
});
