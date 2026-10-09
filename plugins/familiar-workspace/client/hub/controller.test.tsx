// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHubController, type HubProps } from "./controller.js";
import { readSetupReturn, saveSetupReturn } from "./setup-return.js";
import type { CompositionProject, CompositionSession } from "../../shared/composition.js";
import type { ToolEntry } from "../../shared/tool-catalog.js";
const mocks = vi.hoisted(() => ({
  hosts: [
    { serverId: "mac", label: "Mac", status: "online", isLocal: true },
    { serverId: "linux", label: "Ubuntu", status: "online" },
  ],
  rpc: vi.fn(),
  createAgent: vi.fn(),
  openWorkspace: vi.fn(),
  createTerminal: vi.fn(),
  openAgent: vi.fn(),
  openTerminal: vi.fn(),
  listModels: vi.fn(),
  listModes: vi.fn(),
  refreshAgent: vi.fn(),
  send: vi.fn(),
  clientHost: vi.fn(),
  connectSources: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useHosts: () => mocks.hosts,
  openExternalUrl: vi.fn(),
  getPaseoClient: (serverId: string) => {
    mocks.clientHost(serverId);
    return {
      providers: { listModels: mocks.listModels, listModes: mocks.listModes },
      agents: {
        create: mocks.createAgent,
        ref: (id: string) => ({ id, refresh: mocks.refreshAgent, send: mocks.send }),
      },
      workspaces: { open: mocks.openWorkspace },
      terminals: { create: mocks.createTerminal },
    };
  },
}));
vi.mock("../fleet.js", () => ({
  hostRpc: (...args: unknown[]) => mocks.rpc(...args),
  readFleet: async () => [],
  operationId: () => globalThis.crypto.randomUUID(),
  continuationContext: async () => "Bounded working context; originals are references.",
  connectContextSources: mocks.connectSources,
}));
const project: CompositionProject = {
  id: "project",
  title: "Project",
  revision: 1,
  updatedAt: "now",
  memory: "",
  resources: [
    {
      id: "code",
      kind: "codebase",
      serverId: "mac",
      label: "Code",
      format: "path",
      locator: "/project",
      readOnly: true,
    },
  ],
};
const session: CompositionSession = {
  id: "session",
  projectId: project.id,
  title: "Session",
  revision: 1,
  createdAt: "now",
  updatedAt: "now",
  memory: "",
  resources: [],
  endpoints: [],
  activeEndpointId: null,
  parent: null,
};
const tool: ToolEntry = {
  id: "goose",
  name: "Goose",
  description: "Tool",
  capabilities: ["harness"],
  modes: ["terminal"],
  license: "Apache-2.0",
  installed: true,
  custom: false,
  installAvailable: false,
  notes: [],
};
const props = {
  host: { id: "mac" },
  theme: {},
  Advanced: () => null,
  navigation: { openAgent: mocks.openAgent, openTerminal: mocks.openTerminal },
} as unknown as HubProps;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.connectSources.mockReset().mockResolvedValue(undefined);
  mocks.hosts[0]!.status = "online";
  mocks.refreshAgent.mockResolvedValue({
    agent: {
      id: "native-remote",
      title: "Remote",
      cwd: "/remote/project",
      provider: "codex",
      model: "model",
    },
  });
  mocks.listModels.mockResolvedValue({
    models: [{ id: "model", label: "Model", isDefault: true }],
    error: null,
  });
  mocks.listModes.mockResolvedValue({ modes: [{ id: "approval", label: "Ask before actions" }] });
  mocks.openWorkspace.mockResolvedValue({ id: "workspace" });
  mocks.createTerminal.mockResolvedValue({ id: "terminal" });
  mocks.send.mockResolvedValue(undefined);
  mocks.createAgent.mockResolvedValue({
    send: mocks.send,
    id: "new-agent",
    cwd: "/worktrees/fork",
  });
  mocks.rpc.mockImplementation(
    async (serverId: string, contract: { name: string }, input: Record<string, unknown>) => {
      switch (contract.name) {
        case "composition.list":
          return { projects: [], sessions: [], total: 0 };
        case "tools.setup.workspace":
          return { cwd: "/server-owned/setup" };
        case "tools.list":
          return [{ ...tool, id: "codex", name: "Codex", nativeProvider: "codex" }];
        case "resources.list":
          return {
            revision: 1,
            skills: [{ id: "skill", path: `/${serverId}/skill`, enabled: true }],
            mcp: [],
          };
        case "resources.save":
          return { ...input, revision: 2 };
        case "composition.project.read":
          return project;
        case "composition.project.save":
          return { ...project, ...input, revision: 2 };
        case "composition.create":
          return session;
        case "composition.read":
          return { ...session, id: input.id };
        case "composition.fork":
          return { ...session, id: "fork", title: input.title };
        case "composition.runtime":
          return {
            mcpServers: { familiar: { type: "stdio", command: "familiar" } },
          };
        case "composition.bind":
          return {
            ...session,
            id: input.id,
            revision: 2,
            endpoints: [input.endpoint],
          };
        case "composition.update":
          return { ...session, ...input, revision: 2 };
        case "tools.context":
          return { path: "/context/session.md" };
        case "tools.prepare":
          return { command: "goose", args: [], mode: "terminal", notes: [] };
        default:
          throw new Error(`Unexpected RPC: ${contract.name}`);
      }
    },
  );
});
afterEach(cleanup);
const calls = (name: string) =>
  mocks.rpc.mock.calls.filter(([, contract]) => contract.name === name);
