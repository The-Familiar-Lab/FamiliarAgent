import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), client: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({
  invokeHostRpc: mocks.invoke,
  getPaseoClient: mocks.client,
}));
import { z } from "zod";
import type { CompositionSession } from "../shared/composition.js";
import { boundedContext, connectContextSources, hostRpc, readFleet } from "./fleet.js";

describe("fleet boundary", () => {
  it("validates request and response on the selected host", async () => {
    const contract = {
      name: "read",
      input: z.object({ count: z.number().positive() }),
      output: z.object({ ok: z.boolean() }),
    };
    mocks.invoke.mockResolvedValueOnce({ ok: true });
    await expect(hostRpc("remote", contract, { count: 2 })).resolves.toEqual({
      ok: true,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith("remote", "read", {
      count: 2,
    });
    await expect(hostRpc("remote", contract, { count: -1 })).rejects.toThrow();
    mocks.invoke.mockResolvedValueOnce({ ok: "false" });
    await expect(hostRpc("remote", contract, { count: 1 })).rejects.toThrow();
  });
  it("keeps successful server results when another server is unavailable", async () => {
    mocks.client.mockImplementation((server: string) => {
      if (server === "broken") throw new Error("Disconnected during request");
      return {
        agents: {
          list: async () => ({
            entries: [{ agent: { id: "same-id", title: "Original" } }],
            pageInfo: { hasMore: false },
          }),
        },
        workspaces: {
          list: async () => ({ entries: [], pageInfo: { hasMore: true } }),
        },
      };
    });
    const result = await readFleet([
      { serverId: "good", label: "Mac", status: "online" },
      { serverId: "broken", label: "Linux", status: "online" },
      { serverId: "offline", label: "Offline", status: "offline" },
    ]);
    expect(result[0].agents[0].id).toBe("same-id");
    expect(result[0].hasMore).toBe(true);
    expect(result[1].error).toContain("Disconnected");
    expect(result[2].error).toBe("Disconnected");
    expect(mocks.client).not.toHaveBeenCalledWith("offline");
  });
  it("bounds UTF-8 context without splitting Korean or emoji characters", () => {
    const result = boundedContext("한글 🐱".repeat(10000), 2048);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(2048);
    expect(result).toContain("Working context truncated");
    expect(result).not.toContain("�");
    expect(boundedContext("Small context")).toBe("Small context");
  });
  it("prepares fresh destinations and the catalog owner through the local controller", async () => {
    let failedTarget: string | undefined;
    const history = {
      id: "history1",
      kind: "history",
      format: "native-timeline",
      label: "Original",
      serverId: "source",
      connection: "ssh://source",
      locator: "native1",
      readOnly: true,
      inheritedFrom: "session1",
    };
    mocks.invoke.mockReset().mockImplementation(async (_host, method, input) => {
      if (method === "composition.context")
        return {
          sessionId: "session1",
          revision: 1,
          project: {
            id: "project1",
            title: "Project",
            revision: 1,
            updatedAt: "now",
            resourceCount: 1,
            memoryCharacters: 0,
          },
          lineage: [],
          memories: [],
          resources: [history],
          truncated: false,
          continuation: "",
        };
      if (method === "settings.sharing.read")
        return {
          status: "ready",
          revision: "1",
          values: { authority: "ssh://owner/?daemonPort=6767" },
        };
      if (method === "composition.bridge.ensure") {
        if (input.targetServerId === failedTarget) throw new Error("SSH disconnected");
        return {
          sourceServerId: "mac",
          targetServerId: input.targetServerId,
          active: true,
          sharedReferences: 1,
          linkedSessions: 1,
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const hosts = [
      {
        serverId: "mac",
        label: "Mac",
        status: "online" as const,
        isLocal: true,
      },
      {
        serverId: "owner",
        label: "Catalog",
        status: "online" as const,
        connection: "ssh://owner",
      },
      {
        serverId: "destination",
        label: "Fresh server",
        status: "online" as const,
        connection: "ssh://destination",
      },
      {
        serverId: "source",
        label: "History",
        status: "online" as const,
        connection: "ssh://source",
      },
      {
        serverId: "previous",
        label: "Earlier endpoint",
        status: "online" as const,
        connection: "ssh://previous",
      },
      {
        serverId: "offline",
        label: "Offline",
        status: "offline" as const,
        connection: "ssh://offline",
      },
      {
        serverId: "tcp",
        label: "TCP",
        status: "online" as const,
        connection: "http://tcp",
      },
    ];
    const committed = {
      id: "session1",
      endpoints: ["previous", "previous", "destination", "owner", "offline"].map((serverId) => ({
        serverId,
      })),
    } as CompositionSession;
    await connectContextSources("mac", committed, hosts[2], hosts);
    const ensure = mocks.invoke.mock.calls.filter(
      (call) => call[1] === "composition.bridge.ensure",
    );
    expect(ensure).toHaveLength(3);
    for (const [host, , input] of ensure) {
      expect(host).toBe("mac");
      expect(input.sessions).toEqual(["session1"]);
      expect(input.catalogAuthority).toBe("ssh://owner/?daemonPort=6767");
      expect(input.resources[0].serverId).toBe("source");
      expect(input.resources[0]).not.toHaveProperty("inheritedFrom");
    }
    expect(ensure.map((call) => call[2].targetServerId)).toEqual([
      "destination",
      "owner",
      "previous",
    ]);

    // A failed old endpoint must not prevent renewing the others with the new exact source scope.
    mocks.invoke.mockClear();
    failedTarget = "owner";
    await expect(connectContextSources("mac", committed, undefined, hosts)).rejects.toThrow(
      "Reconnect the affected servers and reopen this session",
    );
    const retriedTargets = mocks.invoke.mock.calls
      .filter((call) => call[1] === "composition.bridge.ensure")
      .map((call) => call[2].targetServerId);
    expect(retriedTargets).toEqual(["owner", "destination", "previous"]);

    // A requested TCP destination cannot silently skip the bridge it needs, but other
    // already-linked endpoints still receive the newly committed source scope.
    mocks.invoke.mockClear();
    failedTarget = undefined;
    await expect(connectContextSources("mac", committed, hosts[6], hosts)).rejects.toThrow(
      "TCP: Select an SSH connection for this server to share across servers.",
    );
    expect(
      mocks.invoke.mock.calls
        .filter((call) => call[1] === "composition.bridge.ensure")
        .map((call) => call[2].targetServerId),
    ).toEqual(["owner", "destination", "previous"]);
  });
});
