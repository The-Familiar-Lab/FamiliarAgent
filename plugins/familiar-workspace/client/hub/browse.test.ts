import { beforeEach, expect, it, vi } from "vitest";
import type { HubController } from "./controller.js";
import {
  choiceKey,
  groupSessions,
  readSessionPreview,
  sessionRows,
  type SessionChoice,
} from "./browse.js";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), read: vi.fn(), owner: vi.fn() }));
vi.mock("../fleet.js", () => ({ hostRpc: (...args: unknown[]) => mocks.rpc(...args) }));
vi.mock("@getpaseo/plugin/client", () => ({
  getPaseoClient: (server: string) => {
    mocks.owner(server);
    return { agents: { ref: () => ({ timeline: { refetch: mocks.read } }) } };
  },
}));
const agent = {
  id: "same-id",
  title: "Same title",
  provider: "codex",
  model: "Model",
  cwd: "/project",
  status: "idle",
};
const native = { kind: "native", serverId: "linux", agent } as SessionChoice;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ entries: [], epoch: "epoch", gap: false });
});
it("groups identical native IDs and titles by server without merging unrelated folders", () => {
  const hub = {
    sessions: [
      {
        id: "logical",
        title: "Same title",
        projectId: "project",
        endpoints: [
          { id: "ep", serverId: "mac", agentId: "same-id", provider: "codex", cwd: "/project" },
        ],
        activeEndpointId: "ep",
      },
    ],
    projects: [{ id: "project", title: "App" }],
    fleet: ["mac", "linux"].map((id) => ({ server: { serverId: id, label: id }, agents: [agent] })),
    query: "",
    filter: "all",
    hostName: (id: string) => id,
  } as unknown as HubController;
  const rows = sessionRows(hub);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.key)).toEqual(["shared:logical", "native:linux:same-id"]);
  expect(groupSessions(rows, "project", hub.hostName)).toHaveLength(2);
  expect(groupSessions(rows, "server", hub.hostName).map((group) => group.label)).toEqual([
    "mac",
    "linux",
  ]);
  expect(sessionRows({ ...hub, filter: "linux" }).map((row) => row.key)).toEqual([
    choiceKey(native),
  ]);
  expect(sessionRows({ ...hub, query: "missing" })).toHaveLength(0);
});
it("reads only the chosen native server lazily, caps preview content and never writes catalog state", async () => {
  mocks.read.mockResolvedValue({
    epoch: "epoch",
    hasOlder: true,
    entries: [
      { seqEnd: 1, item: { type: "user_message", text: "question" } },
      { seqEnd: 2, item: { type: "tool_call", text: "private process" } },
      { seqEnd: 3, item: { type: "assistant_message", text: "a".repeat(16000) } },
    ],
  });
  const preview = await readSessionPreview("mac", native, new Set(["linux"]));
  expect(mocks.owner).toHaveBeenCalledWith("linux");
  expect(mocks.read).toHaveBeenCalledWith({
    direction: "tail",
    projection: "canonical",
    limit: 12,
  });
  expect(preview.messages.map((item) => item.role)).toEqual(["You", "Assistant"]);
  expect(preview.messages.reduce((size, item) => size + item.text.length, 0)).toBe(8000);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("displays offline metadata without connecting, and reports native history failures", async () => {
  expect((await readSessionPreview("mac", native, new Set())).note).toContain("offline");
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.read.mockResolvedValueOnce({ error: "Provider unavailable", entries: [] });
  await expect(readSessionPreview("mac", native, new Set(["linux"]))).rejects.toThrow(
    "Provider unavailable",
  );
});
it("shared previews perform only the read RPC and preserve non-agent identity", async () => {
  mocks.rpc.mockResolvedValue({
    title: "Original tool",
    activeEndpointId: "web",
    endpoints: [
      {
        id: "web",
        kind: "web",
        serverId: "linux",
        agentId: "native-web",
        provider: "codeg",
        cwd: "/remote",
      },
    ],
  });
  const preview = await readSessionPreview(
    "mac",
    { kind: "shared", id: "logical" },
    new Set(["linux"]),
  );
  expect(mocks.rpc.mock.calls.map((call) => call[1].name)).toEqual(["composition.read"]);
  expect(preview.note).toContain("original tool surface");
  expect(mocks.read).not.toHaveBeenCalled();
});
