// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHubController, type HubProps } from "./controller.js";
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
  refreshAgent: vi.fn(),
  clientHost: vi.fn(),
  connectSources: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useHosts: () => mocks.hosts,
  openExternalUrl: vi.fn(),
  getPaseoClient: (serverId: string) => {
    mocks.clientHost(serverId);
    return {
      providers: { listModels: mocks.listModels },
      agents: {
        create: mocks.createAgent,
        ref: () => ({ refresh: mocks.refreshAgent }),
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
  mocks.openWorkspace.mockResolvedValue({ id: "workspace" });
  mocks.createTerminal.mockResolvedValue({ id: "terminal" });
  mocks.createAgent.mockResolvedValue({
    id: "new-agent",
    cwd: "/worktrees/fork",
  });
  mocks.rpc.mockImplementation(
    async (serverId: string, contract: { name: string }, input: Record<string, unknown>) => {
      switch (contract.name) {
        case "composition.list":
          return { projects: [], sessions: [], total: 0 };
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
    await waitFor(() => expect(result.current.session?.id).toBe("session"));
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
