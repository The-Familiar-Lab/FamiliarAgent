import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCompositionMcp } from "./mcp.js";

const clients: Client[] = [];
const servers: McpServer[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((item) => item.close()));
  await Promise.all(servers.splice(0).map((item) => item.close()));
});
async function connect(
  invoke: (method: string, input: Record<string, unknown>) => Promise<unknown>,
  defaultSession?: string,
  readOnly = false,
) {
  const server = createCompositionMcp(invoke, defaultSession, { readOnly });
  const client = new Client({ name: "test-agent", version: "1" });
  servers.push(server);
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
describe("FamiliarAgent context MCP", () => {
  it("uses shared contracts for context and resolves history through the execution host", async () => {
    const source = {
      id: "history",
      kind: "history",
      serverId: "mac",
      locator: "native",
      format: "native-timeline",
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ messages: [{ role: "user", text: "Hello" }] });
    const client = await connect(invoke, "logical-A");
    expect((await client.listTools()).tools.map((item) => item.name)).toEqual([
      "familiar_context",
      "familiar_history",
      "familiar_skill",
      "familiar_memory",
      "familiar_skills",
    ]);
    const result = await client.callTool({
      name: "familiar_history",
      arguments: { resourceId: "history", limit: 1 },
    });
    expect(result.isError).not.toBe(true);
    expect(invoke.mock.calls[0]).toEqual([
      "composition.resource.locate",
      { id: "logical-A", resourceId: "history" },
    ]);
    expect(invoke.mock.calls[1]).toEqual([
      "composition.source.read",
      {
        resource: {
          id: "history",
          kind: "history",
          serverId: "mac",
          locator: "native",
          format: "native-timeline",
        },
        offset: 0,
        limit: 1,
        maxCharacters: 16384,
      },
    ]);
  });
  it("preserves session resources and rejects missing IDs or stale writes visibly", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ title: "A", resources: [{ id: "keep" }] })
      .mockRejectedValueOnce(new Error("Revision conflict"));
    const client = await connect(invoke, "logical-A");
    const result = await client.callTool({
      name: "familiar_memory",
      arguments: { expectedRevision: 2, memory: "New decisions" },
    });
    expect(result.isError).toBe(true);
    expect(invoke.mock.calls[1][1]).toMatchObject({
      expectedRevision: 2,
      memory: "New decisions",
      title: "A",
      resources: [{ id: "keep" }],
    });
    const noDefault = await connect(vi.fn());
    expect((await noDefault.callTool({ name: "familiar_context", arguments: {} })).isError).toBe(
      true,
    );
  });
  it("reads skills without a logical session and forwards only the exact resource RPC fields", async () => {
    const invoke = vi.fn().mockResolvedValue({ revision: 0, skills: [], mcp: [] });
    const client = await connect(invoke);
    expect(
      (await client.callTool({ name: "familiar_skills", arguments: { action: "list" } })).isError,
    ).not.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("resources.list", {});
    await client.callTool({
      name: "familiar_skills",
      arguments: { action: "read", id: "review", maxCharacters: 256 },
    });
    expect(invoke).toHaveBeenLastCalledWith("resources.skill.read", {
      id: "review",
      maxCharacters: 256,
    });
  });
  it("requires a caller-observed revision for every write and never silently retries conflicts", async () => {
    const invoke = vi.fn().mockResolvedValue({ revision: 1 });
    const client = await connect(invoke);
    for (const action of ["add", "enable", "disable", "remove", "apply"]) {
      const result = await client.callTool({
        name: "familiar_skills",
        arguments: { action, id: "review", path: "/skills/review", toolId: "codex", cwd: "/repo" },
      });
      expect(result.isError).toBe(true);
    }
    expect(invoke).not.toHaveBeenCalled();
    await client.callTool({
      name: "familiar_skills",
      arguments: { action: "add", id: "review", path: "/skills/review", expectedRevision: 0 },
    });
    expect(invoke).toHaveBeenLastCalledWith("resources.use-skills", {
      expectedRevision: 0,
      skills: [{ id: "review", path: "/skills/review", enabled: true }],
    });
    invoke.mockClear().mockRejectedValue(new Error("Shared resources changed"));
    const conflict = await client.callTool({
      name: "familiar_skills",
      arguments: { action: "disable", id: "review", expectedRevision: 0 },
    });
    expect(conflict.isError).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("resources.skill.change", {
      expectedRevision: 0,
      id: "review",
      action: "disable",
    });
  });
  it("requires an explicit project and native tool for projection and preserves mapping action semantics", async () => {
    const invoke = vi.fn().mockResolvedValue({ revision: 2 });
    const client = await connect(invoke);
    expect(
      (
        await client.callTool({
          name: "familiar_skills",
          arguments: { action: "apply", expectedRevision: 2 },
        })
      ).isError,
    ).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    await client.callTool({
      name: "familiar_skills",
      arguments: { action: "apply", toolId: "cursor", cwd: "/chosen/repo", expectedRevision: 2 },
    });
    expect(invoke).toHaveBeenLastCalledWith("resources.project", {
      expectedRevision: 2,
      toolId: "cursor",
      cwd: "/chosen/repo",
    });
    for (const action of ["enable", "disable", "remove"]) {
      await client.callTool({
        name: "familiar_skills",
        arguments: { action, id: "review", expectedRevision: 2 },
      });
      expect(invoke).toHaveBeenLastCalledWith("resources.skill.change", {
        action,
        id: "review",
        expectedRevision: 2,
      });
    }
  });
});

it("advisor MCP exposes only reads and cannot change its source session", async () => {
  const invoke = vi.fn().mockResolvedValue({
    kind: "skill",
    id: "chosen",
    serverId: "remote",
    locator: "review",
    format: "path",
  });
  const client = await connect(invoke, "source", true);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "familiar_context",
    "familiar_history",
    "familiar_skill",
  ]);
  expect(
    (
      await client.callTool({
        name: "familiar_memory",
        arguments: { memory: "changed", expectedRevision: 1 },
      })
    ).isError,
  ).toBe(true);
  expect(
    (await client.callTool({ name: "familiar_context", arguments: { sessionId: "other" } }))
      .isError,
  ).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
  await client.callTool({
    name: "familiar_skill",
    arguments: { resourceId: "chosen", maxCharacters: 256 },
  });
  expect(invoke.mock.calls[0]).toEqual([
    "composition.resource.locate",
    { id: "source", resourceId: "chosen" },
  ]);
  expect(invoke.mock.calls[1]).toEqual([
    "composition.source.read",
    {
      resource: expect.objectContaining({ kind: "skill", serverId: "remote" }),
      offset: 0,
      limit: 1,
      maxCharacters: 256,
    },
  ]);
});
