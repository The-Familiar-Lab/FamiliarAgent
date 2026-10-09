// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolGuide } from "./tool-guide.js";
import type { ToolEntry } from "../../shared/tool-catalog.js";
import type { HubUi } from "./ui.js";
vi.mock("react-native", () => ({
  View: "div",
  Text: "span",
  Pressable: ({
    children,
    onPress,
    onHoverIn,
    onHoverOut,
    onFocus,
    onBlur,
    accessibilityLabel,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    onHoverIn: () => void;
    onHoverOut: () => void;
    onFocus: () => void;
    onBlur: () => void;
    accessibilityLabel: string;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        onClick: onPress,
        onMouseEnter: onHoverIn,
        onMouseLeave: onHoverOut,
        onFocus,
        onBlur,
      },
      children,
    ),
}));
afterEach(cleanup);
it("shares the guide across hover, keyboard focus and persistent tap without executing the tool", () => {
  const tool = {
    name: "Goose",
    modes: ["terminal"],
    description: "Fallback",
    guide: {
      summary: "Original agent runtime",
      whenToUse: ["Use extensions"],
      execution: "Native terminal",
      continuation: "Shared references, not a transferred private checkpoint",
    },
  } as ToolEntry;
  render(createElement(ToolGuide, { tool, ui: {} as HubUi }));
  const help = screen.getByRole("button", { name: "About Goose" });
  expect(screen.queryByText("Original agent runtime")).toBeNull();
  fireEvent.mouseEnter(help);
  expect(screen.getByText("Original agent runtime")).toBeTruthy();
  fireEvent.mouseLeave(help);
  expect(screen.queryByText("Original agent runtime")).toBeNull();
  fireEvent.focus(help);
  expect(screen.getByText(/Runs as: Native terminal/)).toBeTruthy();
  fireEvent.blur(help);
  fireEvent.click(help);
  expect(screen.getByText(/Shared references/)).toBeTruthy();
  fireEvent.click(help);
  expect(screen.queryByText("Original agent runtime")).toBeNull();
});
