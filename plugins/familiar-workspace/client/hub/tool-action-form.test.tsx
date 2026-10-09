// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubController } from "./controller.js";
import type { ResultFlow } from "./result-flow.js";
import type { CompositionSession } from "../../shared/composition.js";
import { startToolAction } from "../../shared/tool-actions.js";
import { useToolActionForm } from "./tool-action-form.js";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), bind: vi.fn(), connect: vi.fn() }));
vi.mock("../fleet.js", () => ({
  hostRpc: (...args: unknown[]) => mocks.rpc(...args),
  operationId: () => crypto.randomUUID(),
  connectContextSources: mocks.connect,
}));
vi.mock("./tool-action-links.js", () => ({ bindToolEndpoint: mocks.bind }));
const session = {
  id: "logical-A",
  projectId: "project",
  title: "A",
  revision: 1,
  endpoints: [],
  resources: [],
  memory: "",
  createdAt: "now",
  updatedAt: "now",
  parent: null,
  activeEndpointId: null,
} as CompositionSession;
const project = { id: "project" };
const flow = {} as ResultFlow;
const definitions = [
  {
    toolId: "codeg",
    actions: [
      {
        id: "send",
        label: "Send",
        description: "Native send",
        input: true,
        inputMode: "prompt",
        nativeId: true,
        parameters: [{ key: "url", label: "URL", required: true }],
      },
    ],
  },
];
let startFails: boolean;
beforeEach(() => {
  vi.clearAllMocks();
  startFails = false;
  mocks.bind.mockImplementation(async (_: string, value: CompositionSession) => ({
    session: value,
    endpoint: {},
  }));
  mocks.rpc.mockImplementation(
    async (_host: string, contract: { name: string }, input: unknown) => {
      if (contract.name === startToolAction.name) startToolAction.input.parse(input);
      if (contract.name === "tools.actions") return definitions;
      if (contract.name === "tools.action-settings.read")
        return { parameters: { url: "http://native" } };
      if (contract.name === "tools.action-settings.save")
        return { parameters: { url: "http://native" } };
      if (contract.name === "composition.create") return session;
      if (contract.name === "tools.run.start" && startFails) throw Error("Lost acknowledgement");
      return {};
    },
  );
});
afterEach(cleanup);
function useForm(target = "mac", asInput = false) {
  const [value, setSession] = useState<CompositionSession | null>(null);
  const hub = {
    target,
    cwd: "/project",
    title: "A",
    session: value,
    project,
    host: { id: "mac" },
    hosts: [{ serverId: "mac" }, { serverId: "linux" }],
    setSession,
    setProject: vi.fn(),
    setNotice: vi.fn(),
    setTarget: vi.fn(),
    setToolId: vi.fn(),
    setCwd: vi.fn(),
    ensureProject: async () => project,
  } as unknown as HubController;
  return useToolActionForm(hub, flow, asInput, vi.fn());
}
async function choose(result: { current: ReturnType<typeof useForm> }) {
  await waitFor(() => expect(result.current.definitions).toHaveLength(1));
  act(() => result.current.selectTool("codeg"));
  act(() => result.current.selectAction("send"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => {
    result.current.setInput("selected result");
    result.current.setNativeId("native-1");
  });
}
it("opening and choosing an action only reads; saved settings belong to the chosen host", async () => {
  const { result } = renderHook(() => useForm());
  await choose(result);
  expect(mocks.rpc.mock.calls.some((call) => call[1].name === "tools.run.start")).toBe(false);
  await act(() => result.current.save());
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    "mac",
    expect.objectContaining({ name: "tools.action-settings.save" }),
    { toolId: "codeg", action: "send", parameters: { url: "http://native" } },
  );
});
it("retains the native operation ID after session selection and a lost start acknowledgement", async () => {
  const { result } = renderHook(() => useForm());
  await choose(result);
  startFails = true;
  await act(async () => {
    await expect(result.current.perform()).rejects.toThrow("Lost acknowledgement");
  });
  startFails = false;
  await act(() => result.current.perform());
  const starts = mocks.rpc.mock.calls.filter((call) => call[1].name === "tools.run.start");
  expect(starts).toHaveLength(2);
  expect(starts[0]![2]).toEqual(starts[1]![2]);
  expect(starts[1]![2].sessionId).toBe("logical-A");
  expect(mocks.rpc.mock.calls.filter((call) => call[1].name === "composition.create")).toHaveLength(
    1,
  );
});
it("routes native actions to their server without leaking routing fields into the strict request", async () => {
  const { result } = renderHook(() => useForm("linux"));
  await choose(result);
  await act(() => result.current.perform());
  const starts = mocks.rpc.mock.calls.filter((call) => call[1].name === startToolAction.name);
  expect(starts).toHaveLength(1);
  expect(starts[0]![0]).toBe("linux");
  const request = starts[0]![2];
  expect(startToolAction.input.parse(request)).toEqual(request);
  expect(request).not.toHaveProperty("serverId");
  expect(request).toEqual({
    operationId: expect.any(String),
    toolId: "codeg",
    action: "send",
    cwd: "/project",
    nativeId: "native-1",
    parameters: { url: "http://native" },
    sessionId: "logical-A",
    input: "selected result",
  });
});
it("ignores a settings reply from a previous server and preserves an explicitly selected original ID", async () => {
  let late: ((value: { parameters: Record<string, string> }) => void) | undefined;
  const original = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((host, contract, ...rest) =>
    contract.name === "tools.action-settings.read" && host === "mac"
      ? new Promise((resolve) => {
          late = resolve;
        })
      : original(host, contract, ...rest),
  );
  const { result, rerender } = renderHook(({ target }) => useForm(target), {
    initialProps: { target: "mac" },
  });
  await waitFor(() => expect(result.current.definitions).toHaveLength(1));
  act(() => result.current.selectTool("codeg"));
  act(() => result.current.selectAction("send"));
  await waitFor(() => expect(late).toBeDefined());
  act(() => result.current.useOriginal("linux", "codeg", "/native", "correct-native-id"));
  rerender({ target: "linux" });
  act(() => result.current.selectAction("send"));
  await waitFor(() => expect(result.current.parameters.url).toBe("http://native"));
  await act(async () => late!({ parameters: { url: "http://wrong-host" } }));
  expect(result.current.parameters.url).toBe("http://native");
  expect(result.current.nativeId).toBe("correct-native-id");
});

it("only offers genuine prompt actions when mapping a selected result", async () => {
  const original = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((host, contract, ...rest) =>
    contract.name === "tools.actions"
      ? Promise.resolve([
          {
            toolId: "codeg",
            actions: [
              ...definitions[0]!.actions,
              { id: "exec", label: "Command", input: true, inputMode: "command" },
              { id: "search", label: "Search", input: true, inputMode: "data" },
            ],
          },
        ])
      : original(host, contract, ...rest),
  );
  const { result } = renderHook(() => useForm("mac", true));
  await waitFor(() => expect(result.current.definitions).toHaveLength(1));
  act(() => result.current.selectTool("codeg"));
  expect(result.current.actions.map((action) => action.id)).toEqual(["send"]);
});