describe("Familiar Hub action wiring", () => {
  it("uses the frozen target choice when recovery changes the visible title, folder and model", async () => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => {
      result.current.setCwd("/chosen-folder");
      result.current.setTitle("Chosen name");
    });
    await waitFor(() => expect(result.current.modelId).toBe("model"));
    const selection = result.current.nativeTargetSelection();
    await act(async () => {
      result.current.setTitle("Session");
      result.current.setCwd("/normalized-folder");
      result.current.setModelId("different-model");
    });
    await act(async () => {
      await result.current.createNativeTarget(project, session, {
        resultInput: true,
        idempotencyKey: "one-operation",
        selection,
      });
    });
    expect(mocks.createAgent.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/chosen-folder",
      title: "Chosen name",
      config: { provider: "codex/model" },
      idempotencyKey: "one-operation",
    });
    expect(calls("composition.bind")[0]?.[2]).toMatchObject({
      endpoint: { model: "model", harness: "codex", serverId: "mac" },
    });
  });
  it("creates a result target in the same logical session without automatically adding recent history or sending", async () => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => {
      result.current.setCwd("/project");
    });
    await waitFor(() => expect(result.current.modelId).toBe("model"));
    let created: Awaited<ReturnType<typeof result.current.createNativeTarget>> | undefined;
    await act(async () => {
      created = await result.current.createNativeTarget(project, session, {
        resultInput: true,
        idempotencyKey: "selected-result-target",
      });
    });
    expect(created?.session.id).toBe(session.id);
    const options = mocks.createAgent.mock.calls[0]?.[0];
    expect(options.labels).toEqual({ familiarProject: project.id, familiarSession: session.id });
    expect(options.config.systemPrompt).toContain("specifically selected source response");
    expect(options.config.systemPrompt).not.toContain("Bounded working context");
    expect(options.prompt).toBeUndefined();
    expect(options.idempotencyKey).toBe("selected-result-target");
    expect(mocks.openAgent).not.toHaveBeenCalled();
    expect(calls("composition.create")).toHaveLength(0);
  });
  it("creates a shared logical session before first external launch and passes its reference to the tool", async () => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => result.current.setCwd("/project"));
    await act(async () => result.current.launch("mac", tool, "launch"));
    expect(calls("composition.create")).toHaveLength(1);
    expect(calls("tools.prepare")[0]?.[2]).toMatchObject({
      sessionId: "session",
      contextPath: "/context/session.md",
      cwd: "/project",
    });
    expect(calls("composition.bind")[0]?.[2]).toMatchObject({
      id: "session",
      endpoint: { kind: "terminal", serverId: "mac", agentId: "terminal" },
    });
    expect(mocks.openTerminal).toHaveBeenCalledWith({
      serverId: "mac",
      workspaceId: "workspace",
      terminalId: "terminal",
    });
  });
  it("uses the upstream Git worktree and links the actual created folder for future switches", async () => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => {
      result.current.setProject(project);
      result.current.setSession(session);
      result.current.setCwd("/project");
      result.current.setSeparateWorktree(true);
    });
    await waitFor(() => expect(result.current.modelId).toBe("model"));
    await act(async () => result.current.start(true));
    expect(mocks.createAgent.mock.calls[0]?.[0]).toMatchObject({
      worktree: { mode: "branch-off" },
      cwd: "/project",
      labels: { familiarSession: "fork" },
    });
    expect(calls("composition.bind")[0]?.[2]).toMatchObject({
      id: "fork",
      endpoint: { cwd: "/worktrees/fork", agentId: "new-agent" },
    });
    expect(
      result.current.project?.resources.some((item) => item.locator === "/worktrees/fork"),
    ).toBe(true);
    expect(result.current.cwd).toBe("/worktrees/fork");
    expect(mocks.connectSources).toHaveBeenLastCalledWith(
      "mac",
      expect.objectContaining({
        id: "fork",
        revision: 2,
        endpoints: [expect.objectContaining({ agentId: "new-agent" })],
      }),
      undefined,
      mocks.hosts,
    );
  });
  it("uses the same local catalog from a remote entry while preserving the native origin and pinned catalog", async () => {
    const remoteProps = {
      ...props,
      host: { id: "linux", label: "Ubuntu" },
      params: { agentId: "native-remote" },
    };
    const { result, rerender } = renderHook(() => useHubController(remoteProps));
    await waitFor(() => expect(result.current.entryChoice?.kind).toBe("native"));
    expect(result.current.session).toBeNull();
    expect(calls("composition.create")).toHaveLength(0);
    await act(async () =>
      result.current.attachNative(
        "linux",
        mocks.refreshAgent.mock.results[0]
          ? (await mocks.refreshAgent.mock.results[0].value).agent
          : null,
      ),
    );
    expect(result.current.session?.id).toBe("session");
    expect(result.current.host).toEqual({ id: "mac", label: "Mac" });
    expect(result.current.target).toBe("linux");
    expect(calls("composition.list").every(([serverId]) => serverId === "mac")).toBe(true);
    expect(calls("composition.create")[0]?.[2]).toMatchObject({
      endpoint: { serverId: "linux", agentId: "native-remote" },
    });
    expect(mocks.clientHost).toHaveBeenCalledWith("linux");
    expect(mocks.connectSources).toHaveBeenLastCalledWith("mac", session, undefined, mocks.hosts);
    mocks.hosts[0]!.status = "offline";
    rerender();
    expect(result.current.host.id).toBe("mac");
  });
  it.each([
    ["Session", "Session fork"],
    ["   ", "Session fork"],
    ["Edited title", "Edited title"],
  ])("names a fork from %j as %j in both logical and native sessions", async (draft, expected) => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => {
      result.current.setProject(project);
      result.current.setSession(session);
      result.current.setCwd("/project");
      result.current.setTitle(draft);
    });
    await waitFor(() => expect(result.current.modelId).toBe("model"));
    await act(async () => result.current.start(true));
    expect(calls("composition.fork")[0]?.[2].title).toBe(expected);
    expect(mocks.createAgent.mock.calls[0]?.[0].title).toBe(expected);
    expect(result.current.title).toBe(expected);
  });
  it("renews the clicked conversation's bridge rather than the previously selected session", async () => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => result.current.setSession(session));
    const endpoint = {
      id: "remote-endpoint",
      kind: "agent" as const,
      serverId: "linux",
      agentId: "remote-agent",
      provider: "codex",
      cwd: "/remote/project",
      createdAt: "now",
    };
    await act(async () => result.current.openEndpoint(endpoint, "another-session"));
    expect(mocks.connectSources).toHaveBeenCalledWith(
      "mac",
      expect.objectContaining({ id: "another-session" }),
      expect.objectContaining({ serverId: "linux" }),
      mocks.hosts,
    );
    expect(mocks.openAgent).toHaveBeenCalledWith({
      serverId: "linux",
      agentId: "remote-agent",
    });
  });
  it("keeps a committed native binding and reports recovery when its new shared scope cannot renew", async () => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => {
      result.current.setProject(project);
      result.current.setSession(session);
      result.current.setCwd("/project");
    });
    await waitFor(() => expect(result.current.modelId).toBe("model"));
    mocks.connectSources.mockImplementation(async (_host, value) => {
      if ((value as CompositionSession).revision === 2) throw new Error("Ubuntu SSH disconnected");
    });
    const start = () => result.current.start(false);
    await act(async () => result.current.run(start));
    expect(result.current.session?.revision).toBe(2);
    expect(result.current.session?.endpoints[0]?.agentId).toBe("new-agent");
    expect(result.current.error).toContain("The session link was saved");
    expect(result.current.error).toContain("reopen this session to retry");
    expect(result.current.error).not.toContain("could not be linked");
    expect(calls("composition.bind")).toHaveLength(1);
  });
  it("renews all endpoint access after Use in session with the committed imported-history reference", async () => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => {
      result.current.setProject(project);
      result.current.setSession(session);
    });
    mocks.connectSources.mockRejectedValueOnce(new Error("Previous endpoint disconnected"));
    const link = () =>
      result.current.linkHistory("linux", {
        id: "a".repeat(64),
        nativeId: "native",
        source: "Codex",
        title: "Earlier task",
        origin: "/native/source.jsonl",
        workspace: "/project",
        updatedAt: "now",
        messageCount: 10,
        hidden: false,
        notes: [],
      });
    await act(async () => result.current.run(link));
    expect(result.current.session?.resources).toEqual([
      expect.objectContaining({
        format: "imported-history",
        serverId: "linux",
        locator: "a".repeat(64),
      }),
    ]);
    expect(mocks.connectSources).toHaveBeenLastCalledWith(
      "mac",
      result.current.session,
      undefined,
      mocks.hosts,
    );
    expect(result.current.error).toContain("The session link was saved");
    expect(calls("composition.update")).toHaveLength(1);
  });
  it("fills the destination's linked project folder and clears foreign paths for unmapped servers", async () => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => {
      result.current.setProject({
        ...project,
        resources: [
          ...project.resources,
          {
            ...project.resources[0]!,
            id: "linux-code",
            serverId: "linux",
            locator: "/home/developer/project",
          },
        ],
      });
      result.current.setCwd("/project");
    });
    await act(async () => result.current.setTarget("linux"));
    expect(result.current.cwd).toBe("/home/developer/project");
    await act(async () => result.current.setTarget("mac"));
    expect(result.current.cwd).toBe("/project");
    await act(async () => result.current.setTarget("unmapped-server"));
    expect(result.current.cwd).toBe("");
  });
  it("keeps explicit folder and worktree choices instead of overriding them in an effect", async () => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => {
      result.current.setProject(project);
      result.current.setCwd("/worktrees/existing");
    });
    await act(async () => result.current.setTarget("mac"));
    expect(result.current.cwd).toBe("/worktrees/existing");
    await act(async () => {
      result.current.setTarget("linux");
      result.current.setCwd("/home/developer/chosen-worktree");
    });
    expect(result.current.cwd).toBe("/home/developer/chosen-worktree");
  });
  it("loads models for a registered Antigravity provider instead of silently omitting it", async () => {
    const { result } = renderHook(() => useHubController(props));
    await waitFor(() => expect(result.current.tools.length).toBeGreaterThan(0));
    await act(async () => {
      result.current.setTools([
        {
          serverId: "mac",
          tool: { ...tool, id: "antigravity", nativeProvider: "antigravity" },
        },
      ]);
      result.current.setToolId("antigravity");
      result.current.setCwd("/project");
    });
    await waitFor(() =>
      expect(mocks.listModels).toHaveBeenCalledWith("antigravity", {
        cwd: "/project",
      }),
    );
    expect(result.current.modelId).toBe("model");
    mocks.listModels.mockResolvedValueOnce({
      error: "Upgrade Antigravity CLI to use this provider",
    });
    await act(async () => result.current.setCwd("/other-project"));
    await waitFor(() => expect(result.current.error).toContain("Upgrade Antigravity CLI"));
    expect(result.current.modelId).toBe("");
  });
  it("switches resource ownership without sending one server's settings to another server", async () => {
    const { result } = renderHook(() => useHubController(props));
    await act(async () => result.current.setTab("Memory & Skills"));
    await waitFor(() => expect(result.current.resources?.skills[0]?.path).toBe("/mac/skill"));
    await act(async () => result.current.setTarget("linux"));
    expect(result.current.resources?.skills[0]?.path).toBe("/linux/skill");
    await act(async () => {
      await result.current.saveOwnedResources({
        ...result.current.resources!,
        mcp: [],
      });
    });
    expect(calls("resources.save")[0]?.[0]).toBe("linux");
    expect(calls("resources.save")[0]?.[2].skills[0].path).toBe("/linux/skill");
    expect(
      result.current.resourceCatalog.find((item) => item.serverId === "mac")?.value?.revision,
    ).toBe(1);
    expect(result.current.resources?.revision).toBe(2);
  });
});

