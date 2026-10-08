import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { CompositionResource } from "../../shared/composition.js";
import { BridgeRegistry, startReadOnlyBridge } from "./bridge.js";

const servers: Server[] = [];
const directories: string[] = [];
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
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
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
      registry.install({ sourceServerId: "mac", targetServerId: "wrong", port, token }),
    ).rejects.toThrow("different server");
    await registry.install({ sourceServerId: "mac", targetServerId: "ubuntu", port, token });
    const file = path.join(directory, (await readdir(directory))[0]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).token).toBe(token);
    const reader = await registry.reader(resource);
    const result = await reader!(resource, { offset: 0, limit: 1, maxCharacters: 256 });
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
    await registry.install({ sourceServerId: "mac", targetServerId: "ubuntu", port, token });
    const reader = (await registry.reader(linked))!;
    const page = { offset: 0, limit: 1, maxCharacters: 256 };
    await expect(reader(linked, page)).rejects.toThrow();

    resources.add(`${linked.serverId}\0${linked.format}\0${linked.locator}`);
    const result = await reader(linked, page);
    expect(result.messages).toEqual([{ role: "assistant", text: "new-mac-agent" }]);
    await expect(reader({ ...linked, locator: "unrelated-agent" }, page)).rejects.toThrow();
  });
});
