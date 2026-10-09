import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import {
  compositionSession,
  type CompositionEndpoint,
} from "../../../../../plugins/familiar-workspace/shared/composition.js";
import { readCompositionActivity } from "../../../../../plugins/familiar-workspace/shared/activity.js";

let context: DaemonTestContext | undefined;
let directory: string | undefined;
afterEach(async () => {
  await context?.cleanup();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test("actual activity RPC observes native terminal lifetime without treating launcher exit as work completion", async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "familiar-activity-")));
  const home = path.join(directory, ".paseo");
  vi.stubEnv("PASEO_HOME", home);
  context = await createDaemonTestContext({
    paseoHomeRoot: directory,
    pluginsEnabled: true,
    builtinPlugins: new BuiltinPluginLoader(
      path.resolve(import.meta.dirname, "../../../../../plugins"),
      ["familiar-workspace"],
    ),
  });
  const rpc = (method: string, input: unknown) =>
    context!.client.invokePluginRpc("familiar-workspace", method, input);
  const serverId = (await readFile(path.join(home, "server-id"), "utf8")).trim();
  const opened = await context.client.openProject(directory);
  expect(opened.error).toBeFalsy();
  const workspaceId = opened.workspace!.id;
  const terminal = await context.client.createTerminal(
    directory,
    "Owned activity terminal",
    undefined,
    {
      workspaceId,
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('PRIVATE_TERMINAL_TEXT\\n'); const fs=require('node:fs'); const timer=setInterval(()=>{if(fs.existsSync('finish'))clearInterval(timer)},25)",
      ],
    },
  );
  expect(terminal.error).toBeFalsy();
  const desktop = await context.client.createTerminal(
    directory,
    "Owned desktop launcher",
    undefined,
    {
      workspaceId,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    },
  );
  expect(desktop.error).toBeFalsy();
  await expect
    .poll(() => context!.daemon.daemon.terminalManager?.getTerminalExitInfo?.(desktop.terminal!.id))
    .toMatchObject({ exitCode: 0 });

  await rpc("composition.project.save", {
    id: "activity-project",
    title: "Activity proof",
    expectedRevision: 0,
    memory: "",
    resources: [],
    operationId: "project",
  });
  let logical = compositionSession.parse(
    await rpc("composition.create", {
      projectId: "activity-project",
      title: "Same logical session",
      operationId: "logical",
    }),
  );
  const add = async (kind: CompositionEndpoint["kind"], agentId: string, owner = serverId) => {
    logical = compositionSession.parse(
      await rpc("composition.bind", {
        id: logical.id,
        expectedRevision: logical.revision,
        operationId: `bind-${kind}-${owner}`,
        endpoint: {
          kind,
          agentId,
          serverId: owner,
          provider: "example-tool",
          cwd: directory,
          workspaceId,
        },
      }),
    );
  };
  await add("terminal", terminal.terminal!.id);
  await add("desktop", desktop.terminal!.id);
  await add("web", "original-web-app");
  await add("terminal", terminal.terminal!.id, "different-server");
  const read = async () =>
    readCompositionActivity.output.parse(
      await rpc(readCompositionActivity.name, { id: logical.id }),
    );
  const active = await read();
  expect(active).toMatchObject({ sessionId: logical.id, serverId, runs: [], totalRuns: 0 });
  expect(active.endpoints.map((row) => [row.kind, row.state, row.readiness])).toEqual([
    ["terminal", "running", "unknown"],
    ["desktop", "external", "unknown"],
    ["web", "external", "unknown"],
  ]);
  expect(JSON.stringify(active)).not.toContain("PRIVATE_TERMINAL_TEXT");
  await writeFile(path.join(directory, "finish"), "finish owned fixture");
  await expect
    .poll(() =>
      context!.daemon.daemon.terminalManager?.getTerminalExitInfo?.(terminal.terminal!.id),
    )
    .toMatchObject({ exitCode: 0 });
  expect((await read()).endpoints.find((row) => row.kind === "terminal")?.state).toBe("closed");
  expect(await rpc("composition.read", { id: logical.id })).toEqual(logical);
  await expect(rpc(readCompositionActivity.name, { id: "missing-session" })).rejects.toThrow();
  await expect(rpc(readCompositionActivity.name, { id: logical.id, serverId })).rejects.toThrow();
}, 30_000);
