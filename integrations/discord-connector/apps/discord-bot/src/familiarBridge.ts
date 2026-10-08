import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { splitDiscordMessageContent } from "../../../packages/core/src/index.js";
import { attachDiscordMessageHandler, createDiscordClient } from "./discordClient.js";
import { createIncomingAttachmentStore } from "./incomingAttachments.js";
import type { DiscordMessageLike } from "./messageHandler.js";

const bindingSchema = z.object({
  host: z.string().min(1), agentId: z.string().min(1).optional(), sessionId: z.string().min(1).max(160).optional(), sharedWorkspace: z.string().default("main"),
  allowedUserIds: z.array(z.string().regex(/^\d+$/)).default([]),
  allowedRoleIds: z.array(z.string().regex(/^\d+$/)).default([]),
}).strict().refine(value => Boolean(value.agentId) !== Boolean(value.sessionId), "Choose a native agent or a logical session").refine(value => value.allowedUserIds.length + value.allowedRoleIds.length > 0, "Each binding needs allowed users or roles");
export const familiarConfigSchema = z.object({
  cliPath: z.string().refine(path.isAbsolute, "CLI path must be absolute"), stateDirectory: z.string().refine(path.isAbsolute, "State directory must be absolute"),
  commandTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  waitTimeoutSeconds: z.number().int().min(1).max(7200).default(1800),
  maxReceipts: z.number().int().min(1).max(100000).default(10000),
  maxActiveWaits: z.number().int().min(1).max(32).default(8),
  servers: z.record(z.string().min(1), z.string().min(1)).default({}),
  channels: z.record(z.string().regex(/^\d+$/), bindingSchema),
}).strict();
export type FamiliarConfig = z.infer<typeof familiarConfigSchema>;
type Binding = z.infer<typeof bindingSchema>;
export interface FamiliarCommandRunner { (args: string[], timeoutMs: number): Promise<unknown> }

export function createFamiliarCommandRunner(cliPath: string): FamiliarCommandRunner {
  if (!path.isAbsolute(cliPath)) throw new Error("FamiliarAgent CLI path must be absolute");
  return (args, timeoutMs) => new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", errors = "", settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill("SIGTERM"); reject(error); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error("FamiliarAgent returned invalid JSON")); }
    };
    const timer = setTimeout(() => finish(new Error("FamiliarAgent request timed out. The native operation may still be running; use !fa status before retrying.")), timeoutMs);
    child.stdout.on("data", chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > 8 * 1024 * 1024) finish(new Error("FamiliarAgent response exceeds 8 MiB")); });
    child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-4096); });
    child.on("error", error => finish(error));
    child.on("close", code => finish(code === 0 ? undefined : new Error(`FamiliarAgent failed (${code}). ${errors || output.slice(-4096)}`)));
  });
}

