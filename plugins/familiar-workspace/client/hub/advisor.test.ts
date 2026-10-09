import { beforeEach, expect, it, vi } from "vitest";
import { askFamiliar, advisorCatalog } from "./advisor.js";
import type { HubController } from "./controller.js";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  create: vi.fn(),
  models: vi.fn(),
  send: vi.fn(),
  open: vi.fn(),
  connect: vi.fn(),
  preview: vi.fn(),
  host: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  getPaseoClient: (serverId: string) => {
    mocks.host(serverId);
    return {
      agents: { create: mocks.create, ref: () => ({ refresh: mocks.refresh }) },
      providers: { listModels: mocks.models },
    };
  },
}));
vi.mock("../fleet.js", () => ({
  hostRpc: (...args: unknown[]) => mocks.rpc(...args),
  connectContextSources: (...args: unknown[]) => mocks.connect(...args),
  operationId: () => "unique-operation",
}));
vi.mock("./browse.js", () => ({
  readSessionPreview: (...args: unknown[]) => mocks.preview(...args),
}));
const hosts = [
  { serverId: "mac", label: "Mac", status: "online" },
  { serverId: "linux", label: "Linux", status: "online" },
];
function controller() {
  return {
    host: { id: "mac" },
    hosts,
    online: hosts,
    hostName: (id: string) => id,
    target: "mac",
    cwd: "/source",
    project: { resources: [] },
    session: { id: "A", revision: 3, endpoints: [] },
    tools: [
      {
        serverId: "linux",
        tool: {
          id: "claude",
          name: "Claude",
          nativeProvider: "claude",
          description: "Original agent",
          modes: ["native"],
          installed: true,
        },
      },
    ],
    navigation: { openAgent: mocks.open },
  } as unknown as HubController;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.models.mockResolvedValue({ models: [{ id: "supported", isDefault: true }], error: null });
  mocks.preview.mockResolvedValue({
    messages: [{ role: "You", text: "Bounded source" }],
    note: "Recent preview",
  });
  mocks.create.mockResolvedValue({ id: "advisor", send: mocks.send });
  mocks.rpc.mockImplementation(async (_server, contract) => {
    if (contract.name === "tools.setup.workspace") return { cwd: "/private/setup" };
    if (contract.name === "composition.runtime")
      return {
        mcpServers: { familiar: { command: "familiar", args: ["context", "mcp", "--read-only"] } },
      };
    if (contract.name === "composition.context") return { continuation: "Shared context" };
    throw new Error(`Unexpected mutation or read: ${contract.name}`);
  });
});
it("opens a separate native advisor on the chosen host with bounded context and read-only MCP, leaving A unchanged", async () => {
  const hub = controller();
  const before = JSON.stringify(hub.session);
  const result = await askFamiliar(hub, {
    serverId: "linux",
    provider: "claude",
    question: "Which tool?",
  });
  expect(result).toMatchObject({
    serverId: "linux",
    agentId: "advisor",
    delivery: { state: "accepted" },
  });
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.host).toHaveBeenCalledWith("linux");
  expect(mocks.rpc).toHaveBeenCalledWith(
    "linux",
    expect.objectContaining({ name: "composition.runtime" }),
    { sessionId: "A", readOnly: true },
  );
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: "/private/setup",
      title: "Ask Familiar",
      config: expect.objectContaining({
        provider: "claude/supported",
        systemPrompt: expect.stringContaining("Bounded source"),
        mcpServers: expect.any(Object),
      }),
      labels: { familiarAdvisor: "true", familiarAdvisorSource: "A" },
    }),
  );
  expect(mocks.create.mock.calls[0]?.[0].config.systemPrompt).toContain("Shared context");
  expect(mocks.create.mock.calls[0]?.[0].config.systemPrompt).toContain('"id":"claude"');
  expect(mocks.send).toHaveBeenCalledWith("Which tool?", {
    messageId: "unique-operation",
    activeTurnBehavior: "reject",
  });
  expect(JSON.stringify(hub.session)).toBe(before);
  expect(
    mocks.rpc.mock.calls.some(([, contract]) =>
      /composition\.(bind|create|update)/u.test(contract.name),
    ),
  ).toBe(false);
});
it("uses an unlinked current native preview without linking or copying the full conversation", async () => {
  const hub = {
    ...controller(),
    session: null,
    entryChoice: { kind: "native", serverId: "mac", agent: { id: "original" } },
  } as unknown as HubController;
  await askFamiliar(hub, { serverId: "linux", provider: "claude", question: "Explain options" });
  expect(mocks.preview).toHaveBeenCalledWith("mac", hub.entryChoice, new Set(["mac", "linux"]));
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(
    mocks.rpc.mock.calls.every(([, contract]) => contract.name === "tools.setup.workspace"),
  ).toBe(true);
  expect(mocks.create.mock.calls[0]?.[0].config.mcpServers).toBeUndefined();
  expect(mocks.create.mock.calls[0]?.[0].config.systemPrompt).toContain('"agentId":"original"');
});
it("stops on stale source reads and never retries an ambiguous native send", async () => {
  mocks.preview.mockRejectedValueOnce(new Error("Stale source"));
  await expect(
    askFamiliar(controller(), { serverId: "linux", provider: "claude", question: "Help" }),
  ).rejects.toThrow("Stale source");
  expect(mocks.create).not.toHaveBeenCalled();
  mocks.send.mockRejectedValueOnce(new Error("Connection lost"));
  const created = vi.fn();
  const result = await askFamiliar(
    controller(),
    { serverId: "linux", provider: "claude", question: "Help" },
    created,
  );
  expect(created).toHaveBeenCalledWith({ serverId: "linux", agentId: "advisor" });
  expect(result.delivery).toMatchObject({ state: "unknown", error: "Connection lost" });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it("bounds the tool catalog and does not expose runtime commands or credential settings", () => {
  const hub = controller();
  hub.tools = Array.from({ length: 200 }, (_, index) => ({
    serverId: "linux",
    tool: {
      ...hub.tools[0]!.tool,
      id: `tool${index}`,
      description: "Purpose ".repeat(300),
      launch: { command: "SECRET-COMMAND", args: ["PRIVATE-TOKEN"] },
    },
  }));
  const text = advisorCatalog(hub);
  expect(text.length).toBeLessThan(16200);
  expect(text).toContain("omitted");
  expect(text).not.toContain("SECRET-COMMAND");
  expect(text).not.toContain("PRIVATE-TOKEN");
});

it("uses the visible native origin rather than another selected session's active endpoint", async () => {
  mocks.refresh.mockResolvedValue({
    agent: { id: "visible", title: "Visible", provider: "codex", cwd: "/original" },
  });
  const hub = controller();
  await askFamiliar(hub, {
    serverId: "linux",
    provider: "claude",
    question: "Help with this",
    origin: { serverId: "mac", agentId: "visible" },
  });
  expect(mocks.preview).toHaveBeenCalledWith(
    "mac",
    expect.objectContaining({
      kind: "native",
      serverId: "mac",
      agent: expect.objectContaining({ id: "visible" }),
    }),
    expect.any(Set),
  );
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.create.mock.calls[0]?.[0].config.mcpServers).toBeUndefined();
  expect(mocks.open).not.toHaveBeenCalled();
});
