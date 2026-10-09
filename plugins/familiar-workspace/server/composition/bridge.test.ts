import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { CompositionResource } from "../../shared/composition.js";
import { BridgeRegistry, startReadOnlyBridge, validateBridgeResources } from "./bridge.js";
import { ToolRunStore } from "../tool-actions/store.js";
import { captureToolResult, toolResultReader } from "../tool-actions/results.js";

const servers: Server[] = [];
const directories: string[] = [];
const stores: ToolRunStore[] = [];
const resource: CompositionResource = {
  id: "history",
  kind: "history",
  label: "History",
  serverId: "mac",
  format: "native-timeline",
  locator: "agent",
  readOnly: true,
};
const resourceKey = `${resource.serverId}\0${resource.format}\0${resource.locator}`;
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function completedToolResult() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "familiar-tool-bridge-"));
  directories.push(directory);
  const store = new ToolRunStore(directory, "mac");
  stores.push(store);
  store.create(
    "owned-run",
    {
      toolId: "agents",
      action: "inspect",
      cwd: directory,
      sessionId: "logical-A",
      input: "",
      parameters: {},
    },
    false,
  );
  store.finish("owned-run", "completed", { state: "completed", text: "chosen ".repeat(100) }, null);
  return { directory, store, captured: captureToolResult(store, "owned-run") };
}

