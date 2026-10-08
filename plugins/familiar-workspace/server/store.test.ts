import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "./store.js";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "familiar-store-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
describe("shared authority", () => {
  it("persists revisions across restarts", async () => {
    const store = new WorkspaceStore(directory);
    const original = await store.read("프로젝트 A");
    const saved = await store.save({
      ...original,
      notes: "Cross-tool context",
      mappings: [{ machine: "linux", path: "/srv/project" }],
    });
    expect(saved.revision).toBe(1);
    expect(await new WorkspaceStore(directory).read(original.id)).toEqual(saved);
    expect((await store.list()).map((item) => item.id)).toEqual([original.id]);
  });
  it("rejects concurrent stale writes without losing the accepted revision", async () => {
    const store = new WorkspaceStore(directory);
    const original = await store.read("shared");
    const results = await Promise.allSettled([
      store.save({ ...original, notes: "first" }),
      store.save({ ...original, notes: "second" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await store.read("shared")).notes).toBe("first");
    const next = await store.read("shared");
    expect((await store.save({ ...next, notes: "recovered" })).revision).toBe(2);
  });
  it("rejects path traversal, unsafe tool URLs and oversized context", async () => {
    const store = new WorkspaceStore(directory);
    await expect(store.read("../../outside")).rejects.toThrow();
    const original = await store.read("safe");
    expect(() =>
      store.save({ ...original, tools: [{ name: "bad", url: "file:///etc/passwd" }] }),
    ).toThrow();
    expect(() => store.save({ ...original, notes: "x".repeat(128 * 1024 + 1) })).toThrow();
  });
});
