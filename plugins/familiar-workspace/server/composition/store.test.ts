import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compositionContext,
  listComposition,
  type CompositionResource,
} from "../../shared/composition.js";
import { CompositionStore, MAX_COMPOSITION_ANCESTRY } from "./store.js";

let directory: string;
let store: CompositionStore;
const resource: CompositionResource = {
  id: "history-one",
  kind: "history",
  label: "Original conversation",
  serverId: "ubuntu",
  format: "imported-history",
  locator: "a".repeat(64),
  readOnly: true,
};
const endpoint = { serverId: "mac", provider: "codex", agentId: "native-one", cwd: "/tmp/project" };
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "familiar-composition-"));
  store = new CompositionStore(directory);
  store.saveProject({
    operationId: "project-create",
    id: "project",
    title: "Project",
    expectedRevision: 0,
    memory: "Shared decisions",
    resources: [],
  });
});
afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
});

describe("logical session composition", () => {
  it("binds terminal and web endpoints without inventing native agent histories", () => {
    const first = store.create({
      operationId: "terminal",
      projectId: "project",
      title: "A",
      endpoint: { ...endpoint, kind: "terminal", workspaceId: "workspace" },
    });
    expect(first.resources).toEqual([]);
    const web = store.bind({
      operationId: "web",
      id: first.id,
      expectedRevision: 1,
      endpoint: { ...endpoint, kind: "web", url: "http://localhost:7434" },
    });
    expect(web.endpoints.map((item) => item.kind)).toEqual(["terminal", "web"]);
    expect(web.resources).toEqual([]);
  });
  it("pins native history cursors on forks without copying transcripts or changing replay IDs", () => {
    const source = store.create({
      operationId: "native",
      projectId: "project",
      title: "A",
      endpoint,
    });
    const reference = source.resources[0];
    const input = { operationId: "fork", id: source.id, expectedRevision: 1, title: "B" };
    const fork = store.fork(input, { [reference.id]: { kind: "native", epoch: "first", seq: 55 } });
    expect(store.context({ id: fork.id }).resources[0].boundary).toEqual({
      kind: "native",
      epoch: "first",
      seq: 55,
    });
    expect(store.read(source.id).resources[0].boundary).toBeUndefined();
    expect(store.replayFork(input)).toEqual(fork);
    expect(
      store.fork(input, { [reference.id]: { kind: "native", epoch: "first", seq: 60 } }),
    ).toEqual(fork);
    const child = store.fork({
      operationId: "fork-child",
      id: fork.id,
      expectedRevision: 1,
      title: "C",
    });
    expect(store.context({ id: child.id }).resources[0].boundary?.kind).toBe("native");
    expect(store.forkReferences({ ...input, operationId: "ref", id: fork.id })[0].boundary).toEqual(
      { kind: "native", epoch: "first", seq: 55 },
    );
  });
  it("switches native endpoints while keeping logical identity and durable immutable revisions", () => {
    const first = store.create({
      operationId: "create",
      title: "A",
      projectId: "project",
      endpoint,
    });
    const switched = store.bind({
      operationId: "switch",
      id: first.id,
      expectedRevision: 1,
      endpoint: { ...endpoint, serverId: "ubuntu", provider: "claude", agentId: "native-two" },
    });
    expect(switched.id).toBe(first.id);
    expect(switched.endpoints).toHaveLength(2);
    expect(switched.resources.map((item) => item.locator)).toEqual(["native-one", "native-two"]);
    expect(store.read(first.id, 1).endpoints).toHaveLength(1);
    store.close();
    store = new CompositionStore(directory);
    expect(store.read(first.id)).toEqual(switched);
    const result = listComposition.output.parse(store.list({}));
    expect(result.sessions[0]).not.toHaveProperty("memory");
    expect(result.sessions[0]).not.toHaveProperty("resources");
  });

  it("forks by frozen parent reference and applies shared-kind boundaries through ancestors", () => {
    const root = store.create({
      operationId: "root",
      title: "A",
      projectId: "project",
      memory: "Original decisions",
      resources: [resource, { ...resource, id: "skill", kind: "skill", locator: "/skills/review" }],
    });
    const branch = store.fork({
      operationId: "branch",
      id: root.id,
      expectedRevision: 1,
      title: "B",
      shareKinds: ["history"],
      shareMemory: false,
    });
    expect(branch.memory).toBe("");
    expect(branch.resources).toEqual([]);
    expect(branch.parent).toMatchObject({ sessionId: root.id, revision: 1 });
    store.update({
      operationId: "edit-root",
      id: root.id,
      expectedRevision: 1,
      title: "A",
      memory: "Changed later",
      resources: [],
    });
    const context = compositionContext.parse(store.context({ id: branch.id }));
    expect(context.resources.map((item) => item.id)).toEqual(["history-one"]);
    expect(context.memories.map((item) => item.text)).toEqual(["Shared decisions"]);
    const child = store.fork({
      operationId: "child",
      id: branch.id,
      expectedRevision: 1,
      title: "C",
    });
    expect(store.context({ id: child.id }).resources.map((item) => item.id)).toEqual([
      "history-one",
    ]);
    expect(JSON.stringify(branch).length).toBeLessThan(1000);
  });

  it("keeps project resources live while session fork memory is pinned", () => {
    const source = store.create({
      operationId: "create",
      title: "A",
      projectId: "project",
      memory: "Checkpoint",
    });
    const branch = store.fork({
      operationId: "fork",
      id: source.id,
      expectedRevision: 1,
      title: "B",
    });
    store.saveProject({
      operationId: "project-change",
      id: "project",
      title: "Project",
      expectedRevision: 1,
      memory: "Updated shared decisions",
      resources: [resource],
    });
    expect(store.context({ id: branch.id }).memories.map((item) => item.text)).toEqual([
      "Checkpoint",
      "Updated shared decisions",
    ]);
  });

  it("rejects stale writes and changed operation IDs, and retries without duplicate sessions", () => {
    const input = { operationId: "create", title: "A", projectId: "project" };
    const first = store.create(input);
    expect(store.create({ ...input, forwarded: true })).toEqual(first);
    expect(() => store.create({ ...input, title: "Different" })).toThrow("different request");
    store.update({
      operationId: "change",
      id: first.id,
      expectedRevision: 1,
      title: "A",
      memory: "accepted",
      resources: [],
    });
    expect(() =>
      store.update({
        operationId: "stale",
        id: first.id,
        expectedRevision: 1,
        title: "A",
        memory: "lost",
        resources: [],
      }),
    ).toThrow("Revision conflict");
    expect(store.read(first.id).memory).toBe("accepted");
    expect(store.list({}).total).toBe(1);
  });

  it("resolves context with a strict text budget and fetches referenced history only on request", async () => {
    const session = store.create({
      operationId: "create",
      title: "A",
      projectId: "project",
      memory: "x".repeat(5000),
      resources: [resource],
    });
    const context = store.context({ id: session.id, maxCharacters: 256 });
    expect(context.continuation.length).toBeLessThanOrEqual(256);
    expect(context.memories.map((item) => item.text).join("").length).toBe(256);
    expect(context.truncated).toBe(true);
    const reader = vi.fn().mockResolvedValue({
      messages: [
        { role: "user", text: "a".repeat(400) },
        { role: "assistant", text: "b" },
      ],
      nextOffset: null,
    });
    const page = await store.readResource(
      { id: session.id, resourceId: resource.id, maxCharacters: 256 },
      reader,
    );
    expect(reader).toHaveBeenCalledOnce();
    expect(reader.mock.calls[0][0].locator).toBe(resource.locator);
    expect(page.messages[0].text.length).toBe(256);
    expect(page.truncated).toBe(true);
    await expect(
      store.readResource({ id: session.id, resourceId: "not-shared" }, reader),
    ).rejects.toThrow("not shared");
    expect(reader).toHaveBeenCalledOnce();
  });

  it("bounds lineage depth and rolls back failures without retaining an operation ID", () => {
    let current = store.create({ operationId: "root", title: "Root", projectId: "project" });
    for (let i = 1; i < MAX_COMPOSITION_ANCESTRY; i++)
      current = store.fork({
        operationId: `fork-${i}`,
        id: current.id,
        expectedRevision: 1,
        title: `Fork ${i}`,
      });
    expect(() =>
      store.fork({
        operationId: "too-deep",
        id: current.id,
        expectedRevision: 1,
        title: "Too deep",
      }),
    ).toThrow("lineage exceeds");
    expect(
      store.create({ operationId: "too-deep", title: "Fresh", projectId: "project" }).parent,
    ).toBeNull();
  });

  it("handles two store instances with revision conflicts and escaped search characters", () => {
    const second = new CompositionStore(directory);
    try {
      const first = store.create({
        operationId: "create",
        title: "100%_done",
        projectId: "project",
      });
      second.update({
        operationId: "change",
        id: first.id,
        expectedRevision: 1,
        title: first.title,
        memory: "second writer",
        resources: [],
      });
      expect(() =>
        store.bind({ operationId: "stale-bind", id: first.id, expectedRevision: 1, endpoint }),
      ).toThrow("Revision conflict");
      expect(store.list({ query: "%_" }).total).toBe(1);
      expect(store.list({ query: "absent" }).total).toBe(0);
    } finally {
      second.close();
    }
  });
});