describe("completed tool result return path", () => {
  it("grants bounded immutable results and rejects changed source metadata before sharing", async () => {
    const { store, captured } = await completedToolResult();
    const reference = captured.anchor.resource;
    const reader = toolResultReader(store);
    await expect(validateBridgeResources([reference], reader)).resolves.toBeUndefined();
    await expect(
      validateBridgeResources([{ ...reference, boundary: undefined }], reader),
    ).rejects.toThrow("immutable source boundary");
    await expect(
      validateBridgeResources([{ ...reference, readOnly: false }], reader),
    ).rejects.toThrow("immutable source boundary");
    for (const change of [
      { serverId: "other-server" },
      { boundary: { ...reference.boundary!, sessionId: "other-session" } },
      { boundary: { ...reference.boundary!, toolId: "other-tool" } },
      { boundary: { ...reference.boundary!, cwd: "/other-directory" } },
      { boundary: { ...reference.boundary!, sha256: "0".repeat(64) } },
    ])
      await expect(
        validateBridgeResources([{ ...reference, ...change } as CompositionResource], reader),
      ).rejects.toThrow("no longer matches");
    await expect(
      validateBridgeResources([{ ...reference, locator: "missing-run" }], reader),
    ).rejects.toThrow("not found");
    await expect(
      validateBridgeResources([{ ...reference, format: "path" }], reader),
    ).rejects.toThrow("Only native history");
    await expect(
      validateBridgeResources([reference], async () => ({
        messages: [],
        nextOffset: null,
      })),
    ).rejects.toThrow("owning source");
  });

  it("reads through the destination registry without copying results and rechecks every read", async () => {
    const { directory, store, captured } = await completedToolResult();
    const reference = captured.anchor.resource;
    const owner = toolResultReader(store);
    await validateBridgeResources([reference], owner);
    const token = randomBytes(32).toString("hex");
    const { server, port } = await startReadOnlyBridge({
      token,
      resources: new Set([`${reference.serverId}\0${reference.format}\0${reference.locator}`]),
      reader: owner,
    });
    servers.push(server);
    const registry = new BridgeRegistry(path.join(directory, "destination"), "ubuntu");
    await registry.install({
      sourceServerId: "mac",
      targetServerId: "ubuntu",
      token,
      port,
    });
    const read = (await registry.reader(reference))!;
    const page = { offset: 0, limit: 1, maxCharacters: 256 };
    const result = await read(reference, page);
    expect(result.messages).toEqual([{ role: "assistant", text: captured.text.slice(0, 256) }]);
    expect(result.truncated).toBe(true);
    expect(result.boundary).toEqual(reference.boundary);
    expect((await read(reference, { ...page, offset: 1 })).messages).toEqual([]);
    await expect(read({ ...reference, locator: "another-run" }, page)).rejects.toThrow("403");
    await expect(
      read(
        {
          ...reference,
          boundary: { ...reference.boundary!, sha256: "0".repeat(64) },
        } as CompositionResource,
        page,
      ),
    ).rejects.toThrow("no longer matches");
    store.finish("owned-run", "completed", { state: "completed", text: "rewritten" }, null);
    await expect(read(reference, page)).rejects.toThrow("no longer matches");
  });
});
describe("scoped history return path", () => {
  it("requires a secret and permits only registered history references", async () => {
    const token = randomBytes(32).toString("hex");
    const reader = vi.fn().mockResolvedValue({
      messages: [{ role: "user", text: "a".repeat(1024) }],
      nextOffset: null,
    });
    const { server, port } = await startReadOnlyBridge({
      token,
      resources: new Set([resourceKey]),
      reader,
    });
    servers.push(server);
    const call = (body: unknown, auth?: string) =>
      fetch(`http://127.0.0.1:${port}/history`, {
        method: "POST",
        headers: auth ? { authorization: `Bearer ${auth}` } : {},
        body: JSON.stringify(body),
      });
    expect((await call({ resource })).status).toBe(401);
    expect((await call({ resource }, "wrong")).status).toBe(401);
    expect(
      (await call({ resource: { ...resource, locator: "another-agent" } }, token)).status,
    ).toBe(403);
    expect((await call({ resource, maxCharacters: 128 }, token)).status).toBe(400);
    const good = await call({ resource, maxCharacters: 256 }, token);
    expect(good.status).toBe(200);
    const value = await good.json();
    expect(value.messages[0].text.length).toBe(256);
    expect(value.truncated).toBe(true);
    expect(reader).toHaveBeenCalledOnce();
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
  });

  it("keeps capabilities private and supports a real bounded HTTP source read", async () => {
    const token = randomBytes(32).toString("hex");
    const { server, port } = await startReadOnlyBridge({
      token,
      resources: new Set([resourceKey]),
      reader: async () => ({
        messages: [{ role: "assistant", text: "Lazy response" }],
        nextOffset: 40,
      }),
    });
    servers.push(server);
    const directory = await mkdtemp(path.join(os.tmpdir(), "familiar-bridge-"));
    directories.push(directory);
    const registry = new BridgeRegistry(directory, "ubuntu");
    expect(await registry.reader(resource)).toBeNull();
    await expect(
      registry.install({
        sourceServerId: "mac",
        targetServerId: "wrong",
        port,
        token,
      }),
    ).rejects.toThrow("different server");
    await registry.install({
      sourceServerId: "mac",
      targetServerId: "ubuntu",
      port,
      token,
    });
    const file = path.join(directory, (await readdir(directory))[0]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).token).toBe(token);
    const reader = await registry.reader(resource);
    const result = await reader!(resource, {
      offset: 0,
      limit: 1,
      maxCharacters: 256,
    });
    expect(result).toEqual({
      messages: [{ role: "assistant", text: "Lazy response" }],
      nextOffset: 40,
      truncated: false,
    });
  });

  it("rejects oversized requests before reading any native history", async () => {
    const token = randomBytes(32).toString("hex");
    const reader = vi.fn();
    const { server, port } = await startReadOnlyBridge({
      token,
      resources: new Set([resourceKey]),
      reader,
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${port}/history`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "x".repeat(40 * 1024),
    });
    expect(response.status).toBe(413);
    expect(reader).not.toHaveBeenCalled();
  });

  it("lets an existing destination reader consume a newly linked source after scope renewal", async () => {
    const token = randomBytes(32).toString("hex");
    const resources = new Set([resourceKey]);
    const linked = { ...resource, id: "new-history", locator: "new-mac-agent" };
    const { server, port } = await startReadOnlyBridge({
      token,
      resources,
      reader: async (source) => ({
        messages: [{ role: "assistant", text: source.locator }],
        nextOffset: null,
      }),
    });
    servers.push(server);
    const directory = await mkdtemp(path.join(os.tmpdir(), "familiar-bridge-renew-"));
    directories.push(directory);
    const registry = new BridgeRegistry(directory, "ubuntu");
    await registry.install({
      sourceServerId: "mac",
      targetServerId: "ubuntu",
      port,
      token,
    });
    const reader = (await registry.reader(linked))!;
    const page = { offset: 0, limit: 1, maxCharacters: 256 };
    await expect(reader(linked, page)).rejects.toThrow();

    resources.add(`${linked.serverId}\0${linked.format}\0${linked.locator}`);
    const result = await reader(linked, page);
    expect(result.messages).toEqual([{ role: "assistant", text: "new-mac-agent" }]);
    await expect(reader({ ...linked, locator: "unrelated-agent" }, page)).rejects.toThrow();
  });
});
