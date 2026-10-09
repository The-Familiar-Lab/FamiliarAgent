// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolRunSummary } from "../../shared/tool-actions.js";
import type { HubController } from "./controller.js";
import type { HubUi } from "./ui.js";
import type { ResultFlow } from "./result-flow.js";
import type { useToolActionForm } from "./tool-action-form.js";
import { ToolRunCard } from "./tool-run-card.js";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("react-native", () => ({ View: "div", Text: "span" }));
vi.mock("../fleet.js", () => ({ hostRpc: (...args: unknown[]) => mocks.rpc(...args) }));
vi.mock("./ui.js", () => ({ ROW: {} }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const run = {
  id: "operation",
  serverId: "linux",
  state: "completed",
  createdAt: "now",
  updatedAt: "now",
  request: {
    toolId: "hydra",
    action: "read",
    cwd: "/project",
    sessionId: "same-A",
    parameters: {},
  },
  result: { state: "completed", preview: "Short preview", textBytes: 7000, nativeId: "native-run" },
  resultSha256: null,
  error: null,
} as ToolRunSummary;
const ui = {
  card: {},
  text: {},
  muted: {},
  toolHeading: {},
  error: {},
  button: (label: string, click: () => void, disabled = false) =>
    createElement("button", { type: "button", disabled, onClick: click }, label),
  field: (label: string, value: string, change: (value: string) => void) =>
    createElement("input", {
      "aria-label": label,
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => change(event.target.value),
    }),
} as unknown as HubUi;
const hub = {
  target: "linux",
  hostName: () => "Linux",
  run: async (task: () => Promise<unknown>) => task(),
} as unknown as HubController;
const form = {
  useOriginal: vi.fn(),
  definitions: [{ toolId: "hydra", actions: [{ id: "read", nativeId: true }] }],
} as unknown as ReturnType<typeof useToolActionForm>;
it("renders a bounded preview and fetches the original full result only on explicit actions", async () => {
  const full = {
    ...run,
    result: { state: "completed", text: "Full exact original result" },
    request: { ...run.request, input: "original input" },
  };
  mocks.rpc.mockResolvedValue(full);
  const useToolResult = vi.fn();
  const flow = { useToolResult } as unknown as ResultFlow;
  render(createElement(ToolRunCard, { run, hub, ui, form, flow, refreshed: vi.fn() }));
  expect(screen.getByText("Short preview")).toBeTruthy();
  expect(mocks.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("View full result"));
  await waitFor(() => expect(screen.getByText("Full exact original result")).toBeTruthy());
  fireEvent.click(screen.getByText("Use result…"));
  await waitFor(() => expect(useToolResult).toHaveBeenCalledWith(full));
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    "linux",
    expect.objectContaining({ name: "tools.run.read" }),
    { id: "operation" },
  );
});
it("does not expose accepted work as a completed result", () => {
  render(
    createElement(ToolRunCard, {
      run: { ...run, state: "submitted" },
      hub,
      ui,
      form,
      flow: {} as ResultFlow,
      refreshed: vi.fn(),
    }),
  );
  expect(screen.queryByText("Use result…")).toBeNull();
  expect(screen.getByText(/accepted this request/)).toBeTruthy();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("only offers original ID reuse when that tool has an action accepting it on the selected server", () => {
  const props = { run, hub, ui, form, flow: {} as ResultFlow, refreshed: vi.fn() };
  const { rerender } = render(createElement(ToolRunCard, props));
  fireEvent.click(screen.getByText("Use original ID"));
  expect(form.useOriginal).toHaveBeenCalledWith("linux", "hydra", "/project", "native-run");

  rerender(
    createElement(ToolRunCard, {
      ...props,
      run: { ...run, request: { ...run.request, toolId: "agents" } },
      form: {
        ...form,
        definitions: [
          {
            toolId: "agents",
            actions: [{ id: "run", label: "Run", description: "New native turn" }],
          },
        ],
      },
    }),
  );
  expect(screen.queryByText("Use original ID")).toBeNull();
  expect(screen.getByText(/Original ID: native-run/)).toBeTruthy();

  rerender(createElement(ToolRunCard, { ...props, hub: { ...hub, target: "mac" } }));
  expect(screen.queryByText("Use original ID")).toBeNull();
  expect(screen.getByText(/Select Linux above/)).toBeTruthy();

  rerender(createElement(ToolRunCard, { ...props, form: { ...form, definitions: [] } }));
  expect(screen.queryByText("Use original ID")).toBeNull();
});
it("requires original inspection and a note before releasing an unknown operation", async () => {
  mocks.rpc.mockResolvedValue(run);
  const refreshed = vi.fn();
  render(
    createElement(ToolRunCard, {
      run: { ...run, state: "unknown" },
      hub,
      ui,
      form,
      flow: {} as ResultFlow,
      refreshed,
    }),
  );
  const release = screen.getByText("Release retry lock") as HTMLButtonElement;
  expect(release.disabled).toBe(true);
  fireEvent.click(screen.getByText("I checked the original task"));
  expect(release.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("What did the original tool show?"), {
    target: { value: "The native run failed before a response." },
  });
  fireEvent.click(release);
  await waitFor(() => expect(refreshed).toHaveBeenCalled());
  expect(mocks.rpc).toHaveBeenCalledWith(
    "linux",
    expect.objectContaining({ name: "tools.run.resolve" }),
    { id: "operation", originalChecked: true, note: "The native run failed before a response." },
  );
});
