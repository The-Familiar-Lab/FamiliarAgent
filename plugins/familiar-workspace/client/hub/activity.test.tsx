// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubActivity, useSessionActivity } from "./activity.js";
import type { CompositionActivity } from "../../shared/activity.js";
import type { HubController } from "./controller.js";
import type { HubUi } from "./ui.js";
import type { ResultFlow } from "./result-flow.js";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("react-native", () => ({ View: "div", Text: "span" }));
vi.mock("../fleet.js", () => ({ hostRpc: (...args: unknown[]) => mocks.rpc(...args) }));
vi.mock("./ui.js", () => ({ ROW: {} }));
const endpoint = {
  id: "original",
  serverId: "remote",
  kind: "terminal",
  agentId: "terminal",
  provider: "goose",
  cwd: "/remote/project",
  createdAt: "now",
  workspaceId: "workspace",
};
const hub = {
  host: { id: "local" },
  hosts: [
    { serverId: "local", status: "online" },
    { serverId: "remote", status: "online" },
  ],
  session: { id: "A", title: "Same A", revision: 1, endpoints: [endpoint] },
  hostName: (id: string) => id,
  setTab: vi.fn(),
  setTarget: vi.fn(),
  setCwd: vi.fn(),
  setToolId: vi.fn(),
  openSetup: vi.fn(),
  openEndpoint: vi.fn(),
  run: async (task: () => Promise<unknown>) => task(),
} as unknown as HubController;
const ui = {
  button: (label: string, action: () => void, disabled = false) =>
    createElement("button", { type: "button", onClick: action, disabled }, label),
} as unknown as HubUi;
const snapshot = (serverId: string, sessionId = "A"): CompositionActivity => ({
  sessionId,
  serverId,
  observedAt: "2026-10-09T00:00:00Z",
  endpoints: [],
  runs: [],
  totalRuns: 0,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (server, _contract, input) => snapshot(server, input.id));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("ignores late activity from the previous logical session and publishes healthy hosts independently", async () => {
  let finish!: (value: CompositionActivity) => void;
  mocks.rpc.mockImplementation((server, _contract, input) =>
    server === "remote" && input.id === "A"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(snapshot(server, input.id)),
  );
  const { result, rerender } = renderHook(({ current }) => useSessionActivity(current), {
    initialProps: { current: hub },
  });
  await waitFor(() =>
    expect(result.current.hosts.find((host) => host.serverId === "local")?.value?.sessionId).toBe(
      "A",
    ),
  );
  expect(result.current.hosts.find((host) => host.serverId === "remote")?.checking).toBe(true);
  rerender({ current: { ...hub, session: { ...hub.session!, id: "B" } } });
  await waitFor(() =>
    expect(result.current.hosts.every((host) => host.value?.sessionId === "B")).toBe(true),
  );
  await act(async () => finish(snapshot("remote", "A")));
  expect(result.current.hosts.every((host) => host.value?.sessionId === "B")).toBe(true);
});
it("polls only active observations and stops after failure until an explicit refresh", async () => {
  vi.useFakeTimers();
  let failed = false;
  mocks.rpc.mockImplementation(async (server, _contract, input) => {
    if (failed && server === "remote") throw new Error("Original server unavailable");
    const value = snapshot(server, input.id);
    if (server === "remote")
      value.runs = [
        {
          runId: "run",
          toolId: "goose",
          action: "run",
          cwd: "/remote/project",
          state: "running",
          createdAt: "now",
          updatedAt: "now",
          hasResult: false,
        },
      ];
    return value;
  });
  const { result, unmount } = renderHook(() => useSessionActivity(hub));
  await act(async () => undefined);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  failed = true;
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(mocks.rpc).toHaveBeenCalledTimes(3);
  expect(result.current.hosts.find((host) => host.serverId === "remote")?.error).toBe(
    "Original server unavailable",
  );
  await act(async () => vi.advanceTimersByTimeAsync(12000));
  expect(mocks.rpc).toHaveBeenCalledTimes(3);
  failed = false;
  act(() => result.current.refresh());
  await act(async () => undefined);
  expect(mocks.rpc).toHaveBeenCalledTimes(5);
  unmount();
  await act(async () => vi.advanceTimersByTimeAsync(12000));
  expect(mocks.rpc).toHaveBeenCalledTimes(5);
});
it("shows native exit and accepted work honestly and opens the correct original or bounded result", async () => {
  const resultText = "Exact native result";
  mocks.rpc.mockImplementation(async (server, contract, input) => {
    if (contract.name === "tools.run.read")
      return { request: { sessionId: "A" }, result: { text: resultText } };
    const value = snapshot(server, input.id);
    if (server === "remote") {
      value.endpoints = [
        {
          endpointId: "original",
          serverId: "remote",
          nativeId: "terminal",
          toolId: "goose",
          kind: "terminal",
          cwd: "/remote/project",
          state: "closed",
          readiness: "unavailable",
          source: "native-terminal",
          detail: "Original terminal exited. This does not confirm completion.",
        },
      ];
      value.runs = [
        {
          runId: "accepted",
          toolId: "openrig",
          action: "submit",
          cwd: "/remote/project",
          state: "submitted",
          createdAt: "now",
          updatedAt: "now",
          hasResult: true,
        },
      ];
    }
    return value;
  });
  render(createElement(HubActivity, { hub, ui, flow: {} as ResultFlow }));
  await screen.findByText(/task completion is not confirmed/);
  expect(screen.queryByText("Use result…")).toBeNull();
  fireEvent.click(screen.getByText("Open original"));
  expect(hub.openEndpoint).toHaveBeenCalledWith({ id: endpoint.id }, "A");
  expect(mocks.rpc.mock.calls.some(([, contract]) => contract.name === "tools.run.read")).toBe(
    false,
  );
  fireEvent.click(screen.getByText("View result"));
  await screen.findByText(resultText);
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    "remote",
    expect.objectContaining({ name: "tools.run.read" }),
    { id: "accepted" },
  );
  fireEvent.click(screen.getByText("Open original actions"));
  expect(hub.setTarget).toHaveBeenCalledWith("remote");
  expect(hub.setCwd).toHaveBeenCalledWith("/remote/project");
  expect(hub.setToolId).toHaveBeenCalledWith("openrig");
  expect(hub.setTab).toHaveBeenCalledWith("Tools");
});
it("rejects cross-session responses and never polls offline hosts", async () => {
  mocks.rpc.mockResolvedValue(snapshot("local", "wrong"));
  const { result } = renderHook(() =>
    useSessionActivity({
      ...hub,
      hosts: [hub.hosts[0]!, { ...hub.hosts[1]!, status: "offline" }],
    }),
  );
  await waitFor(() =>
    expect(result.current.hosts.find((host) => host.serverId === "local")?.error).toMatch(
      /another session/,
    ),
  );
  expect(result.current.hosts.find((host) => host.serverId === "remote")?.error).toMatch(/offline/);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});

it("does not poll a retained hidden panel and resumes only when its activity section becomes visible", async () => {
  let observe!: (entries: Array<{ isIntersecting: boolean }>) => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof observe) {
        observe = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  try {
    const view = render(createElement(HubActivity, { hub, ui, flow: {} as ResultFlow }));
    await act(async () => undefined);
    expect(mocks.rpc).not.toHaveBeenCalled();
    act(() => observe([{ isIntersecting: true }]));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    act(() => observe([{ isIntersecting: false }]));
    fireEvent.click(screen.getByText("Refresh activity"));
    await act(async () => undefined);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    act(() => observe([{ isIntersecting: true }]));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(4));
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
