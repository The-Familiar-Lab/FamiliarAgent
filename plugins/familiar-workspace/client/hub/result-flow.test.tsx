// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResultFlow, nativeTargetKey } from "./result-flow.js";
import { resultInputStatus } from "./result-actions.js";
import type { HubController } from "./controller.js";
import type { CompositionProject, CompositionSession } from "../../shared/composition.js";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  connect: vi.fn(),
  copy: vi.fn(),
  create: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  getPaseoClient: (serverId: string) => ({
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({
          agent: { id, cwd: `/${serverId}/project`, title: id, provider: "codex", model: "model" },
        }),
      }),
    },
  }),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ copyText: mocks.copy }));
vi.mock("../fleet.js", () => ({
  hostRpc: (...args: unknown[]) => mocks.rpc(...args),
  connectContextSources: mocks.connect,
  operationId: () => globalThis.crypto.randomUUID(),
}));

const sha256 = "a".repeat(64);
const selection = {
  segments: [{ cursor: { epoch: "epoch", seq: 2 }, messageId: "response", sha256, bytes: 14 }],
  sha256,
  bytes: 14,
};
const resource = {
  id: "history",
  kind: "history" as const,
  label: "Source",
  serverId: "mac",
  format: "native-timeline" as const,
  locator: "source",
  readOnly: true,
};
const capture = {
  anchor: {
    resource,
    selection: { segments: [{ ordinal: 1, sha256, bytes: 14 }], sha256, bytes: 14 },
  },
  text: "older response",
};
const endpoint = (id: string, serverId: string, agentId: string) => ({
  id,
  kind: "agent" as const,
  serverId,
  agentId,
  provider: "codex",
  cwd: `/${serverId}/project`,
  createdAt: "now",
});
const sourceEndpoint = endpoint("source-endpoint", "mac", "source");
const targetEndpoint = endpoint("target-endpoint", "linux", "target");
const project: CompositionProject = {
  id: "project",
  title: "Source project",
  memory: "",
  resources: [],
  revision: 1,
  updatedAt: "now",
};
const linkedSession: CompositionSession = {
  id: "logical-A",
  projectId: project.id,
  title: "A",
  revision: 1,
  createdAt: "now",
  updatedAt: "now",
  memory: "",
  resources: [resource],
  endpoints: [sourceEndpoint, targetEndpoint],
  activeEndpointId: targetEndpoint.id,
  parent: null,
};
let stored: CompositionSession | null;
let delivered: "accepted" | "failed" | "throw";
let captureFailure: boolean;
let previewFailure: boolean;
const record = (state = "prepared") => ({
  result: {
    id: "result-one",
    sessionId: stored!.id,
    sourceEndpointId: sourceEndpoint.id,
    createdAt: "now",
    anchor: capture.anchor,
    preview: capture.text,
  },
  input: {
    id: "input-one",
    sessionId: stored!.id,
    resultId: "result-one",
    targetEndpointId: targetEndpoint.id,
    targetServerId: "linux",
    targetAgentId: "target",
    instruction: "use this",
    inputSha256: sha256,
    state,
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
    error: state === "failed" ? "Target is busy" : null,
  },
});
function useTestHub() {
  const [session, setSession] = useState<CompositionSession | null>(null);
  const [selectedProject, setProject] = useState<CompositionProject | null>(null);
  const [tab, setTab] = useState("Projects");
  const [target, setTarget] = useState("mac");
  const [cwd, setCwd] = useState("/mac/project");
  const [title, setTitle] = useState("");
  const [modelId, setModelId] = useState("model");
  return {
    host: { id: "mac" },
    hosts: [
      { serverId: "mac", isLocal: true, status: "online" },
      { serverId: "linux", status: "online", connection: "ssh://example-host" },
    ],
    session,
    setSession,
    project: selectedProject,
    setProject,
    tab,
    setTab,
    target,
    setTarget,
    cwd,
    setCwd,
    title,
    setTitle,
    setMemory: vi.fn(),
    setNotice: vi.fn(),
    fail: vi.fn(),
    selectedTool: { nativeProvider: "codex" },
    modelId,
    setModelId,
    nativeTargetSelection: () => ({
      serverId: target,
      cwd,
      title,
      provider: "codex",
      modelId,
      thinking: "high",
      toolId: "codex",
    }),
    createNativeTarget: mocks.create,
    refresh: mocks.refresh,
    run: async (action: () => Promise<void>) => action(),
  } as unknown as HubController;
}
const route = { resultAgentId: "source", resultSelection: JSON.stringify(selection) };
const rpcNames = () => mocks.rpc.mock.calls.map((call) => call[1].name);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockReset();
  stored = structuredClone(linkedSession);
  delivered = "accepted";
  captureFailure = false;
  previewFailure = false;
  mocks.rpc.mockImplementation(async (_server, contract, input) => {
    switch (contract.name) {
      case "composition.result.capture":
        if (captureFailure) throw new Error("This provider has no durable original result API");
        return capture;
      case "composition.result.preview":
        if (previewFailure) throw new Error("Selected response cursor is no longer current");
        return { text: capture.text };
      case "composition.list":
        return { sessions: stored ? [stored] : [], projects: [], total: stored ? 1 : 0 };
      case "composition.read":
        return stored;
      case "composition.project.read":
        return project;
      case "composition.project.save":
        return project;
      case "composition.create":
        stored = { ...structuredClone(linkedSession), endpoints: [sourceEndpoint] };
        return stored;
      case "composition.bind":
        stored = {
          ...stored!,
          revision: stored!.revision + 1,
          endpoints: [sourceEndpoint, targetEndpoint],
        };
        return stored;
      case "composition.inputs.list":
        return { records: [], total: 0 };
      case "composition.input.prepare":
        return { ...record(), text: "use this\n\nolder response" };
      case "composition.input.send":
        if (delivered === "throw") throw new Error("Connection closed");
        return record(delivered);
      case "composition.input.reconcile":
        return record("unknown");
      default:
        throw new Error(`Unexpected ${contract.name}: ${JSON.stringify(input)}`);
    }
  });
});
afterEach(cleanup);
describe("result input flow", () => {
  it("routes a selected native result into a linked original tool without creating another native agent", async () => {
    const toolEndpoint = {
      ...targetEndpoint,
      kind: "tool" as const,
      agentId: "goose-endpoint",
      provider: "goose",
    };
    stored!.endpoints.push(toolEndpoint);
    const { result } = renderHook(() => useResultFlow(useTestHub(), "mac", route));
    await waitFor(() => expect(result.current.draft?.session?.id).toBe("logical-A"));
    act(() => result.current.setInstruction("Continue this result in Goose"));
    await act(() =>
      result.current.send({
        serverId: "linux",
        toolId: "goose",
        cwd: "/linux/project",
        action: "run",
        parameters: { provider: "claude-code" },
      }),
    );
    const prepared = mocks.rpc.mock.calls.find(
      (call) => call[1].name === "composition.input.prepare",
    )!;
    expect(prepared[2]).toMatchObject({
      id: "logical-A",
      sourceEndpointId: sourceEndpoint.id,
      targetEndpointId: toolEndpoint.id,
      tool: { action: "run", parameters: { provider: "claude-code" } },
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(result.current.submitted?.input.state).toBe("accepted");
  });
  it("uses a completed original tool result as the source of a native continuation", async () => {
    const toolEndpoint = {
      ...sourceEndpoint,
      kind: "tool" as const,
      agentId: "goose-endpoint",
      provider: "goose",
    };
    const toolCapture = {
      ...capture,
      anchor: {
        ...capture.anchor,
        resource: {
          ...resource,
          id: "tool-run",
          format: "tool-result" as const,
          locator: "run-id",
          boundary: {
            kind: "tool" as const,
            toolId: "goose",
            cwd: "/mac/project",
            sessionId: "logical-A",
            sha256,
          },
        },
      },
    };
    stored!.endpoints = [toolEndpoint, targetEndpoint];
    stored!.resources = [toolCapture.anchor.resource];
    const previous = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (...args: unknown[]) =>
      (args[1] as { name: string }).name === "tools.run.capture" ? toolCapture : previous(...args),
    );
    const { result } = renderHook(() => useResultFlow(useTestHub(), "mac"));
    await act(() =>
      result.current.useToolResult({
        id: "run-id",
        serverId: "mac",
        request: {
          toolId: "goose",
          action: "run",
          cwd: "/mac/project",
          sessionId: "logical-A",
          input: "earlier prompt",
          parameters: {},
        },
        state: "completed",
        createdAt: "now",
        updatedAt: "now",
        result: { state: "completed", text: "older response" },
        resultSha256: sha256,
        error: null,
      }),
    );
    act(() => result.current.setTargetKey(nativeTargetKey("linux", "target")));
    await act(() => result.current.send());
    const prepared = mocks.rpc.mock.calls.find(
      (call) => call[1].name === "composition.input.prepare",
    )!;
    expect(prepared[2]).toMatchObject({
      id: "logical-A",
      sourceEndpointId: toolEndpoint.id,
      targetEndpointId: targetEndpoint.id,
      anchor: toolCapture.anchor,
    });
    expect(rpcNames()).not.toContain("composition.result.capture");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("preserves the complete original target after stateful title, path and model normalization during a lost acknowledgement", async () => {
    const { result } = renderHook(() => {
      const hub = useTestHub();
      return { hub, flow: useResultFlow(hub, "mac", route) };
    });
    await waitFor(() => expect(result.current.flow.draft).not.toBeNull());
    act(() => {
      result.current.hub.setTitle("Custom target name");
      result.current.hub.setCwd("/linux/project-link");
      result.current.hub.setModelId("selected-model");
      result.current.flow.setTargetKey("new");
    });
    mocks.create
      .mockImplementationOnce(async () => {
        result.current.hub.setCwd("/linux/normalized-project");
        result.current.hub.setModelId("default-model");
        throw new Error("Bind acknowledgement lost");
      })
      .mockResolvedValue({ session: structuredClone(linkedSession), handle: { id: "target" } });
    await act(async () => {
      await expect(result.current.flow.send()).rejects.toThrow("acknowledgement lost");
    });
    expect(result.current.hub.title).toBe("A");
    expect(result.current.hub.cwd).toBe("/linux/normalized-project");
    expect(result.current.hub.modelId).toBe("default-model");
    await act(() => result.current.flow.send());
    const first = mocks.create.mock.calls[0]![2];
    const second = mocks.create.mock.calls[1]![2];
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.selection).toEqual(first.selection);
    expect(second.selection).toMatchObject({
      title: "Custom target name",
      cwd: "/linux/project-link",
      modelId: "selected-model",
      serverId: "linux",
    });
    expect(rpcNames().filter((name) => name === "composition.input.send")).toHaveLength(1);
  });
  it("provides manual Copy input when durable linking is unsupported without enabling automatic send", async () => {
    captureFailure = true;
    const { result } = renderHook(() => useResultFlow(useTestHub(), "mac", route));
    await waitFor(() => expect(result.current.manual?.text).toBe("older response"));
    expect(result.current.draft).toBeNull();
    await act(() => result.current.send());
    await act(() => result.current.copy());
    expect(mocks.copy).toHaveBeenCalledWith("older response");
    expect(rpcNames()).not.toContain("composition.input.prepare");
    expect(rpcNames()).not.toContain("composition.create");
    expect(result.current.manual).toMatchObject({ serverId: "mac", agentId: "source" });
  });
  it("retains an Open original destination when even the selected preview is unavailable", async () => {
    captureFailure = true;
    previewFailure = true;
    const { result } = renderHook(() => useResultFlow(useTestHub(), "mac", route));
    await waitFor(() => expect(result.current.manual).not.toBeNull());
    expect(result.current.manual).toMatchObject({ serverId: "mac", agentId: "source", text: null });
    await expect(result.current.copy()).rejects.toThrow("Open the original conversation");
    expect(mocks.copy).not.toHaveBeenCalled();
  });
  it("reuses a native creation key after a lost create acknowledgement", async () => {
    mocks.create
      .mockRejectedValueOnce(new Error("Create acknowledgement lost"))
      .mockResolvedValue({ session: structuredClone(linkedSession), handle: { id: "target" } });
    const { result } = renderHook(() => useResultFlow(useTestHub(), "mac", route));
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setTargetKey("new"));
    await act(async () => {
      await expect(result.current.send()).rejects.toThrow("acknowledgement lost");
    });
    await act(() => result.current.send());
    const keys = mocks.create.mock.calls.map((call) => call[2].idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(rpcNames().filter((name) => name === "composition.input.send")).toHaveLength(1);
  });
  it("opening and cancelling an unlinked source only reads metadata and selected text", async () => {
    stored = null;
    const { result } = renderHook(() => useResultFlow(useTestHub(), "mac", route));
    await waitFor(() => expect(result.current.draft?.capture.text).toBe("older response"));
    act(() => result.current.cancel());
    expect(result.current.draft).toBeNull();
    expect(
      rpcNames().every((name) => ["composition.result.capture", "composition.list"].includes(name)),
    ).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("sends the chosen older source into B while preserving logical A and the source anchor", async () => {
    const { result } = renderHook(() => useResultFlow(useTestHub(), "mac", route));
    await waitFor(() => expect(result.current.draft?.session?.id).toBe("logical-A"));
    act(() => result.current.setInstruction("use this"));
    await act(() => result.current.send());
    const prepared = mocks.rpc.mock.calls.find(
      (call) => call[1].name === "composition.input.prepare",
    )!;
    expect(prepared[2]).toMatchObject({
      id: "logical-A",
      anchor: capture.anchor,
      sourceEndpointId: sourceEndpoint.id,
      targetEndpointId: targetEndpoint.id,
      instruction: "use this",
    });
    const sent = mocks.rpc.mock.calls.find((call) => call[1].name === "composition.input.send")!;
    expect(sent[0]).toBe("linux");
    expect(sent[2]).toEqual({ id: "logical-A", inputId: "input-one" });
    expect(result.current.submitted?.input.state).toBe("accepted");
    expect(rpcNames()).not.toContain("composition.create");
    expect(resultInputStatus("accepted")).toContain("does not mean the task is complete");
  });
  it("creates the correct source logical session only on explicit Send input", async () => {
    stored = null;
    const { result } = renderHook(() => useResultFlow(useTestHub(), "mac", route));
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setTargetKey(nativeTargetKey("linux", "target")));
    expect(rpcNames()).not.toContain("composition.create");
    await act(() => result.current.send());
    expect(rpcNames().filter((name) => name === "composition.create")).toHaveLength(1);
    const created = mocks.rpc.mock.calls.find((call) => call[1].name === "composition.create")!;
    expect(created[2].endpoint).toMatchObject({
      serverId: "mac",
      agentId: "source",
      cwd: "/mac/project",
    });
    expect(result.current.submitted?.input.sessionId).toBe(stored!.id);
  });
  it.each(["failed", "throw"] as const)(
    "does not resend after %s; Check status only reconciles receipts",
    async (state) => {
      delivered = state;
      const { result } = renderHook(() => useResultFlow(useTestHub(), "mac", route));
      await waitFor(() => expect(result.current.draft).not.toBeNull());
      await act(() => result.current.send());
      await act(() => result.current.send());
      await act(() => result.current.sendPrepared(result.current.submitted!));
      expect(rpcNames().filter((name) => name === "composition.input.send")).toHaveLength(1);
      if (state === "throw")
        expect(result.current.deliveryError).toContain("not be automatically resent");
      else expect(result.current.submitted?.input.error).toBe("Target is busy");
      await act(() => result.current.check(result.current.submitted!));
      expect(result.current.submitted?.input.state).toBe("unknown");
      expect(rpcNames().filter((name) => name === "composition.input.send")).toHaveLength(1);
    },
  );
  it("manual Copy input does not create or dispatch a logical input", async () => {
    stored = null;
    const { result } = renderHook(() => useResultFlow(useTestHub(), "mac", route));
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setInstruction("Review this"));
    await act(() => result.current.copy());
    expect(mocks.copy).toHaveBeenCalledWith("Review this\n\nolder response");
    expect(rpcNames()).not.toContain("composition.input.prepare");
    expect(rpcNames()).not.toContain("composition.create");
  });
});