describe("native setup return navigation", () => {
  it("restores the same logical session, project, host and tool in a newly opened global Hub", async () => {
    const first = renderHook(() => useHubController(props));
    await act(async () => {
      first.result.current.setProject(project);
      first.result.current.setSession(session);
      first.result.current.setTarget("linux");
      first.result.current.setCwd("/remote/project");
      first.result.current.setTitle("Working name");
      first.result.current.setTab("Tools");
    });
    act(() => first.result.current.rememberSetupReturn("linux", "aider"));
    first.unmount();
    const next = renderHook(() =>
      useHubController({ ...props, host: { id: "linux" } } as HubProps),
    );
    await waitFor(() => expect(next.result.current.session?.id).toBe(session.id));
    expect(next.result.current.host.id).toBe("mac");
    expect(next.result.current.project?.id).toBe(project.id);
    expect(next.result.current.target).toBe("linux");
    expect(next.result.current.toolId).toBe("aider");
    expect(next.result.current.cwd).toBe("/remote/project");
    expect(next.result.current.title).toBe("Working name");
    expect(next.result.current.tab).toBe("Tools");
    expect(readSetupReturn("mac")).toBeNull();
    expect(calls("composition.create")).toHaveLength(0);
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it("does not overwrite a manual Clear selection with a delayed setup restore", async () => {
    saveSetupReturn("mac", {
      projectId: project.id,
      sessionId: session.id,
      target: "linux",
      toolId: "aider",
      cwd: "/remote/project",
      title: "A",
      tab: "Tools",
    });
    let resolveSession: ((value: CompositionSession) => void) | undefined;
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation((host, contract, input) =>
      contract.name === "composition.read"
        ? new Promise((resolve) => {
            resolveSession = resolve;
          })
        : original(host, contract, input),
    );
    const { result } = renderHook(() => useHubController(props));
    await waitFor(() => expect(resolveSession).toBeDefined());
    act(() => {
      result.current.setProject(null);
      result.current.setSession(null);
      result.current.setCwd("/manual-choice");
    });
    await act(async () => resolveSession!(session));
    expect(result.current.project).toBeNull();
    expect(result.current.session).toBeNull();
    expect(result.current.cwd).toBe("/manual-choice");
    expect(readSetupReturn("mac")).toBeNull();
  });

  it("keeps an explicit native conversation entry ahead of a saved setup bookmark", async () => {
    saveSetupReturn("mac", {
      projectId: project.id,
      sessionId: "saved-session",
      target: "linux",
      toolId: "aider",
      cwd: "/remote/project",
      title: "A",
      tab: "Tools",
    });
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation((host, contract, input) =>
      contract.name === "composition.list"
        ? Promise.resolve({
            projects: [project],
            sessions: [
              {
                ...session,
                id: "explicit-session",
                endpoints: [{ kind: "agent", serverId: "mac", agentId: "explicit-agent" }],
              },
            ],
            total: 1,
          })
        : original(host, contract, input),
    );
    const { result } = renderHook(() =>
      useHubController({ ...props, params: { agentId: "explicit-agent" } }),
    );
    await waitFor(() => expect(result.current.session?.id).toBe("explicit-session"));
    expect(calls("composition.read").map((call) => call[2].id)).not.toContain("saved-session");
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
});

it("waits for the catalog to reconnect before reading a setup return bookmark", async () => {
  saveSetupReturn("mac", {
    projectId: project.id,
    sessionId: session.id,
    target: "linux",
    toolId: "aider",
    cwd: "/remote/project",
    title: "A",
    tab: "Tools",
  });
  mocks.hosts[0]!.status = "offline";
  const { result, rerender } = renderHook(() => useHubController(props));
  await act(async () => undefined);
  expect(calls("composition.read")).toHaveLength(0);
  expect(result.current.session).toBeNull();
  expect(readSetupReturn("mac")).not.toBeNull();
  mocks.hosts[0]!.status = "online";
  rerender();
  await waitFor(() => expect(result.current.session?.id).toBe(session.id));
  expect(calls("composition.read")).toHaveLength(1);
  expect(readSetupReturn("mac")).toBeNull();
});

it("does not restore after Manual Clear while the catalog is offline", async () => {
  saveSetupReturn("mac", {
    projectId: project.id,
    sessionId: session.id,
    target: "linux",
    toolId: "aider",
    cwd: "/remote/project",
    title: "A",
    tab: "Tools",
  });
  mocks.hosts[0]!.status = "offline";
  const { result, rerender } = renderHook(() => useHubController(props));
  act(() => {
    result.current.setProject(null);
    result.current.setSession(null);
  });
  mocks.hosts[0]!.status = "online";
  rerender();
  await act(async () => undefined);
  expect(result.current.session).toBeNull();
  expect(calls("composition.read")).toHaveLength(0);
  expect(readSetupReturn("mac")).toBeNull();
});

it("allows Clear selection and fresh navigation after a corrupt setup bookmark", async () => {
  saveSetupReturn("mac", {
    projectId: project.id,
    sessionId: session.id,
    target: "linux",
    toolId: "aider",
    cwd: "/remote/project",
    title: "A",
    tab: "Tools",
  });
  localStorage.setItem(localStorage.key(0)!, "{invalid JSON");
  const { result } = renderHook(() => useHubController(props));
  await waitFor(() => expect(result.current.error).not.toBe(""));
  act(() => {
    result.current.setProject(null);
    result.current.setSession(null);
    result.current.setCwd("/fresh-selection");
    result.current.setTab("Tools");
  });
  expect(result.current.project).toBeNull();
  expect(result.current.session).toBeNull();
  expect(result.current.cwd).toBe("/fresh-selection");
  expect(result.current.tab).toBe("Tools");
  expect(readSetupReturn("mac")).toBeNull();
});

it("keeps ordinary navigation usable when browser storage is blocked", async () => {
  const blocked = vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
    throw new Error("Storage is blocked");
  });
  try {
    const { result } = renderHook(() => useHubController(props));
    await waitFor(() => expect(result.current.error).toBe("Storage is blocked"));
    act(() => {
      result.current.setProject(null);
      result.current.setSession(null);
      result.current.setTarget("linux");
      result.current.setCwd("/fresh-selection");
      result.current.setToolId("goose");
      result.current.setTab("Tools");
    });
    expect(result.current.target).toBe("linux");
    expect(result.current.cwd).toBe("/fresh-selection");
    expect(result.current.toolId).toBe("goose");
    expect(result.current.tab).toBe("Tools");
    expect(() => result.current.rememberSetupReturn("linux", "goose")).toThrow(
      "Storage is blocked",
    );
  } finally {
    blocked.mockRestore();
  }
});

it("honors the explicit source server from a right panel without linking until confirmation", async () => {
  const { result } = renderHook(() =>
    useHubController({
      ...props,
      params: { agentId: "native-remote", serverId: "linux", toolId: "goose", setup: "1" },
    }),
  );
  await waitFor(() => expect(result.current.setupTarget?.toolId).toBe("goose"));
  expect(result.current.entryChoice).toMatchObject({
    kind: "native",
    serverId: "linux",
    agent: { id: "native-remote" },
  });
  expect(result.current.target).toBe("linux");
  expect(result.current.session).toBeNull();
  expect(calls("composition.create")).toHaveLength(0);
  expect(mocks.createAgent).not.toHaveBeenCalled();
});
it("requests setup from the explicitly selected existing agent without creating another agent or steering it", async () => {
  const { result } = renderHook(() => useHubController(props));
  await act(async () => result.current.askSetup("linux", tool, { agentId: "chosen-agent" }));
  expect(mocks.clientHost).toHaveBeenCalledWith("linux");
  expect(mocks.createAgent).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledWith(expect.stringContaining("/remote/project"), {
    activeTurnBehavior: "reject",
  });
  expect(mocks.openAgent).toHaveBeenCalledWith({ serverId: "linux", agentId: "chosen-agent" });
});
it("rejects unavailable setup accounts clearly and does not dispatch a fallback provider", async () => {
  const { result } = renderHook(() => useHubController(props));
  await waitFor(() => expect(result.current.tools.length).toBeGreaterThan(0));
  mocks.listModels.mockClear();
  await expect(
    result.current.askSetup("linux", tool, { provider: "unavailable", cwd: "/remote/project" }),
  ).rejects.toThrow("Sign in");
  expect(mocks.listModels).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("does not restore an unrelated setup bookmark over a new tool panel", async () => {
  saveSetupReturn("mac", {
    projectId: project.id,
    sessionId: "old",
    target: "mac",
    toolId: "codex",
    cwd: "/old",
    title: "Old",
    tab: "Sessions",
  });
  const { result } = renderHook(() =>
    useHubController({
      ...props,
      params: { serverId: "linux", toolId: "goose", cwd: "/new", setup: "1" },
    }),
  );
  await waitFor(() => expect(result.current.setupTarget?.toolId).toBe("goose"));
  expect(result.current.cwd).toBe("/new");
  expect(result.current.target).toBe("linux");
  expect(calls("composition.read")).toHaveLength(0);
});

it("forks the logical context before opening an original terminal tool instead of silently continuing the parent", async () => {
  const { result } = renderHook(() => useHubController(props));
  await act(async () => {
    result.current.setProject(project);
    result.current.setSession(session);
    result.current.setCwd("/project");
  });
  await act(async () =>
    result.current.launch(
      "mac",
      { ...tool, id: "goose", nativeProvider: undefined, modes: ["terminal"] },
      "launch",
      "terminal",
      { fork: true },
    ),
  );
  expect(calls("composition.fork")).toHaveLength(1);
  expect(calls("tools.context")[0]?.[2].sessionId).toBe("fork");
  expect(calls("tools.prepare")[0]?.[2].sessionId).toBe("fork");
  expect(calls("composition.bind")[0]?.[2]).toMatchObject({
    id: "fork",
    endpoint: { kind: "terminal", agentId: "terminal" },
  });
  expect(mocks.createAgent).not.toHaveBeenCalled();
});

it("sends one batch setup input from validated server catalog entries and rejects unknown IDs before dispatch", async () => {
  const original = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((server, contract, input) =>
    contract.name === "tools.list"
      ? [
          tool,
          {
            ...tool,
            id: "agents",
            name: "Agent skills",
            sourceUrl: "https://example.com/original",
          },
        ]
      : original(server, contract, input),
  );
  const { result } = renderHook(() => useHubController(props));
  await waitFor(() => expect(result.current.tools).toHaveLength(4));
  await act(async () =>
    result.current.askSetup("linux", tool, { agentId: "setup-agent", tools: ["goose", "agents"] }),
  );
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0]?.[0]).toContain("1. Goose");
  expect(mocks.send.mock.calls[0]?.[0]).toContain("2. Agent skills");
  expect(mocks.send.mock.calls[0]?.[0]).toContain("https://example.com/original");
  expect(mocks.send.mock.calls[0]?.[0]).toContain("Never copy credentials between servers");
  expect(mocks.send.mock.calls[0]?.[1]).toEqual({ activeTurnBehavior: "reject" });
  await expect(
    result.current.askSetup("linux", tool, { agentId: "setup-agent", tools: ["missing"] }),
  ).rejects.toThrow("not in this server's catalog");
  await expect(
    result.current.askSetup("linux", tool, { agentId: "setup-agent", tools: ["goose", "goose"] }),
  ).rejects.toThrow("unique");
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
it("keeps a requested tool through deliberate linking of the current native conversation", async () => {
  const { result } = renderHook(() =>
    useHubController({
      ...props,
      params: { agentId: "native-remote", serverId: "linux", toolId: "goose", setup: "1" },
    }),
  );
  await waitFor(() => expect(result.current.entryChoice?.kind).toBe("native"));
  act(() => result.current.useSetupTool("linux", "goose"));
  expect(result.current.tab).toBe("Sessions");
  expect(calls("composition.create")).toHaveLength(0);
  const choice = result.current.entryChoice;
  if (choice?.kind !== "native") throw new Error("Missing current native conversation");
  await act(async () => result.current.attachNative(choice.serverId, choice.agent));
  expect(calls("composition.create")[0]?.[2]).toMatchObject({
    endpoint: { serverId: "linux", agentId: "native-remote" },
  });
  expect(result.current.session?.id).toBe("session");
  expect(result.current.toolId).toBe("goose");
  expect(result.current.tab).toBe("Tools");
  expect(result.current.cwd).toBe("/remote/project");
  expect(mocks.createAgent).not.toHaveBeenCalled();
});
it("does not restore an old panel destination after its linked-session read loses a selection race", async () => {
  let finish!: (value: CompositionSession) => void;
  const original = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((server, contract, input) => {
    if (contract.name === "composition.list")
      return {
        projects: [],
        total: 1,
        sessions: [
          {
            ...session,
            endpoints: [
              {
                id: "endpoint",
                serverId: "linux",
                agentId: "native-remote",
                provider: "codex",
                cwd: "/old",
              },
            ],
          },
        ],
      };
    if (contract.name === "composition.read" && input.id === "session")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return original(server, contract, input);
  });
  const { result } = renderHook(() =>
    useHubController({
      ...props,
      params: { agentId: "native-remote", serverId: "linux", toolId: "goose", setup: "1" },
    }),
  );
  await waitFor(() => expect(calls("composition.read")).toHaveLength(1));
  act(() => {
    result.current.setTarget("mac");
    result.current.setCwd("/new");
    result.current.setToolId("aider");
  });
  await act(async () => finish(session));
  expect(result.current.target).toBe("mac");
  expect(result.current.cwd).toBe("/new");
  expect(result.current.toolId).toBe("aider");
  expect(result.current.setupTarget).toBeNull();
  expect(result.current.session).toBeNull();
});

it("uses the server-owned setup folder for a new setup agent without a project path", async () => {
  const { result } = renderHook(() => useHubController(props));
  await waitFor(() => expect(result.current.tools.length).toBeGreaterThan(0));
  await act(async () =>
    result.current.askSetup("linux", tool, { provider: "codex", cwd: "", tools: ["codex"] }),
  );
  expect(calls("tools.setup.workspace")[0]?.[0]).toBe("linux");
  expect(mocks.createAgent).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: "/server-owned/setup" }),
  );
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0]?.[0]).toContain(
    "Prepare tools only; do not initialize Pullboard",
  );
  expect(mocks.send.mock.calls[0]?.[0]).toContain("folder mapping later");
  expect(mocks.send.mock.calls[0]?.[0]).not.toContain("Project: /server-owned/setup");
});
it("publishes a healthy host's tools while another catalog stalls, and retries only the failed owner", async () => {
  const original = mocks.rpc.getMockImplementation()!;
  let complete!: (tools: ToolEntry[]) => void;
  let slow = true;
  mocks.rpc.mockImplementation((server, contract, input) => {
    if (contract.name === "tools.list" && server === "mac" && slow)
      return new Promise((resolve) => {
        complete = resolve;
      });
    return original(server, contract, input);
  });
  const { result } = renderHook(() => useHubController(props));
  await waitFor(() =>
    expect(result.current.tools.some((item) => item.serverId === "linux")).toBe(true),
  );
  expect(result.current.tools.some((item) => item.serverId === "mac")).toBe(false);
  expect(result.current.loadingToolServers).toContain("mac");
  expect(result.current.busy).toBe(false);
  slow = false;
  await act(() => result.current.reloadTools("mac"));
  expect(result.current.tools.some((item) => item.serverId === "mac")).toBe(true);
  await act(async () => complete([{ ...tool, id: "obsolete" }]));
  expect(result.current.tools.some((item) => item.tool.id === "obsolete")).toBe(false);
  expect(result.current.loadingToolServers).not.toContain("mac");
});
it("clears a catalog failure after explicit refresh without setting global busy", async () => {
  const original = mocks.rpc.getMockImplementation()!;
  let failed = true;
  mocks.rpc.mockImplementation((server, contract, input) => {
    if (contract.name === "tools.list" && server === "mac" && failed)
      return Promise.reject(new Error("Temporary failure"));
    return original(server, contract, input);
  });
  const { result } = renderHook(() => useHubController(props));
  await waitFor(() => expect(result.current.toolCatalogErrors.mac).toBe("Temporary failure"));
  expect(result.current.tools.some((item) => item.serverId === "linux")).toBe(true);
  failed = false;
  await act(() => result.current.reloadTools());
  expect(result.current.toolCatalogErrors.mac).toBe("");
  expect(result.current.tools.some((item) => item.serverId === "mac")).toBe(true);
  expect(result.current.busy).toBe(false);
});

