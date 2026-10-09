// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResizeHandle } from "./resize-handle";

const gesture = vi.hoisted(() => ({
  finePointer: true,
  start: () => {},
  update: (_event: { translationX: number; translationY: number }) => {},
  end: (_event: unknown, _success: boolean) => {},
  finalize: () => {},
}));
vi.mock("@/hooks/use-fine-pointer", () => ({
  useHasFinePointer: () => gesture.finePointer,
}));
vi.mock("react-native-gesture-handler", () => ({
  Gesture: {
    Pan() {
      const chain = {
        runOnJS: () => chain,
        onBegin: () => chain,
        onStart: (callback: typeof gesture.start) => ((gesture.start = callback), chain),
        onUpdate: (callback: typeof gesture.update) => ((gesture.update = callback), chain),
        onEnd: (callback: typeof gesture.end) => ((gesture.end = callback), chain),
        onFinalize: (callback: typeof gesture.finalize) => ((gesture.finalize = callback), chain),
        activeOffsetX: () => chain,
        failOffsetX: () => chain,
        activeOffsetY: () => chain,
        failOffsetY: () => chain,
      };
      return chain;
    },
  },
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
}));

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, options: PointerEventInit = {}) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
  }
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  gesture.finePointer = true;
  document.body.style.cursor = "crosshair";
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.style.cursor = "";
});

function setup() {
  const preview = vi.fn();
  const commit = vi.fn();
  const rendered = render(
    <ResizeHandle
      direction="horizontal"
      groupId="group"
      index={0}
      sizes={[0.5, 0.5]}
      containerSize={100}
      onPreviewResizeSplit={preview}
      onResizeSplit={commit}
    />,
  );
  const handle = screen.getByRole("separator");
  let captured = false;
  const release = vi.fn(() => (captured = false));
  Object.assign(handle, {
    setPointerCapture: () => (captured = true),
    hasPointerCapture: () => captured,
    releasePointerCapture: release,
  });
  return { ...rendered, preview, commit, handle, release };
}

function move(handle: HTMLElement) {
  fireEvent.pointerDown(handle, { pointerId: 7, clientX: 10 });
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 20 });
}

it("commits the final pointer size once and restores the previous cursor", () => {
  const { handle, preview, commit, release, unmount } = setup();
  move(handle);
  expect(preview).toHaveBeenLastCalledWith("group", [0.6, 0.4]);
  expect(commit).not.toHaveBeenCalled();
  expect(document.body.style.cursor).toBe("col-resize");
  fireEvent.pointerUp(window, { pointerId: 7 });
  expect(commit).toHaveBeenCalledExactlyOnceWith("group", [0.6, 0.4]);
  expect(release).toHaveBeenCalledWith(7);
  expect(document.body.style.cursor).toBe("crosshair");
  unmount();
  expect(preview).toHaveBeenCalledOnce();
});

it("removes pointer listeners and capture when an active splitter unmounts", () => {
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const { handle, preview, commit, release, unmount } = setup();
  move(handle);
  unmount();
  expect(preview).toHaveBeenLastCalledWith("group", [0.5, 0.5]);
  expect(commit).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledWith(7);
  expect(document.body.style.cursor).toBe("crosshair");
  for (const type of ["pointermove", "pointerup", "pointercancel"]) {
    const listener = add.mock.calls.find(([event]) => event === type)?.[1];
    expect(listener).toBeDefined();
    expect(remove).toHaveBeenCalledWith(type, listener);
  }
  preview.mockClear();
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 30 });
  fireEvent.pointerUp(window, { pointerId: 7 });
  expect(preview).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});

it.each(["pointercancel", "lostpointercapture"])(
  "rolls back the preview without committing after %s",
  (type) => {
    const { handle, preview, commit, unmount } = setup();
    move(handle);
    fireEvent(
      type === "pointercancel" ? window : handle,
      new TestPointerEvent(type, { pointerId: 7 }),
    );
    expect(preview).toHaveBeenLastCalledWith("group", [0.5, 0.5]);
    expect(commit).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("crosshair");
    unmount();
    expect(preview).toHaveBeenCalledTimes(2);
  },
);

it("clears a pending hover timer on unmount", () => {
  vi.useFakeTimers();
  const { handle, unmount } = setup();
  fireEvent.pointerEnter(handle);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("preserves native gesture completion semantics (success=%s)", (success) => {
  gesture.finePointer = false;
  const { preview, commit, unmount } = setup();
  act(() => {
    gesture.start();
    gesture.update({ translationX: 10, translationY: 0 });
    gesture.end({}, success);
    gesture.finalize();
  });
  if (success) {
    expect(commit).toHaveBeenCalledExactlyOnceWith("group", [0.6, 0.4]);
    expect(preview).toHaveBeenCalledOnce();
  } else {
    expect(commit).not.toHaveBeenCalled();
    expect(preview).toHaveBeenLastCalledWith("group", [0.5, 0.5]);
  }
  unmount();
});

it("rolls back an active native gesture when its splitter is removed", () => {
  gesture.finePointer = false;
  const { preview, commit, unmount } = setup();
  act(() => {
    gesture.start();
    gesture.update({ translationX: 10, translationY: 0 });
  });
  unmount();
  expect(preview).toHaveBeenLastCalledWith("group", [0.5, 0.5]);
  expect(commit).not.toHaveBeenCalled();
});
