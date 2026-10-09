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
import { createFamiliarCommandRunner, type FamiliarCommandRunner } from "./familiarCommandRunner.js";
export { createFamiliarCommandRunner, type FamiliarCommandRunner } from "./familiarCommandRunner.js";

export function createFamiliarMessageHandler(config: FamiliarConfig, run: FamiliarCommandRunner = createFamiliarCommandRunner(config.cliPath)) {
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
      if (command === "!fa help") { await reply(message, "FamiliarAgent: send a message to continue the same native agent shown in the desktop app. Commands: !fa status · !fa context · !fa stop · !fa allow <request-id> · !fa deny <request-id> · !fa file <workspace-relative-path>. Shared sessions also support !fa tools · !fa actions · !fa action <run-id> · !fa cancel <run-id> · !fa run <tool> <action> <input> (uses settings saved in FamiliarAgent). Attachments: up to 4 MiB each, 16 MiB total. Native approvals remain enforced."); return; }
      if (binding.sessionId) {
        if (command === "!fa context") { await reply(message, JSON.stringify(await rpc(binding, "composition.context", { id: binding.sessionId }), null, 2)); return; }
        const logical = z.object({ title: z.string(), activeEndpointId: z.string().nullable(), endpoints: z.array(z.object({ id: z.string(), kind: z.enum(["agent", "terminal", "web", "desktop", "tool"]).default("agent"), serverId: z.string(), agentId: z.string(), connection: z.string().optional(), provider: z.string(), cwd: z.string().optional() })) }).parse(await rpc(binding, "composition.read", { id: binding.sessionId }));
        const active = logical.endpoints.find(endpoint => endpoint.id === logical.activeEndpointId);
        const nativeCommand = /^!fa (tools|actions|action|cancel|run)(?:\s|$)/.test(command);
        if (nativeCommand) {
          if (!active?.cwd) throw new Error("Select a project and active tool in FamiliarAgent before using native actions.");
          const destination = config.servers[active.serverId] ?? active.connection;
          if (!destination) throw new Error("Save Discord settings in FamiliarAgent to refresh this server route.");
          const targetBinding = { ...binding, host: destination };
          if (command === "!fa tools") {
            const definitions = z.array(z.object({ toolId: z.string(), actions: z.array(z.object({ id: z.string(), label: z.string() })) })).parse(await rpc(targetBinding, "tools.actions", {}));
            await reply(message, definitions.map(tool => `${tool.toolId}: ${tool.actions.map(action => action.id).join(", ")}`).join("\n")); return;
          }
          if (command === "!fa actions") {
            const hosts = [...new Set([destination, ...Object.values(config.servers)])];
            const results = await Promise.allSettled(hosts.map(host => rpc({ ...binding!, host }, "tools.runs.list", { sessionId: binding!.sessionId, limit: 5 })));
            const summary = results.map((result, index) => {
              if (result.status !== "fulfilled") return { host: hosts[index], error: "This server is unavailable" };
              const page = z.object({ total: z.number(), runs: z.array(z.object({ id: z.string(), state: z.string(), request: z.object({ toolId: z.string(), action: z.string() }), result: z.object({ nativeId: z.string().optional(), preview: z.string() }).nullable() })) }).parse(result.value);
              return { host: hosts[index], total: page.total, runs: page.runs.map(run => ({ id: run.id, tool: run.request.toolId, action: run.request.action, state: run.state, nativeId: run.result?.nativeId, preview: run.result?.preview.slice(0, 240) })) };
            });
            await reply(message, JSON.stringify(summary, null, 2)); return;
          }
          const inspect = /^!fa (action|cancel) ([a-zA-Z0-9_-]{1,160})$/.exec(command);
          if (inspect) {
            const hosts = [...new Set([destination, ...Object.values(config.servers)])];
            const results = await Promise.allSettled(hosts.map(host => rpc({ ...binding!, host }, "tools.run.read", { id: inspect[2] })));
            const matches = results.flatMap((result, index) => {
              if (result.status !== "fulfilled") return [];
              const run = z.object({ id: z.string(), state: z.string(), request: z.object({ sessionId: z.string(), toolId: z.string(), action: z.string() }), result: z.unknown().nullable(), error: z.string().nullable() }).parse(result.value);
              return run.request.sessionId === binding!.sessionId ? [{ host: hosts[index]!, run }] : [];
            });
            if (matches.length !== 1) throw new Error("This native action could not be located uniquely in the shared session. Reconnect its server in FamiliarAgent.");
            const match = matches[0]!;
            const value = inspect[1] === "cancel" ? await rpc({ ...binding, host: match.host }, "tools.run.cancel", { id: inspect[2] }) : match.run;
            const text = JSON.stringify(value, null, 2);
            if (text.length <= 6000) await reply(message, text);
            else await message.reply({ content: `Native action ${inspect[2]}: full result attached.`, embeds: [], allowedMentions: { parse: [] }, files: [{ attachment: Buffer.from(text, "utf8"), name: `${inspect[2]}.json` }] });
            return;
          }
          const invoke = /^!fa run ([a-z0-9_-]+) ([a-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(command);
          if (!invoke) { await reply(message, "Use !fa tools, !fa actions, !fa action <run-id>, !fa cancel <run-id>, or !fa run <tool> <action> <input>."); return; }
          if (!message.messageId || !/^\d+$/.test(message.messageId)) throw new Error("A durable Discord message ID is required");
          if (message.attachments?.length) throw new Error("Send native action attachments through FamiliarAgent Files, then include their server path in the input.");
          const settings = z.object({ parameters: z.record(z.string(), z.string()) }).parse(await rpc(targetBinding, "tools.action-settings.read", { toolId: invoke[1], action: invoke[2] }));
          const directory = path.join(config.stateDirectory, "receipts"); await mkdir(directory, { recursive: true, mode: 0o700 });
          if ((await readdir(directory)).filter(name => name.endsWith(".json")).length >= config.maxReceipts) throw new Error("The request receipt store is full; clear reviewed receipts before sending new work.");
          const operationId = `discord-${message.messageId}`;
          const file = path.join(directory, `${message.messageId}.json`);
          try { await writeFile(file, JSON.stringify({ state: "dispatching", host: destination, sessionId: binding.sessionId, operationId }), { flag: "wx", mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await reply(message, `This message was already recorded. Use !fa action ${operationId}; it will not be sent again.`); return; }
          const originalId = /^@([^\s]+)(?:\s+|$)/.exec(invoke[3] ?? "");
          const result = await rpc(targetBinding, "tools.run.start", { operationId, sessionId: binding.sessionId, toolId: invoke[1], action: invoke[2], cwd: active.cwd, input: originalId ? (invoke[3] ?? "").slice(originalId[0].length) : invoke[3] ?? "", ...(originalId ? { nativeId: originalId[1] } : {}), parameters: settings.parameters });
          await receipt(file, { state: "accepted", host: destination, sessionId: binding.sessionId, operationId });
          await reply(message, `Original tool action: ${operationId}. Use !fa action ${operationId} for progress and results. State: ${z.object({state: z.string()}).parse(result).state}`); return;
        }
        if (!active || active.kind !== "agent") {
          await reply(message, `${logical.title}: ${active ? `${active.provider} (${active.kind})` : "no active tool"}. Use !fa tools and !fa run <tool> <action> <input> for native actions, !fa actions for results, or !fa context for shared memory. The original interface also remains available in FamiliarAgent.`); return;
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
  const runner = createFamiliarCommandRunner(config.cliPath);
  attachDiscordMessageHandler(client, createFamiliarMessageHandler(config, runner));
  const stop = () => { client.destroy(); void runner.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await client.login(token);
}
