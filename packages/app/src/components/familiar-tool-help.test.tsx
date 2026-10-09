// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FamiliarToolHelp } from "./familiar-tool-help";
const mode = vi.hoisted(() => ({ compact: false }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => mode.compact }));
vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));
vi.mock("react-native-reanimated", () => ({
  FadeIn: { duration: () => undefined },
  FadeOut: { duration: () => undefined },
}));
vi.mock("@/components/ui/floating", () => ({
  FloatingSurface: ({ children, role }: { children: React.ReactNode; role: string }) => (
    <div role={role}>{children}</div>
  ),
}));
const guide = {
  summary: "Use the native team",
  whenToUse: ["Manage a queue"],
  execution: "Runs on the selected server",
  continuation: "Selected input, not private runtime state",
};
beforeEach(() => {
  vi.stubGlobal("React", React);
  mode.compact = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows the server-supplied guide on hover and keyboard focus without launching the tool", async () => {
  render(<FamiliarToolHelp name="OpenRig" guide={guide} />);
  const trigger = screen.getByRole("button", { name: "About OpenRig" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseEnter(trigger);
  expect((await screen.findByRole("tooltip")).textContent).toContain(guide.summary);
  expect(screen.getByRole("tooltip").textContent).toContain(guide.execution);
  expect(screen.getByRole("tooltip").textContent).toContain(guide.continuation);
  fireEvent.mouseLeave(trigger);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.keyDown(window, { key: "Tab" });
  fireEvent.focus(trigger);
  expect((await screen.findByRole("tooltip")).textContent).toContain("Manage a queue");
});
it("lets a touch/compact user tap the help control", async () => {
  mode.compact = true;
  render(<FamiliarToolHelp name="Goose" guide={guide} />);
  fireEvent.click(screen.getByRole("button", { name: "About Goose" }));
  expect((await screen.findByRole("tooltip")).textContent).toContain(guide.summary);
});