export function createFamiliarMessageHandler(config: FamiliarConfig, run = createFamiliarCommandRunner(config.cliPath)) {
  let activeWaits = 0;
  const attachments = createIncomingAttachmentStore({ rootPath: path.join(config.stateDirectory, "incoming"), maxBytesPerFile: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, maxFiles: 10 });
  async function rpc(binding: Binding, method: string, input: unknown): Promise<unknown> {
    await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(path.join(config.stateDirectory, ".request-"));
    const file = path.join(temporary, "input.json");
    try {
      await writeFile(file, JSON.stringify(input), { mode: 0o600 });
      const response = await run(["plugin", "call", "familiar-workspace", method, "--input-file", file, "--host", binding.host, "--json"], config.commandTimeoutMs);
      return z.object({ result: z.unknown() }).parse(response).result;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async function reply(message: DiscordMessageLike, content: string) {
    for (const chunk of splitDiscordMessageContent(content)) await message.reply({ content: chunk, embeds: [], allowedMentions: { parse: [] } });
  }
  async function receipt(file: string, value: unknown) {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  }
  return async (message: DiscordMessageLike): Promise<void> => {
    let binding = config.channels[message.channelId];
    if (!binding || message.authorBot) return;
    if (!binding.allowedUserIds.includes(message.userId) && !message.roleIds.some(role => binding.allowedRoleIds.includes(role))) return;
    try {
      const command = message.content.trim();
      if (command === "!fa help") { await reply(message, "FamiliarAgent: send a message to continue the same native agent shown in the desktop app. Commands: !fa status · !fa context · !fa stop · !fa allow <request-id> · !fa deny <request-id> · !fa file <workspace-relative-path>. Attachments: up to 4 MiB each, 16 MiB total. Native approvals remain enforced."); return; }
      if (binding.sessionId) {
        if (command === "!fa context") { await reply(message, JSON.stringify(await rpc(binding, "composition.context", { id: binding.sessionId }), null, 2)); return; }
        const logical = z.object({ title: z.string(), activeEndpointId: z.string().nullable(), endpoints: z.array(z.object({ id: z.string(), kind: z.enum(["agent", "terminal", "web", "desktop"]).default("agent"), serverId: z.string(), agentId: z.string(), connection: z.string().optional(), provider: z.string() })) }).parse(await rpc(binding, "composition.read", { id: binding.sessionId }));
        const active = logical.endpoints.find(endpoint => endpoint.id === logical.activeEndpointId);
        if (!active || active.kind !== "agent") {
          await reply(message, `${logical.title}: ${active ? `${active.provider} (${active.kind})` : "no active tool"}. Shared memory is available with !fa context. Open this tool in FamiliarAgent to interact with its original interface.`); return;
        }
        const target = config.servers[active.serverId] ?? active.connection;
        if (!target) throw new Error("This session moved to a server without a Discord route. Save Discord settings again from the desktop to refresh connected servers.");
        binding = { ...binding, host: target, agentId: active.agentId };
      }
      if (!binding.agentId) throw new Error("No active native agent is connected to this channel.");
      if (command === "!fa status") { await reply(message, JSON.stringify(await rpc(binding, "agent.status", { agentId: binding.agentId }), null, 2)); return; }
      if (command === "!fa context") { await reply(message, JSON.stringify(await rpc(binding, "space.read", { id: binding.sharedWorkspace }), null, 2)); return; }
      if (command === "!fa stop") { await reply(message, JSON.stringify(await run(["agent", "stop", binding.agentId, "--host", binding.host, "--json"], config.commandTimeoutMs))); return; }
      const permission = /^!fa (allow|deny) (\S+)$/.exec(command);
      if (permission) { await rpc(binding, "agent.permission", { agentId: binding.agentId, requestId: permission[2], behavior: permission[1] }); await reply(message, "Permission response delivered to the native agent."); return; }
      if (command.startsWith("!fa file ")) {
        const file = z.object({ name: z.string(), base64: z.string(), sha256: z.string() }).parse(await rpc(binding, "artifact.get", { agentId: binding.agentId, path: command.slice(9).trim() }));
        const bytes = Buffer.from(file.base64, "base64");
        if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("File checksum mismatch");
        await message.reply({ content: file.name, embeds: [], allowedMentions: { parse: [] }, files: [{ attachment: bytes, name: file.name }] });
        return;
      }
      if (command.startsWith("!fa")) { await reply(message, "Unknown FamiliarAgent command. Use !fa help."); return; }
      if (!message.messageId || !/^\d+$/.test(message.messageId)) throw new Error("A durable Discord message ID is required");
      if (activeWaits >= config.maxActiveWaits) { await reply(message, "The connector is handling its maximum number of active requests. Use !fa status or try again later."); return; }
      const directory = path.join(config.stateDirectory, "receipts");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `${message.messageId}.json`);
      if ((await readdir(directory)).filter(name => name.endsWith(".json")).length >= config.maxReceipts) {
        await reply(message, "The request receipt store is full. Export and clear old receipts in the connector state folder before sending new requests. Existing agents keep running.");
        return;
      }
      try { await writeFile(file, JSON.stringify({ state: "dispatching", agentId: binding.agentId, messageId: message.messageId }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await reply(message, "This message was already recorded and will not be executed again. Use !fa status to inspect the native session."); return; }
      activeWaits += 1;
      try {
        let text = message.content;
        if (message.attachments?.length) {
          const files = await attachments.materialize({ messageId: message.messageId, attachments: message.attachments });
          for (const attachment of files) {
            const bytes = await readFile(attachment.localPath);
            const artifact = await rpc(binding, "artifact.put", { name: attachment.name, base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
            text += `\nAttached file on the agent server: ${JSON.stringify(artifact)}`;
          }
        }
        await rpc(binding, "agent.send", { agentId: binding.agentId, text, messageId: `discord-${message.messageId}` });
        await receipt(file, { state: "accepted", agentId: binding.agentId, messageId: message.messageId });
        await reply(message, `Accepted by native agent ${binding.agentId}. Use !fa status for progress or !fa stop to interrupt.`).catch(() => {});
        const result = await run(["agent", "wait", binding.agentId, "--timeout", `${config.waitTimeoutSeconds}s`, "--host", binding.host, "--json"], (config.waitTimeoutSeconds + 30) * 1000);
        const status = await rpc(binding, "agent.status", { agentId: binding.agentId });
        await receipt(file, { state: "observed", result, status, delivery: "pending" });
        await reply(message, JSON.stringify({ result, status }, null, 2));
        await receipt(file, { state: "observed", result, status, delivery: "delivered" });
      } catch (error) {
        // A lost acknowledgement is ambiguous. Never automatically run the prompt again.
        await reply(message, `Request needs inspection: ${error instanceof Error ? error.message : String(error)}\nUse !fa status. FamiliarAgent will not automatically resend this prompt.`);
      } finally {
        activeWaits -= 1;
        await rm(path.join(config.stateDirectory, "incoming", message.messageId), { recursive: true, force: true }).catch(() => { console.warn("FamiliarAgent could not remove a temporary Discord attachment folder."); });
      }
    } catch (error) { await reply(message, error instanceof Error ? error.message : String(error)); }
  };
}

export async function startFamiliarBot(token: string, configPath: string): Promise<void> {
  const config = familiarConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const client = createDiscordClient();
  attachDiscordMessageHandler(client, createFamiliarMessageHandler(config));
  process.once("SIGTERM", () => { client.destroy(); });
  process.once("SIGINT", () => { client.destroy(); });
  await client.login(token);
}
