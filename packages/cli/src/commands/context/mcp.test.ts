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
) {
  const server = createCompositionMcp(invoke, defaultSession);
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
      "familiar_memory",
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
});
