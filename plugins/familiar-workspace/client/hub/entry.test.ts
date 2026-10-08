import { describe, expect, it, vi } from "vitest";
import type { infer as Infer } from "zod";
import type { compositionSessionSummary } from "../../shared/composition.js";
import { findNativeSession } from "./entry.js";
function summary(id: string, serverId = "other"): Infer<typeof compositionSessionSummary> {
  return {
    id,
    projectId: "project",
    title: id,
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
    endpoints: [
      {
        id: "endpoint",
        kind: "agent",
        serverId,
        agentId: "native-id",
        provider: "codex",
        cwd: "/project",
        createdAt: "now",
      },
    ],
    activeEndpointId: "endpoint",
    parent: null,
    resourceCount: 0,
    memoryCharacters: 0,
  };
}
describe("native conversation entry", () => {
  it("finds older logical sessions across summary pages without confusing the same agent ID on another server", async () => {
    const first = Array.from({ length: 100 }, (_, index) => summary(String(index)));
    const expected = summary("correct", "mac");
    const list = vi.fn(async ({ offset }: { offset?: number }) => ({
      projects: [],
      sessions: offset === 0 ? first : [expected],
      total: 101,
    }));
    await expect(findNativeSession("mac", "native-id", list)).resolves.toEqual(expected);
    expect(list.mock.calls).toEqual([[{ offset: 0, limit: 100 }], [{ offset: 100, limit: 100 }]]);
  });
  it("stops when the catalog changes to an empty page, and propagates connection errors", async () => {
    const list = vi.fn(async () => ({ projects: [], sessions: [], total: 1000 }));
    await expect(findNativeSession("mac", "missing", list)).resolves.toBeNull();
    expect(list).toHaveBeenCalledOnce();
    await expect(
      findNativeSession("mac", "missing", async () => {
        throw new Error("Offline");
      }),
    ).rejects.toThrow("Offline");
  });
});
