import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createFamiliarMessageHandler, familiarConfigSchema, type FamiliarConfig } from "./familiarBridge.js";
import type { DiscordMessageLike } from "./messageHandler.js";
let directory: string;
let config: FamiliarConfig;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "familiar-discord-"));
  config = familiarConfigSchema.parse({ cliPath: "/usr/local/bin/familiar", stateDirectory: directory, channels: { "100": { host: "ssh://server?daemonPort=6787", agentId: "native-agent", allowedUserIds: ["200"] } } });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function message(overrides: Partial<DiscordMessageLike> = {}): DiscordMessageLike {
  return { authorBot: false, userId: "200", channelId: "100", roleIds: [], messageId: "300", content: "inspect the shared workspace", reply: vi.fn(async () => {}), ...overrides };
}
it("requires explicit channel authorization and absolute private paths", async () => {
  expect(() => familiarConfigSchema.parse({ ...config, stateDirectory: "relative" })).toThrow();
  expect(() => familiarConfigSchema.parse({ ...config, channels: { "100": { host: "x", agentId: "x" } } })).toThrow();
  const run = vi.fn(); const handler = createFamiliarMessageHandler(config, run);
  await handler(message({ userId: "untrusted" }));
  await handler(message({ channelId: "unbound" }));
  await handler(message({ authorBot: true }));
  expect(run).not.toHaveBeenCalled();
});
it("keeps native identity and never executes a repeated Discord delivery twice", async () => {
  const inputs: unknown[] = [];
  const run = vi.fn(async (args: string[]) => {
    if (args[3] === "agent.send") inputs.push(JSON.parse(await readFile(args[5], "utf8")));
    return args[0] === "plugin" ? { result: args[3] === "agent.status" ? { status: "idle", recent: ["done"] } : { accepted: true } } : { status: "idle" };
  });
  const handler = createFamiliarMessageHandler(config, run); const item = message();
  await handler(item); await handler(item);
  expect(inputs).toEqual([{ agentId: "native-agent", text: item.content, messageId: "discord-300" }]);
  expect(JSON.parse(await readFile(path.join(directory, "receipts/300.json"), "utf8"))).toMatchObject({ state: "observed", delivery: "delivered" });
  expect(run.mock.calls.every(([args]) => args.includes("ssh://server?daemonPort=6787"))).toBe(true);
});
it("does not repeat an operation after a lost acknowledgement", async () => {
  const run = vi.fn(async () => { throw new Error("connection lost after dispatch"); });
  const handler = createFamiliarMessageHandler(config, run);
  await handler(message()); await handler(message());
  expect(run).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(path.join(directory, "receipts/300.json"), "utf8"))).toMatchObject({ state: "dispatching" });
});
it("retains pending delivery without re-executing the native prompt", async () => {
  const run = vi.fn(async (args: string[]) => args[0] === "plugin" ? { result: { status: "idle" } } : { status: "idle" });
  const handler = createFamiliarMessageHandler(config, run);
  await expect(handler(message({ reply: vi.fn(async () => { throw new Error("Discord unavailable"); }) }))).rejects.toThrow("Discord unavailable");
  expect(JSON.parse(await readFile(path.join(directory, "receipts/300.json"), "utf8"))).toMatchObject({ state: "observed", delivery: "pending" });
  await handler(message());
  expect(run.mock.calls.filter(([args]) => args[3] === "agent.send")).toHaveLength(1);
});
it("follows a logical session's current native endpoint without rebinding Discord", async () => {
  config = familiarConfigSchema.parse({ ...config, servers: { mac: "localhost:6786", linux: "ssh://linux?daemonPort=6787" }, channels: { "100": { host: "localhost:6786", sessionId: "logical-a", allowedUserIds: ["200"] } } });
  let server = "mac";
  const sends: { host: string; agentId: string }[] = [];
  const run = vi.fn(async (args: string[]) => {
    if (args[3] === "composition.read") return { result: { title: "A", activeEndpointId: "endpoint", endpoints: [{ id: "endpoint", kind: "agent", agentId: `native-${server}`, serverId: server, provider: "codex" }] } };
    if (args[3] === "agent.send") sends.push({ host: args[args.indexOf("--host") + 1], agentId: JSON.parse(await readFile(args[5], "utf8")).agentId });
    return args[0] === "plugin" ? { result: { status: "idle" } } : { status: "idle" };
  });
  const handler = createFamiliarMessageHandler(config, run);
  await handler(message()); server = "linux";
  await handler(message({ messageId: "301" }));
  expect(sends).toEqual([{ host: "localhost:6786", agentId: "native-mac" }, { host: "ssh://linux?daemonPort=6787", agentId: "native-linux" }]);
});
it("reads logical context and does not send native commands to terminal endpoints", async () => {
  config = familiarConfigSchema.parse({ ...config, channels: { "100": { host: "localhost:6786", sessionId: "logical-a", allowedUserIds: ["200"] } } });
  const run = vi.fn(async (args: string[]) => ({ result: args[3] === "composition.context" ? { memories: ["shared"] } : { title: "A", activeEndpointId: "terminal", endpoints: [{ id: "terminal", kind: "terminal", agentId: "terminal-id", serverId: "mac", provider: "aider" }] } }));
  const handler = createFamiliarMessageHandler(config, run);
  const context = message({ content: "!fa context" }); await handler(context);
  expect(context.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("shared") }));
  const terminal = message(); await handler(terminal);
  expect(terminal.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("aider (terminal)") }));
  expect(run.mock.calls.some(([args]) => args[3] === "agent.send")).toBe(false);
});
