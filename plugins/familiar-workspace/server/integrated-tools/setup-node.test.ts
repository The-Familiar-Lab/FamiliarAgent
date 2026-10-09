import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nodeToolCommand } from "./setup-node.js";
import { prepareOrcaCli } from "./setup-runtime.js";
import { prepareIntegratedSetup } from "./setup.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "familiar-node-'fixture-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function cleanEnvironment() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
async function electronHelper() {
  const helper = join(root, "Electron Helper");
  await writeFile(
    helper,
    `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = "1" ] || { echo 'Node mode required' >&2; exit 42; }\nexec ${quote(process.execPath)} "$@"\n`,
    { mode: 0o700 },
  );
  return helper;
}

it("runs a Node-mode helper from a clean shell with exact arguments", async () => {
  const helper = await electronHelper();
  const args = ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "space and ' quote"];
  await expect(promisify(execFile)(helper, args, { env: cleanEnvironment() })).rejects.toThrow(
    "Node mode required",
  );
  const plan = nodeToolCommand(helper, args, "darwin");
  const result = await promisify(execFile)(plan.command, plan.args, {
    env: cleanEnvironment(),
    timeout: 5000,
  });
  expect(JSON.parse(result.stdout)).toEqual(["space and ' quote"]);
});

it("runs the managed Orca CLI wrapper without relying on the daemon environment", async () => {
  const helper = await electronHelper();
  const entry = join(root, "Orca CLI's entry.cjs");
  await writeFile(entry, "console.log(JSON.stringify(process.argv.slice(2)))");
  const wrapper = join(root, "profile", "orca-cli");
  await prepareOrcaCli(helper, entry, wrapper);
  const args = ["send", "original session", "literal $(no-command) and ' quote"];
  const result = await promisify(execFile)(wrapper, args, {
    env: cleanEnvironment(),
    timeout: 5000,
  });
  expect(JSON.parse(result.stdout)).toEqual(args);
  expect(await readFile(entry, "utf8")).toBe("console.log(JSON.stringify(process.argv.slice(2)))");
});

it("keeps Windows plans as direct Node argv and excludes an Electron self runtime", async () => {
  const original = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process.versions, "electron", { value: "41.0.0", configurable: true });
  try {
    const context = {
      resolveCommand: vi.fn(async () => "C:\\Program Files\\nodejs\\node.exe"),
      exec: vi.fn(async () => ({ stdout: "v24.0.0\n", stderr: "", exitCode: 0 })),
    };
    const prepared = await prepareIntegratedSetup(
      { id: "docker-skills", action: "install", root, cwd: root, platform: "win32" },
      context,
    );
    expect(context.exec).toHaveBeenCalledOnce();
    expect(context.exec.mock.calls[0]).toEqual([
      expect.objectContaining({ command: "C:\\Program Files\\nodejs\\node.exe" }),
    ]);
    expect(prepared?.plan?.command).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(prepared?.plan?.args[0]).toBe("-e");
    context.resolveCommand.mockResolvedValue(process.execPath);
    await expect(
      prepareIntegratedSetup(
        { id: "docker-skills", action: "install", root, cwd: root, platform: "win32" },
        context,
      ),
    ).rejects.toThrow("Node.js 20 or newer");
  } finally {
    if (original) Object.defineProperty(process.versions, "electron", original);
    else Reflect.deleteProperty(process.versions, "electron");
  }
});