it("validates the chosen setup model, thinking and permission mode before creating native work", async () => {
  const { result } = renderHook(() => useHubController(props));
  await waitFor(() => expect(result.current.tools.length).toBeGreaterThan(0));
  mocks.listModels.mockResolvedValue({
    models: [
      { id: "chosen", label: "Chosen model", thinkingOptions: [{ id: "high", label: "High" }] },
    ],
  });
  await act(async () =>
    result.current.askSetup("linux", tool, {
      provider: "codex",
      cwd: "/remote/project",
      model: "chosen",
      thinkingOptionId: "high",
      modeId: "approval",
    }),
  );
  expect(mocks.createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      config: {
        provider: "codex/chosen",
        thinkingOptionId: "high",
        modeId: "approval",
      },
    }),
  );
  expect(mocks.listModes).toHaveBeenCalledWith("codex", { cwd: "/remote/project" });
  mocks.createAgent.mockClear();
  mocks.send.mockClear();
  await expect(
    result.current.askSetup("linux", tool, {
      provider: "codex",
      cwd: "/remote/project",
      model: "chosen",
      modeId: "gone",
    }),
  ).rejects.toThrow("permission mode is unavailable");
  await expect(
    result.current.askSetup("linux", tool, {
      provider: "codex",
      cwd: "/remote/project",
      model: "gone",
    }),
  ).rejects.toThrow("model is unavailable");
  await expect(
    result.current.askSetup("linux", tool, {
      agentId: "chosen-agent",
      model: "chosen",
    }),
  ).rejects.toThrow("keeps its current settings");
  expect(mocks.createAgent).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
