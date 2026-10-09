// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SetupAgentPicker } from "./setup-agent.js";
import type { HubController } from "./controller.js";
import type { HubUi } from "./ui.js";
import type { ToolEntry } from "../../shared/tool-catalog.js";
vi.mock("react-native", () => ({ View: "div", Text: "span" }));
vi.mock("./ui.js", () => ({
  ROW: {},
  HubPicker: ({
    label,
    value,
    options,
    onChange,
  }: {
    label: string;
    value: string;
    options: { id: string; label: string }[];
    onChange: (value: string) => void;
  }) =>
    createElement(
      "select",
      {
        "aria-label": label,
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
      },
      options.map((option) =>
        createElement("option", { key: option.id, value: option.id }, option.label),
      ),
    ),
}));
const ui = {
  button: (label: string, click: () => void, disabled = false) =>
    createElement("button", { type: "button", onClick: click, disabled }, label),
  field: (label: string, value: string, onChange: (value: string) => void) =>
    createElement("input", {
      "aria-label": label,
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    }),
} as unknown as HubUi;
const tool = { id: "goose", name: "Goose" } as ToolEntry;
const base = {
  hosts: [
    { serverId: "mac", label: "Mac", status: "online" },
    { serverId: "linux", label: "Linux", status: "online" },
  ],
  target: "mac",
  cwd: "/mac/project",
  tools: [],
  fleet: [],
  project: { resources: [{ kind: "codebase", serverId: "linux", locator: "/linux/project" }] },
  openSetup: vi.fn(),
  askSetup: vi.fn(),
} as unknown as HubController;
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("offers provider setup when no agent is available, without a dead Ask button", () => {
  render(createElement(SetupAgentPicker, { hub: base, ui, tool, serverId: "mac" }));
  expect(screen.getByText(/No agent is available here/)).toBeTruthy();
  fireEvent.click(screen.getByText("Set up Codex"));
  expect(base.openSetup).toHaveBeenCalledWith("mac", "codex");
  expect(base.askSetup).not.toHaveBeenCalled();
});
it("uses the explicitly chosen server, mapped folder and existing agent and exposes rejection", async () => {
  const hub = {
    ...base,
    fleet: [
      {
        server: { serverId: "linux" },
        agents: [
          {
            id: "chosen",
            title: "Chosen agent",
            provider: "claude",
            model: "Model",
            status: "idle",
          },
        ],
      },
    ],
    askSetup: vi.fn().mockRejectedValue(new Error("Agent is busy; no input was sent")),
  } as unknown as HubController;
  render(createElement(SetupAgentPicker, { hub, ui, tool, serverId: "mac" }));
  fireEvent.change(screen.getByLabelText("Setup server"), { target: { value: "linux" } });
  expect((screen.getByLabelText("Setup project folder (optional)") as HTMLInputElement).value).toBe(
    "/linux/project",
  );
  fireEvent.click(screen.getByText("Ask selected agent"));
  await waitFor(() =>
    expect(hub.askSetup).toHaveBeenCalledWith("linux", tool, {
      agentId: "chosen",
      cwd: "/linux/project",
    }),
  );
  await screen.findByText("Agent is busy; no input was sent");
  expect(hub.askSetup).toHaveBeenCalledTimes(1);
});
