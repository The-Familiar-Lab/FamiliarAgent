import { afterEach, expect, test } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
let context: DaemonTestContext | undefined;
let cwd: string | undefined;
afterEach(async () => {
  await context?.cleanup();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
async function setup(script: string) {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "familiar-terminal-launch-")));
  context = await createDaemonTestContext();
  const opened = await context.client.openProject(cwd);
  expect(opened.error).toBeFalsy();
  const created = await context.client.createTerminal(cwd, "Native launch proof", undefined, {
    command: process.execPath,
    args: ["-e", script],
    workspaceId: opened.workspace!.id,
  });
  expect(created.error).toBeFalsy();
  return { client: context.client, id: created.terminal!.id };
}

test("late attachment shows the original process failure instead of an empty terminal", async () => {
  const { client, id } = await setup(
    "process.stderr.write('Native setup missing: configure provider\\n'); process.exitCode = 7",
  );
  await expect
    .poll(() => context!.daemon.daemon.terminalManager?.getTerminalExitInfo?.(id), {
      timeout: 10000,
    })
    .toMatchObject({ exitCode: 7 });
  const stream = client.observeTerminal(id, () => {});
  try {
    await expect(stream.ready).rejects.toThrow("exit code 7");
    await expect(stream.ready).rejects.toThrow("Native setup missing: configure provider");
  } finally {
    await stream.release();
  }
}, 30000);

test("an attached native command delivers its final diagnostic and real exit code", async () => {
  const { client, id } = await setup(
    "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('go')) { clearInterval(timer); process.stderr.write('Original tool startup failed\\n'); process.exitCode = 9; } }, 20)",
  );
  const stream = client.observeTerminal(id, () => {});
  const exits: Array<unknown> = [];
  stream.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type === "terminal_stream_exit") exits.push(message.payload);
    },
  });
  try {
    expect((await stream.ready).error).toBeNull();
    await writeFile(path.join(cwd!, "go"), "go");
    await expect.poll(() => exits, { timeout: 10000 }).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      terminalId: id,
      exitCode: 9,
      lastOutputLines: expect.arrayContaining(["Original tool startup failed"]),
    });
  } finally {
    await stream.release();
  }
}, 30000);
