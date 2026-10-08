import { afterEach, describe, expect, test, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findDefaultCodexBinary,
  findCodexMacOSBinary,
  CodexAppServerAgentClient,
} from "./codex-app-server-agent.js";
import * as executableResolution from "../../../executable-resolution/executable-resolution.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const temporaryDirectories: string[] = [];
async function applicationDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "familiar-codex-app-"));
  temporaryDirectories.push(directory);
  return directory;
}
async function executable(directory: string, bundle: "Codex" | "ChatGPT", runnable = true) {
  const relative =
    bundle === "Codex"
      ? "Codex.app/Contents/Resources/codex"
      : "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  const target = path.join(directory, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "#!/bin/sh\nprintf 'codex-cli test\\n'\n");
  await chmod(target, runnable ? 0o755 : 0o644);
  return target;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("Codex application discovery", () => {
  test("finds the ChatGPT bundled CLI without a PATH entry", async () => {
    const root = await applicationDirectory();
    const target = await executable(root, "ChatGPT");
    expect(await findCodexMacOSBinary([root])).toBe(target);
  });

  test("skips a non-executable user bundle and discovers the system application", async () => {
    const user = await applicationDirectory();
    const system = await applicationDirectory();
    await executable(user, "Codex", false);
    const target = await executable(system, "Codex");
    expect(await findCodexMacOSBinary([user, system])).toBe(target);
  });

  test("returns absent when no application has an executable", async () => {
    expect(await findCodexMacOSBinary([await applicationDirectory()])).toBeNull();
  });

  test("preserves the CLI selected by PATH before probing applications", async () => {
    vi.spyOn(executableResolution, "findExecutable").mockResolvedValue("/custom/bin/codex");
    const probe = vi.spyOn(executableResolution, "probeExecutable");
    expect(await findDefaultCodexBinary()).toBe("/custom/bin/codex");
    expect(probe).not.toHaveBeenCalled();
  });

  test("a missing explicit command does not silently fall back to an installed app", async () => {
    const root = await applicationDirectory();
    const client = new CodexAppServerAgentClient(createTestLogger(), {
      command: { mode: "replace", argv: [path.join(root, "missing")] },
    });
    await expect(client.isAvailable()).resolves.toBe(false);
  });
});
