import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ToolSetup } from "./setup.js";
import type { ToolCatalog } from "./service.js";
import { prepareNativeInstaller } from "./installers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(id: string, output: string, exitCode = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "familiar-vendor-setup-"));
  roots.push(root);
  const binary = path.join(root, "native-cli");
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});process.exitCode=${exitCode};\n`,
    { mode: 0o700 },
  );
  const tools = {
    list: async () => [{ id, installed: true, installAvailable: true }],
    resolveCommand: async () => binary,
    searchPath: () => root,
  } as unknown as ToolCatalog;
  return { setup: new ToolSetup(root, tools), binary };
}

it.each([
  ["cursor", '{"isAuthenticated":true}', 0, "signed-in"],
  ["cursor", '{"isAuthenticated":false}', 0, "sign-in-required"],
  ["cursor", '{"isAuthenticated":true}', 1, "sign-in-required"],
  ["cursor", "Logged in (unrecognized format)", 0, "not-checked"],
  ["antigravity", "model-id\tModel label\nsecond\tAnother model\n", 0, "signed-in"],
  ["antigravity", "Please sign in to continue", 1, "sign-in-required"],
  ["antigravity", "", 0, "not-checked"],
  ["antigravity", "service unavailable", 1, "not-checked"],
])(
  "%s account checks distinguish native authentication from unknown output",
  async (id, output, code, account) => {
    const { setup } = await fixture(id, output, code);
    const status = await setup.status(id);
    expect(status.account).toBe(account);
    expect(status.actions).toContainEqual({ id: "login", label: "Sign in" });
  },
);

it.each([
  ["cursor", ["login"]],
  ["antigravity", []],
] as const)("%s opens its original sign-in without moving credentials", async (id, args) => {
  const { setup, binary } = await fixture(id, "");
  const { plan } = await setup.prepare({ id, action: "login" });
  expect(plan?.command).toBe("/usr/bin/env");
  expect(plan?.args.slice(1)).toEqual([binary, ...args]);
});

it.each([
  ["cursor", "cursor-agent", "https://cursor.com/install"],
  ["antigravity", "agy", "https://antigravity.google/cli/install.sh"],
] as const)(
  "%s native installation preserves the vendor update path and Electron Node mode",
  async (id, binary, url) => {
    const plan = await prepareNativeInstaller({
      id,
      root: "/private/familiar",
      cwd: "/private/setup",
      searchPath: "/usr/bin",
      executable: async (name) => `/usr/bin/${name}`,
    });
    expect(plan.command).toBe("/usr/bin/env");
    expect(plan.args.slice(0, 3)).toEqual(["ELECTRON_RUN_AS_NODE=1", process.execPath, "-e"]);
    expect(plan.args[4]).toBe(url);
    expect(plan.args[5]).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.args.at(-1)).toBe(path.join(os.homedir(), ".local", "bin", binary));
  },
);
