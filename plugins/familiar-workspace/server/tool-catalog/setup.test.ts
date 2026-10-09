import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ToolSetup } from "./setup.js";
import { ToolCatalog } from "./service.js";
import { prepareToolSetup } from "../../shared/tool-setup.js";
import { apiKeySetup } from "./api-key-setup.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(installed = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "familiar-setup-"));
  roots.push(root);
  const tools = {
    list: async () => [{ id: "aider", installed, installAvailable: true }],
    resolveCommand: async (name: string) => `/native/${name}`,
    prepare: vi.fn(async (input) => ({ ...input, command: "/installer", args: [] })),
    searchPath: () => "/native",
  } as unknown as ToolCatalog;
  return { root, tools, setup: new ToolSetup(root, tools) };
}
it("only creates an install plan and needs no user's project folder", async () => {
  const { root, setup, tools } = await fixture(false);
  expect((await setup.status("aider")).installation).toBe("missing");
  const result = await setup.prepare({ id: "aider", action: "install" });
  expect(result.plan?.command).toBe("/installer");
  expect(tools.prepare).toHaveBeenCalledWith({
    id: "aider",
    action: "install",
    cwd: path.join(root, "familiar", "tool-setup"),
  });
  await expect(
    setup.prepare({ id: "aider", action: "api-key", provider: "openai" }),
  ).rejects.toThrow("unavailable");
});
it("passes only a private credential path, never a key, and does not claim authentication", async () => {
  const { setup, root } = await fixture();
  const result = await setup.prepare({ id: "aider", action: "api-key", provider: "openai" });
  const key = apiKeySetup(root, "openai");
  expect(result.settings).toBeUndefined();
  expect(result.plan!.args.slice(-2)).toEqual([key.file, "OPENAI_API_KEY"]);
  await mkdir(path.dirname(key.file), { recursive: true, mode: 0o700 });
  await writeFile(key.file, "OPENAI_API_KEY=private-fixture-only", { mode: 0o600 });
  const status = await setup.status("aider");
  expect(status.account).toBe("not-checked");
  expect(status.message).toMatch(/private API key file is present/);
  expect(JSON.stringify(status)).not.toContain("private-fixture-only");
  const applied = await setup.prepare({ id: "aider", action: "apply-key", provider: "openai" });
  expect(applied.plan).toBeUndefined();
  expect(applied.settings).toEqual([{ action: "run", parameters: { envFile: key.file } }]);
  await expect(
    setup.prepare({ id: "aider", action: "apply-key", provider: "anthropic" }),
  ).rejects.toThrow("API environment file");
});
it("rejects arbitrary auth providers, secret values and unexpected commands at the RPC boundary", () => {
  expect(
    prepareToolSetup.input.safeParse({ id: "aider", action: "api-key", provider: "shell" }).success,
  ).toBe(false);
  expect(
    prepareToolSetup.input.safeParse({
      id: "aider",
      action: "api-key",
      provider: "openai",
      key: "secret",
    }).success,
  ).toBe(false);
  expect(
    prepareToolSetup.input.safeParse({ id: "aider", action: "login", command: "anything" }).success,
  ).toBe(false);
});
