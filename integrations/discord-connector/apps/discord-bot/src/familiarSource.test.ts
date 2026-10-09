import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFamiliarSource, inspectFamiliarSource, applyFamiliarSource, createFamiliarChannel } from "./familiarSource.js";
import { familiarConfigSchema } from "./familiarBridge.js";
const source = { discord: { token: "test-only-secret", guildId: "100", allowedRoleIds: ["200"] }, direct: { channelId: "300", claudeChannelId: "301" } };
const config = (channel = "400", roles = ["200"], users: string[] = []) => familiarConfigSchema.parse({ cliPath: "/bin/familiar", stateDirectory: "/tmp/private", channels: { [channel]: { host: "local", agentId: "test", allowedRoleIds: roles, allowedUserIds: users } } });
afterEach(() => vi.unstubAllGlobals());
it("keeps original channel and role boundaries, refusing wider access", () => {
  expect(applyFamiliarSource(config(), source)).toBeDefined();
  expect(() => applyFamiliarSource(config("300"), source)).toThrow("separate channel");
  expect(() => applyFamiliarSource(config("400", ["500"]), source)).toThrow("original allowed roles");
  expect(() => applyFamiliarSource(config("400", ["200"], ["201"]), source)).toThrow("original allowed roles");
});
it("requires a private original file and leaves it unchanged", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "discord-source-test-"));
  try {
    const file = path.join(directory, "config.json"); await writeFile(file, JSON.stringify(source), { mode: 0o600 });
    expect(await readFamiliarSource(file)).toEqual(source);
    await chmod(file, 0o644); await expect(readFamiliarSource(file)).rejects.toThrow("private file");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("excludes original channels and returns no credential in discovery", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("channels") ? [{ id: "300", name: "main", type: 0 }, { id: "400", name: "safe", type: 0 }] : { id: "100", name: "Guild" }))));
  const inventory = await inspectFamiliarSource(source);
  expect(inventory.channels.map(item => item.id)).toEqual(["400"]);
  expect(JSON.stringify(inventory)).not.toContain(source.discord.token);
});
it("creates a role-restricted dedicated channel without editing original configuration", async () => {
  const requests: { url: string; body?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: init.body as string | undefined });
    return new Response(JSON.stringify(init.method === "POST" ? { id: "400", name: "familiaragent-test", type: 0 } : url.endsWith("channels") ? [] : url.endsWith("@me") ? { id: "999" } : { id: "100", name: "Guild" }));
  }));
  const result = await createFamiliarChannel(source);
  expect(result.createdChannelId).toBe("400");
  const body = JSON.parse(requests.at(-1)!.body!);
  expect(body.permission_overwrites).toEqual([{ id: "100", type: 0, deny: "1024" }, { id: "200", type: 0, allow: "101376" }, { id: "999", type: 1, allow: "101376" }]);
  expect(source.direct.channelId).toBe("300");
});

it("never includes malformed credential file contents in validation errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "discord-source-invalid-"));
  try {
    const file = path.join(directory, "config.json"); await writeFile(file, '{"token":"private-do-not-echo", broken}', { mode: 0o600 });
    let failure: unknown;
    try { await readFamiliarSource(file); } catch (error) { failure = error; }
    expect(String(failure)).toContain("configuration is invalid"); expect(String(failure)).not.toContain("private-do-not-echo");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
