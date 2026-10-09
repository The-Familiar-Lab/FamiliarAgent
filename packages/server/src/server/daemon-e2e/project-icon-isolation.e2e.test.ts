import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import * as icons from "../../utils/project-icon-discovery.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { createPersistedProjectRecord } from "../workspace-registry.js";

test.skipIf(process.platform === "win32")(
  "restored projects with blocked icon syscalls do not stall filesystem plugin RPCs",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "familiar-icon-daemon-"));
    const home = path.join(root, ".paseo");
    const project = path.join(root, "project");
    const fifo = path.join(root, "blocked-icon-fs");
    const children: ChildProcess[] = [];
    const exits: Promise<unknown>[] = [];
    let context: DaemonTestContext | undefined;
    let queued!: () => void;
    const nativeIoQueued = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const discovery = new icons.ProjectIconDiscovery(() => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          [
            "const fs=require('node:fs');",
            "for(let i=0;i<4;i++)fs.open(process.argv[1],'r',()=>{});",
            "setTimeout(()=>process.stdout.write('queued'),50);",
          ].join(""),
          fifo,
        ],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", UV_THREADPOOL_SIZE: "4" },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      children.push(child);
      exits.push(once(child, "close"));
      child.stdout!.once("data", queued);
      return child;
    });
    const read = vi
      .spyOn(icons, "discoverProjectIcon")
      .mockImplementation((rootPath) => discovery.read(rootPath));
    try {
      await mkdir(project);
      await mkdir(path.join(home, "projects"), { recursive: true });
      await writeFile(
        path.join(home, "projects/projects.json"),
        JSON.stringify([
          createPersistedProjectRecord({
            projectId: "isolated-project-icon",
            rootPath: project,
            kind: "non_git",
            displayName: "Restored project",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ]),
      );
      execFileSync("mkfifo", [fifo]);
      vi.stubEnv("PASEO_HOME", home);
      context = await createDaemonTestContext({
        paseoHomeRoot: root,
        pluginsEnabled: true,
        builtinPlugins: new BuiltinPluginLoader(
          path.resolve(import.meta.dirname, "../../../../../plugins"),
          ["familiar-workspace"],
        ),
      });
      const projects = context.client.listProjects();
      await deadline(nativeIoQueued);
      const setup = (await deadline(
        context.client.invokePluginRpc("familiar-workspace", "tools.setup.workspace", {}),
      )) as { cwd: string };
      expect((await stat(setup.cwd)).isDirectory()).toBe(true);
      const catalog = await deadline(
        context.client.invokePluginRpc("familiar-workspace", "tools.list", {}),
      );
      expect(Array.isArray(catalog)).toBe(true);
      expect((catalog as unknown[]).length).toBeGreaterThan(0);
      const restored = await projects;
      expect(restored.projects).toContainEqual(
        expect.objectContaining({
          projectId: "isolated-project-icon",
          projectIconRevision: "automatic:none:v1",
        }),
      );
      expect(children).toHaveLength(1);
      expect(await Promise.all(exits)).toEqual([[null, "SIGKILL"]]);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.all(exits);
      await context?.cleanup();
      read.mockRestore();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Unrelated filesystem RPC stalled")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
