// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SetupAgentPicker } from "./setup-agent.js";
import type { HubController } from "./controller.js";
import type { HubUi } from "./ui.js";
import type { ToolEntry } from "../../shared/tool-catalog.js";
const mocks = vi.hoisted(() => ({ models: vi.fn(), modes: vi.fn(), host: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({
  getPaseoClient: (server: string) => {
    mocks.host(server);
    return { providers: { listModels: mocks.models, listModes: mocks.modes } };
  },
}));
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
beforeEach(() => {
  mocks.models.mockReset().mockResolvedValue({
    models: [
      {
        id: "model",
        label: "Original model",
        isDefault: true,
        defaultThinkingOptionId: "medium",
        thinkingOptions: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
      { id: "other", label: "Other model", thinkingOptions: [{ id: "low", label: "Low" }] },
      { id: "unavailable", label: "Unsupported", isSelectable: false },
    ],
  });
  mocks.modes.mockReset().mockResolvedValue({
    modes: [
      {
        id: "approval",
        label: "Ask before actions",
        description: "Original native approval mode",
      },
    ],
  });
});
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

const installed = ["codex", "claude"].map((provider) => ({
  serverId: "mac",
  tool: { id: provider, name: provider, installed: true, nativeProvider: provider },
}));
it("honors the signed-in provider selection and sends selected native model, thinking and permissions", async () => {
  const hub = { ...base, tools: installed, askSetup: vi.fn() } as unknown as HubController;
  render(
    createElement(SetupAgentPicker, {
      hub,
      ui,
      tool,
      serverId: "mac",
      preferredProvider: "claude",
    }),
  );
  expect((screen.getByLabelText("Setup agent") as HTMLSelectElement).value).toBe("provider:claude");
  expect((screen.getByText("Ask selected agent") as HTMLButtonElement).disabled).toBe(true);
  await screen.findByLabelText("Setup model");
  expect(screen.queryByText("Unsupported")).toBeNull();
  expect(mocks.models).toHaveBeenCalledWith("claude", { cwd: "/mac/project" });
  fireEvent.change(screen.getByLabelText("Setup thinking"), { target: { value: "high" } });
  fireEvent.change(screen.getByLabelText("Setup permission mode"), {
    target: { value: "approval" },
  });
  expect(screen.getByText("Original native approval mode")).toBeTruthy();
  fireEvent.click(screen.getByText("Ask selected agent"));
  await waitFor(() =>
    expect(hub.askSetup).toHaveBeenCalledWith("mac", tool, {
      provider: "claude",
      cwd: "/mac/project",
      model: "model",
      thinkingOptionId: "high",
      modeId: "approval",
    }),
  );
});
it("rejects stale discovery after changing provider and resets unsupported thinking on model change", async () => {
  let finish!: (value: unknown) => void;
  mocks.models.mockImplementation((provider: string) =>
    provider === "codex"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({
          models: [
            {
              id: "claude-model",
              label: "Claude model",
              thinkingOptions: [{ id: "high", label: "High" }],
            },
            { id: "small", label: "Small model", thinkingOptions: [{ id: "low", label: "Low" }] },
          ],
        }),
  );
  const hub = { ...base, tools: installed } as unknown as HubController;
  render(createElement(SetupAgentPicker, { hub, ui, tool, serverId: "mac" }));
  await waitFor(() => expect(mocks.models).toHaveBeenCalledWith("codex", expect.anything()));
  fireEvent.change(screen.getByLabelText("Setup agent"), { target: { value: "provider:claude" } });
  await screen.findByText("Claude model");
  finish({ models: [{ id: "stale", label: "Stale model" }] });
  fireEvent.change(screen.getByLabelText("Setup thinking"), { target: { value: "high" } });
  fireEvent.change(screen.getByLabelText("Setup model"), { target: { value: "small" } });
  expect((screen.getByLabelText("Setup thinking") as HTMLSelectElement).value).toBe("");
  await waitFor(() => expect(screen.queryByText("Stale model")).toBeNull());
});
it("exposes provider discovery failures with Retry while other setup choices remain usable", async () => {
  mocks.modes.mockRejectedValueOnce(new Error("Disconnected"));
  const hub = { ...base, tools: installed } as unknown as HubController;
  render(createElement(SetupAgentPicker, { hub, ui, tool, serverId: "mac" }));
  await screen.findByText("Disconnected");
  expect((screen.getByText("Ask selected agent") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Retry agent options"));
  await screen.findByLabelText("Setup model");
  expect((screen.getByText("Ask selected agent") as HTMLButtonElement).disabled).toBe(false);
});
