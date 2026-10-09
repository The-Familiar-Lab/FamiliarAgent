import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi, PaseoAgentListResult } from "@getpaseo/client";
import { compositionSession, type CompositionEndpoint } from "../../shared/composition.js";
import { readCompositionActivity } from "../../shared/activity.js";
import { readSessionActivity } from "./activity.js";

afterEach(() => vi.useRealTimers());
function endpoint(
  kind: CompositionEndpoint["kind"],
  extra: Partial<CompositionEndpoint> = {},
): CompositionEndpoint {
  return {
    id: kind,
    kind,
    serverId: "mac",
    agentId: `native-${kind}`,
    provider: "codex",
    cwd: "/project",
    workspaceId: "workspace",
    createdAt: new Date(0).toISOString(),
    ...extra,
  };
}
function fixture(endpoints: CompositionEndpoint[]) {
  const session = compositionSession.parse({
    id: "session",
    projectId: "project",
    title: "Linked",
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
    memory: "PRIVATE_MEMORY",
    resources: [],
    endpoints,
    activeEndpointId: endpoints[0]?.id ?? null,
    parent: null,
  });
  const terminals = vi.fn(async () => ({
    entries: [
      {
        id: "native-terminal",
        cwd: "/project",
        workspaceId: "workspace",
        name: "PRIVATE_TERMINAL_TITLE",
      },
    ],
    requestId: "terminals",
  }));
  const agents = vi.fn(
    async () =>
      ({
        entries: [],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        requestId: "agents",
      }) as PaseoAgentListResult,
  );
  const paseo = { terminals: { list: terminals }, agents: { list: agents } } as unknown as PaseoApi;
  return {
    session,
    paseo,
    terminals,
    agents,
    input: { session, paseo, serverId: "mac", offset: 0, limit: 20 },
  };
}
describe("host-owned composition activity", () => {
  it("reports only local native process observations and never exposes stored URLs or text", async () => {
    const f = fixture([
      endpoint("terminal"),
      endpoint("terminal", { id: "foreign", serverId: "ubuntu", agentId: "native-terminal" }),
      endpoint("web", { url: "http://localhost:3210/?token=PRIVATE_TOKEN" }),
      endpoint("desktop"),
    ]);
    const activity = readCompositionActivity.output.parse(await readSessionActivity(f.input));
    expect(
      activity.endpoints.map((value) => [value.endpointId, value.state, value.readiness]),
    ).toEqual([
      ["terminal", "running", "unknown"],
      ["web", "external", "unknown"],
      ["desktop", "external", "unknown"],
    ]);
    expect(f.terminals).toHaveBeenCalledTimes(1);
    expect(f.agents).not.toHaveBeenCalled();
    expect(JSON.stringify(activity)).not.toContain("PRIVATE_");
  });
  it("marks a missing terminal closed rather than completed and a desktop launcher alive only starting", async () => {
    const f = fixture([
      endpoint("terminal", { agentId: "gone" }),
      endpoint("desktop", { agentId: "native-terminal" }),
    ]);
    const result = await readSessionActivity(f.input);
    expect(result.endpoints.map((value) => value.state)).toEqual(["closed", "starting"]);
    expect(result.endpoints[0]?.detail).toContain("does not confirm");
    expect(result.endpoints[1]?.readiness).toBe("unknown");
  });
  it("does not reuse a matching native ID belonging to another workspace", async () => {
    const f = fixture([endpoint("terminal", { workspaceId: "other" })]);
    expect((await readSessionActivity(f.input)).endpoints[0]?.state).toBe("unavailable");
  });
  it("returns healthy endpoints and durable runs when a native observation fails or times out", async () => {
    vi.useFakeTimers();
    const f = fixture([endpoint("terminal"), endpoint("web")]);
    f.terminals.mockImplementation(() => new Promise(() => {}));
    const runs = { listActivity: vi.fn(() => ({ runs: [], total: 9 })) };
    const task = readSessionActivity({ ...f.input, runs, timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(31);
    const result = await task;
    expect(result.endpoints.map((value) => value.state)).toEqual(["unavailable", "external"]);
    expect(result.totalRuns).toBe(9);
    expect(runs.listActivity).toHaveBeenCalledWith("session", 0, 20);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not enumerate native processes for remote-only and action-only endpoints", async () => {
    const f = fixture([endpoint("agent", { serverId: "ubuntu" }), endpoint("tool")]);
    const result = await readSessionActivity(f.input);
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toMatchObject({ source: "native-action", state: "external" });
    expect(f.agents).not.toHaveBeenCalled();
    expect(f.terminals).not.toHaveBeenCalled();
  });
  it.each([
    [{ status: "initializing" }, "starting"],
    [{ status: "idle" }, "idle"],
    [{ status: "running" }, "running"],
    [{ status: "running", attentionReason: "permission" }, "waiting"],
    [{ status: "error" }, "unavailable"],
    [{ status: "closed" }, "closed"],
    [{ status: "idle", archivedAt: "yesterday" }, "closed"],
  ])(
    "projects native agent metadata without initializing or reading history: %j",
    async (fields, expected) => {
      const f = fixture([endpoint("agent")]);
      f.agents.mockResolvedValue({
        entries: [
          {
            agent: {
              id: "native-agent",
              cwd: "/project",
              provider: "codex",
              pendingPermissions: [],
              ...fields,
            },
          },
        ],
        pageInfo: { hasMore: false },
      } as PaseoAgentListResult);
      expect((await readSessionActivity(f.input)).endpoints[0]?.state).toBe(expected);
      expect(f.agents).toHaveBeenCalledWith(
        expect.objectContaining({
          page: { limit: 200 },
          filter: { includeArchived: true },
          signal: expect.any(AbortSignal),
        }),
      );
    },
  );
  it("keeps absent entries unknown when the native directory page is incomplete", async () => {
    const f = fixture([endpoint("agent")]);
    f.agents.mockResolvedValue({
      entries: [],
      pageInfo: { hasMore: true },
    } as PaseoAgentListResult);
    const item = (await readSessionActivity(f.input)).endpoints[0];
    expect(item).toMatchObject({ state: "unavailable", readiness: "unknown" });
    expect(item?.detail).toContain("bounded");
  });
});
