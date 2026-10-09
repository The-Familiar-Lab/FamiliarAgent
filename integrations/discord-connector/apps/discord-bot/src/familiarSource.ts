import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { FamiliarConfig } from "./familiarBridge.js";

const snowflake = z.string().regex(/^\d+$/);
const sourceSchema = z.object({
  discord: z.object({ token: z.string().min(1).max(4096), guildId: snowflake, allowedRoleIds: z.array(snowflake).min(1) }),
  direct: z.object({ channelId: snowflake.optional(), claudeChannelId: snowflake.optional() }).optional(),
});
export type FamiliarSource = z.infer<typeof sourceSchema>;
export async function readFamiliarSource(file: string): Promise<FamiliarSource> {
  if (!path.isAbsolute(file)) throw new Error("Choose an absolute original connector configuration path.");
  const info = await stat(file);
  if (!info.isFile() || info.size > 1024 * 1024 || (process.platform !== "win32" && (info.mode & 0o077)))
    throw new Error("The original connector configuration must be a private file (permissions 600). Its contents were not copied.");
  try { return sourceSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch { throw new Error("Original connector configuration is invalid. Verify its Discord settings without copying credentials."); }
}
async function discord(source: FamiliarSource, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://discord.com/api/v10${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bot ${source.discord.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Discord setup request failed (${response.status}). Check bot access and Manage Channels permission.`);
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw new Error("Discord setup returned an empty response.");
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 1024 * 1024) throw new Error("Discord setup response is too large.");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function managedChannels(source: FamiliarSource): string[] { return [source.direct?.channelId, source.direct?.claudeChannelId].filter((id): id is string => Boolean(id)); }
export async function inspectFamiliarSource(source: FamiliarSource) {
  const guild = z.object({ id: snowflake, name: z.string() }).parse(await discord(source, `/guilds/${source.discord.guildId}`));
  const channels = z.array(z.object({ id: snowflake, name: z.string(), type: z.number() })).parse(await discord(source, `/guilds/${guild.id}/channels`));
  const excluded = managedChannels(source);
  return { guild, allowedRoleIds: source.discord.allowedRoleIds, channels: channels.filter(channel => channel.type === 0 && !excluded.includes(channel.id)) };
}
export async function createFamiliarChannel(source: FamiliarSource) {
  const inventory = await inspectFamiliarSource(source);
  if (inventory.channels.some(channel => channel.name === "familiaragent-test")) throw new Error("A familiaragent-test channel already exists. Choose it from the channel list.");
  const bot = z.object({ id: snowflake }).parse(await discord(source, "/users/@me"));
  // Restrict channel visibility as well as message handling to the original connector's roles.
  const access = String(1024n | 2048n | 32768n | 65536n);
  const channel = z.object({ id: snowflake, name: z.string(), type: z.literal(0) }).parse(await discord(source, `/guilds/${inventory.guild.id}/channels`, {
    name: "familiaragent-test", type: 0, topic: "FamiliarAgent shared sessions. Separate from the original connector channels.",
    permission_overwrites: [{ id: inventory.guild.id, type: 0, deny: "1024" }, ...source.discord.allowedRoleIds.map(id => ({ id, type: 0, allow: access })), { id: bot.id, type: 1, allow: access }],
  }));
  return { ...inventory, channels: [...inventory.channels, channel], createdChannelId: channel.id };
}
export function applyFamiliarSource(config: FamiliarConfig, source: FamiliarSource): FamiliarConfig {
  for (const [id, binding] of Object.entries(config.channels)) {
    if (managedChannels(source).includes(id)) throw new Error("Choose a separate channel; the original connector's configured channels remain unchanged.");
    if (binding.allowedUserIds.length || binding.allowedRoleIds.length !== source.discord.allowedRoleIds.length || binding.allowedRoleIds.some(id => !source.discord.allowedRoleIds.includes(id)))
      throw new Error("Existing connector bindings must use exactly the original allowed roles.");
  }
  return config;
}
export async function validateFamiliarChannels(source: FamiliarSource, channels: string[]): Promise<void> {
  const inventory = await inspectFamiliarSource(source);
  if (channels.some(id => !inventory.channels.some(channel => channel.id === id))) throw new Error("A selected channel is unavailable or belongs to another Discord server.");
}
