import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { available } = vi.hoisted(() => ({ available: vi.fn(() => true) }));
vi.mock("electron", () => ({
  app: {},
  safeStorage: {
    isEncryptionAvailable: available,
    encryptString: (value: string) => Buffer.from(value).reverse(),
  },
}));
import { DiscordConnection } from "./discord.js";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "familiar-discord-"));
  available.mockReturnValue(true);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const binding = {
  channelId: "123",
  host: "ssh://server?daemonPort=6787",
  agentId: "agent1",
  allowedUserIds: ["456"],
};
it("stores credentials through OS encryption and never returns a token", async () => {
  const connection = new DiscordConnection(directory);
  const status = await connection.save({ bindings: [binding], token: "test-only-credential" });
  expect(status.tokenSet).toBe(true);
  expect(JSON.stringify(status)).not.toContain("test-only-credential");
  expect(await readFile(path.join(directory, "settings.json"), "utf8")).not.toContain(
    "test-only-credential",
  );
  expect((await readFile(path.join(directory, "token.enc"))).toString()).not.toBe(
    "test-only-credential",
  );
});
it("refuses plaintext fallback and unauthorized or duplicate channel bindings", async () => {
  const connection = new DiscordConnection(directory);
  available.mockReturnValue(false);
  await expect(connection.save({ bindings: [binding], token: "test" })).rejects.toThrow(
    "encryption",
  );
  await expect(
    connection.save({ bindings: [{ ...binding, allowedUserIds: [] }] }),
  ).rejects.toThrow();
  await expect(connection.save({ bindings: [binding, binding] })).rejects.toThrow("once");
});
it("does not report a connected bot without a configured live login", async () => {
  const connection = new DiscordConnection(directory);
  await expect(connection.start()).rejects.toThrow("authorized Discord channel");
  expect((await connection.status()).state).toBe("stopped");
  await connection.stop();
});

it("saves only an original configuration reference and role bindings without copying a token", async () => {
  available.mockReturnValue(false);
  const connection = new DiscordConnection(directory);
  const source = {
    sshEndpoint: "ssh://server?daemonPort=6787",
    configPath: "/private/original/config.json",
  };
  const status = await connection.save({
    source,
    bindings: [{ ...binding, allowedUserIds: [], allowedRoleIds: ["900"] }],
  });
  expect(status.source).toEqual(source);
  expect(status.tokenSet).toBe(true);
  await expect(readFile(path.join(directory, "token.enc"))).rejects.toThrow();
  await expect(
    connection.save({ source, bindings: [binding], token: "never-copy" }),
  ).rejects.toThrow("not both");
});
