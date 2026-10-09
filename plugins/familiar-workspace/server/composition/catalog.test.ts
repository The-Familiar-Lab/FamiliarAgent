import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { Server } from "node:http";
import type { HistoryStore } from "../history/store.js";
import { CompositionStore } from "./store.js";
import { BridgeRegistry, startReadOnlyBridge } from "./bridge.js";
import { registerComposition } from "./register.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), "familiar-linked-catalog-"));
  cleanups.push(() => rm(value, { recursive: true, force: true }));
  return value;
}

describe("per-session catalog connection", () => {
  it("lets an unconfigured destination read and update one real source session without copying its catalog", async () => {
    const source = new CompositionStore(await directory());
    cleanups.push(() => source.close());
    source.saveProject({
      id: "project",
      title: "Shared",
      memory: "Project decision",
      resources: [],
      expectedRevision: 0,
      operationId: "p",
    });
    const session = source.create({
      projectId: "project",
      title: "A",
      memory: "Original memory",
      operationId: "a",
    });
    const other = source.create({ projectId: "project", title: "Private", operationId: "b" });
    const token = randomBytes(32).toString("hex");
    const { server, port } = await startReadOnlyBridge({
      token,
      resources: new Set(),
      reader: async () => {
        throw new Error("No history scope");
      },
      sessions: new Map([[session.id, undefined]]),
      catalog: async (method, input) => {
        if (method === "composition.read") return source.read(String(input.id));
        if (method === "composition.context")
          return source.context(input as Parameters<CompositionStore["context"]>[0]);
        if (method === "composition.update")
          return source.update(input as Parameters<CompositionStore["update"]>[0]);
        throw new Error("Unexpected method");
      },
    });
    cleanups.push(() => close(server));
    const destination = await directory();
    const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
    const contracts = new Map<string, { input: { parse: (value: unknown) => unknown } }>();
    const plugin = {
      handle: (
        contract: { name: string; input: { parse: (value: unknown) => unknown } },
        handler: (input: unknown, context: unknown) => unknown,
      ) => {
        contracts.set(contract.name, contract);
        handlers.set(contract.name, handler);
      },
    } as unknown as PluginServerContext;
    cleanups.push(
      registerComposition(plugin, {
        directory: destination,
        home: destination,
        serverId: "fresh-ubuntu",
        cliPath: "/bin/sh",
        history: {} as HistoryStore,
        authority: async () => "",
      }),
    );
    const call = (method: string, input: unknown) =>
      Promise.resolve(handlers.get(method)!(contracts.get(method)!.input.parse(input), {}));
    await expect(call("composition.runtime", { sessionId: session.id })).rejects.toThrow(
      "not found",
    );
    await call("composition.bridge.install", {
      sourceServerId: "mac",
      targetServerId: "fresh-ubuntu",
      port,
      token,
      sessions: [session.id],
    });
    const runtime = (await call("composition.runtime", { sessionId: session.id })) as {
      mcpServers: { familiar_context: { args: string[] } };
    };
    expect(runtime.mcpServers.familiar_context.args).toContain(session.id);
    const context = (await call("composition.context", { id: session.id })) as {
      memories: unknown[];
    };
    expect(JSON.stringify(context.memories)).toContain("Original memory");
    const update = {
      id: session.id,
      title: "A",
      resources: [],
      memory: "Written on Ubuntu",
      expectedRevision: 1,
      operationId: "memory",
    };
    await expect(call("composition.update", { ...update, title: "Renamed" })).rejects.toThrow(
      "memory only",
    );
    await expect(call("composition.update", { ...update, memoryEnabled: false })).rejects.toThrow(
      "memory only",
    );
    await expect(
      call("composition.update", { ...update, disabledResourceIds: ["other-context"] }),
    ).rejects.toThrow("memory only");
    const advisor = (await call("composition.runtime", {
      sessionId: session.id,
      readOnly: true,
    })) as { mcpServers: { familiar_context: { args: string[] } } };
    expect(advisor.mcpServers.familiar_context.args).toContain("--read-only");
    await call("composition.update", update);
    expect(source.read(session.id).memory).toBe("Written on Ubuntu");
    await expect(call("composition.update", { ...update, operationId: "stale" })).rejects.toThrow(
      /revision/i,
    );
    expect(await call("composition.list", {})).toMatchObject({ sessions: [] });
    const request = (method: string, input: unknown) =>
      fetch(`http://127.0.0.1:${port}/catalog`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ method, input }),
      });
    expect((await request("composition.read", { id: other.id })).status).toBe(400);
    expect((await request("composition.bind", { id: session.id })).status).toBe(400);
    expect((await request("composition.read", { id: session.id, forwarded: true })).status).toBe(
      400,
    );
    expect((await request("composition.read", { id: session.id })).status).toBe(200);
  });

  it("uses a controller tunnel for an explicitly scoped third-host history and reports a disconnected source", async () => {
    const reference = {
      id: "history",
      kind: "history" as const,
      label: "History",
      serverId: "third-host",
      format: "native-timeline" as const,
      locator: "agent",
      readOnly: true,
    };
    const token = randomBytes(32).toString("hex");
    const { server, port } = await startReadOnlyBridge({
      token,
      resources: new Set([`${reference.serverId}\0${reference.format}\0${reference.locator}`]),
      reader: async () => ({
        messages: [{ role: "assistant", text: "Third host page" }],
        nextOffset: null,
      }),
    });
    const registry = new BridgeRegistry(await directory(), "fresh-ubuntu");
    await registry.install({
      sourceServerId: "mac",
      targetServerId: "fresh-ubuntu",
      token,
      port,
      resourceServerIds: ["third-host"],
    });
    const reader = await registry.reader(reference);
    expect(
      (await reader!(reference, { offset: 0, limit: 1, maxCharacters: 256 })).messages[0]?.text,
    ).toBe("Third host page");
    await close(server);
    await expect(reader!(reference, { offset: 0, limit: 1, maxCharacters: 256 })).rejects.toThrow(
      "offline",
    );
  });
});
