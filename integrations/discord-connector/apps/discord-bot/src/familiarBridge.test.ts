import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createFamiliarMessageHandler, createFamiliarCommandRunner, familiarConfigSchema, type FamiliarConfig } from "./familiarBridge.js";
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
it("executes an original tool in the logical session using saved settings and deduplicates Discord retries", async () => {
  config = familiarConfigSchema.parse({ ...config, servers: { linux: "ssh://linux?daemonPort=6787" }, channels: { "100": { host: "localhost:6786", sessionId: "logical-a", allowedUserIds: ["200"] } } });
  const requests: unknown[] = [];
  const run = vi.fn(async (args: string[]) => {
    if (args[3] === "composition.read") return { result: { title: "A", activeEndpointId: "tool", endpoints: [{ id: "tool", kind: "tool", agentId: "tool-endpoint", serverId: "linux", provider: "goose", cwd: "/project" }] } };
    if (args[3] === "tools.action-settings.read") return { result: { parameters: { provider: "claude-code" } } };
    if (args[3] === "tools.run.start") { requests.push(JSON.parse(await readFile(args[5], "utf8"))); return { result: { state: "running" } }; }
    throw new Error("Unexpected command");
  });
  const handler = createFamiliarMessageHandler(config, run);
  const item = message({ content: "!fa run goose resume @native-session Continue the previous task" });
  await handler(item); await handler(item);
  expect(requests).toEqual([{ operationId: "discord-300", sessionId: "logical-a", toolId: "goose", action: "resume", cwd: "/project", nativeId: "native-session", input: "Continue the previous task", parameters: { provider: "claude-code" } }]);
  expect(item.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("will not be sent again") }));
});
it("finds native results on their original server after a session switches servers", async () => {
  config = familiarConfigSchema.parse({ ...config, servers: { mac: "localhost:6786", linux: "ssh://linux?daemonPort=6787" }, channels: { "100": { host: "localhost:6786", sessionId: "logical-a", allowedUserIds: ["200"] } } });
  const run = vi.fn(async (args: string[]) => {
    if (args[3] === "composition.read") return { result: { title: "A", activeEndpointId: "tool", endpoints: [{ id: "tool", kind: "tool", agentId: "tool-endpoint", serverId: "mac", provider: "aider", cwd: "/project" }] } };
    if (args[3] === "tools.run.read" && args.includes("ssh://linux?daemonPort=6787")) return { result: { id: "old-run", state: "completed", request: { sessionId: "logical-a", toolId: "goose", action: "run" }, result: { text: "original remote result" }, error: null } };
    throw new Error("not found");
  });
  const item = message({ content: "!fa action old-run" });
  await createFamiliarMessageHandler(config, run)(item);
  expect(item.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("original remote result") }));
});

async function readOwnedPid(file: string): Promise<number> {
  for(let attempt=0;attempt<100;attempt++) {
    try {return Number(await readFile(file,"utf8"));} catch {await new Promise(resolve=>setTimeout(resolve,10));}
  }
  throw new Error("Owned CLI fixture did not start");
}
function killOwnedPid(pid: number | undefined) { if(pid) try {process.kill(pid,"SIGKILL");} catch { /* Already reaped. */ } }
it("bounds CLI timeout and escalates when the native transport ignores termination", async () => {
  const runner=createFamiliarCommandRunner(process.execPath),file=path.join(directory,"timeout.pid");
  let pid: number | undefined;
  const result=runner(["-e",`require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`],1000).catch(error=>error as Error);
  try {pid=await readOwnedPid(file);expect(String(await result)).toContain("timed out");expect(()=>process.kill(pid!,0)).toThrow();}
  finally {await runner.close();killOwnedPid(pid);}
});
it.skipIf(process.platform === "win32")("closes owned CLI process groups when the Discord connector stops", async () => {
  const runner=createFamiliarCommandRunner(process.execPath),file=path.join(directory,"close.pid");
  let pid: number | undefined;
  const result=runner(["-e",`const c=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(file)},String(c.pid));setInterval(()=>{},1000);`],10000).catch(error=>error as Error);
  try {
    pid=await readOwnedPid(file);await new Promise(resolve=>setTimeout(resolve,100));await runner.close();expect(String(await result)).toContain("connector stopped");
    for(let attempt=0;attempt<50;attempt++){try{process.kill(pid,0);}catch{return;}await new Promise(resolve=>setTimeout(resolve,10));}
    throw new Error("Owned Discord CLI grandchild survived shutdown");
  } finally {await runner.close();killOwnedPid(pid);}
});
it("rejects oversized CLI output without keeping its producer alive", async () => {
  const runner=createFamiliarCommandRunner(process.execPath),file=path.join(directory,"output.pid");
  let pid: number | undefined;
  const result=runner(["-e",`require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write(Buffer.alloc(9*1024*1024));setInterval(()=>{},1000);`],5000).catch(error=>error as Error);
  try {pid=await readOwnedPid(file);expect(String(await result)).toContain("exceeds 8 MiB");expect(()=>process.kill(pid!,0)).toThrow();}
  finally {await runner.close();killOwnedPid(pid);}
});
it("reserves its active request slot before asynchronous receipt setup", async () => {
  config.maxActiveWaits = 1;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = vi.fn(async (args: string[]) => {
    if (args[3] === "agent.send") await gate;
    return args[0] === "plugin" ? { result: { status: "idle" } } : { status: "idle" };
  });
  const handler = createFamiliarMessageHandler(config, run);
  const first = handler(message());
  const second = message({ messageId: "301" });
  try {
    await handler(second);
    expect(second.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("maximum number") }));
  } finally { release(); await first; }
});
it("posts the exact native assistant response instead of the observed CLI JSON envelope", async () => {
  const final = "FAMILIAR_DISCORD_LIVE_OK";
  const statusInputs: unknown[] = [];
  const run = vi.fn(async (args: string[]) => {
    if (args[0] !== "plugin") return { agentId: "native-agent", status: "idle", message: `Agent is idle.\nLast 5 activity items:\n[User] test prompt\n${final}` };
    if (args[3] === "agent.status") {
      statusInputs.push(JSON.parse(await readFile(args[5], "utf8")));
      return { result: { agentId: "native-agent", status: "idle", permissions: [], recent: ["test prompt", final], assistantReply: { text: final, truncated: false } } };
    }
    return { result: { accepted: true } };
  });
  const item = message(); await createFamiliarMessageHandler(config, run)(item);
  expect(statusInputs).toEqual([{ agentId: "native-agent", messageId: "discord-300" }]);
  expect(item.reply).toHaveBeenLastCalledWith({ content: final, embeds: [], allowedMentions: { parse: [] } });
});
it("does not pass CLI diagnostic text or a previous untyped history entry off as the current reply", async () => {
  const run = vi.fn(async (args: string[]) => args[0] !== "plugin"
    ? { status: "idle", message: "Agent is idle.\n[User] private prompt\nold answer" }
    : { result: args[3] === "agent.status" ? { status: "idle", recent: ["old answer"], assistantReply: null } : { accepted: true } });
  const item = message(); await createFamiliarMessageHandler(config, run)(item);
  expect(item.reply).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining("could not identify") }));
  expect(JSON.stringify(vi.mocked(item.reply).mock.calls)).not.toContain("private prompt");
  expect(JSON.stringify(vi.mocked(item.reply).mock.calls)).not.toContain("old answer");
});
