import { afterEach, expect, test, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
let context: DaemonTestContext | undefined;
let other: DaemonClient | undefined;
let root: string | undefined;
afterEach(async () => {
  await other?.close();
  await context?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
test("two real clients share plugin state, reject stale writes and transfer verified bytes", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "familiar-rpc-"));
  vi.stubEnv("PASEO_HOME", path.join(root, ".paseo"));
  context = await createDaemonTestContext({
    paseoHomeRoot: root,
    daemonVersion: "0.11.1",
    pluginsEnabled: true,
    builtinPlugins: new BuiltinPluginLoader(
      path.resolve(import.meta.dirname, "../../../../../plugins"),
      ["familiar-workspace"],
    ),
  });
  other = new DaemonClient({ url: `ws://127.0.0.1:${context.daemon.port}/ws` });
  await other.connect();
  // First use has no project/cwd or native provider initialization prerequisite.
  const emptyCatalog = await context.client.invokePluginRpc(
    "familiar-workspace",
    "composition.list",
    {},
  );
  expect(emptyCatalog).toMatchObject({ projects: [], sessions: [], total: 0 });
  const setupWorkspace = await context.client.invokePluginRpc(
    "familiar-workspace",
    "tools.setup.workspace",
    {},
  );
  const setupDirectory = path.join(root, ".paseo/familiar/tool-setup");
  expect(setupWorkspace).toEqual({ cwd: setupDirectory });
  const setupInfo = await stat(setupDirectory);
  expect(setupInfo.isDirectory()).toBe(true);
  if (process.platform !== "win32") expect(setupInfo.mode & 0o777).toBe(0o700);
  expect(await readdir(setupDirectory)).toEqual([]);
  const marker = path.join(setupDirectory, "owned-installer-state.txt");
  await writeFile(marker, "Preserve existing setup work");
  expect(await other.invokePluginRpc("familiar-workspace", "tools.setup.workspace", {})).toEqual(
    setupWorkspace,
  );
  expect(await readFile(marker, "utf8")).toBe("Preserve existing setup work");
  expect(await other.invokePluginRpc("familiar-workspace", "composition.list", {})).toEqual(
    emptyCatalog,
  );
  await expect(
    other.invokePluginRpc("familiar-workspace", "tools.setup.workspace", {
      cwd: "/untrusted-override",
    }),
  ).rejects.toThrow();
  const first = await context.client.invokePluginRpc("familiar-workspace", "space.read", {
    id: "rpc-test",
  });
  expect(first).toMatchObject({ revision: 0, notes: "" });
  const saved = await context.client.invokePluginRpc("familiar-workspace", "space.save", {
    ...(first as object),
    notes: "Shared between two native clients",
  });
  expect(saved).toMatchObject({ revision: 1 });
  expect(
    await other.invokePluginRpc("familiar-workspace", "space.read", { id: "rpc-test" }),
  ).toEqual(saved);
  await expect(other.invokePluginRpc("familiar-workspace", "space.save", first)).rejects.toThrow(
    "Revision conflict",
  );
  const bytes = Buffer.from("artifact 한글\n");
  const input = {
    name: "test.txt",
    base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  expect(await other.invokePluginRpc("familiar-workspace", "artifact.put", input)).toMatchObject({
    size: bytes.length,
    sha256: input.sha256,
  });
  await expect(
    other.invokePluginRpc("familiar-workspace", "artifact.put", {
      ...input,
      sha256: "0".repeat(64),
    }),
  ).rejects.toThrow("checksum");
  const recipe = await other.invokePluginRpc("familiar-workspace", "provider.setup", {
    provider: "codex",
  });
  expect(recipe).toMatchObject({
    command: "/bin/sh",
    cwd: path.join(root, ".paseo/familiar/provider-setup"),
  });
  await expect(
    other.invokePluginRpc("familiar-workspace", "provider.setup", { provider: "codex; evil" }),
  ).rejects.toThrow();
  const setup = await other.invokePluginRpc("familiar-workspace", "tools.setup.status", {
    id: "aider",
  });
  expect(setup).toMatchObject({ toolId: "aider", account: "not-checked" });
  await expect(
    other.invokePluginRpc("familiar-workspace", "tools.setup.prepare", {
      id: "aider",
      action: "api-key",
      provider: "openai",
      key: "must-not-be-accepted",
    }),
  ).rejects.toThrow();
  const source = path.join(root, "original-skill");
  const project = path.join(root, "skill-project");
  await mkdir(source);
  await mkdir(project);
  const original = "# Native shared skill\n" + "Keep the source intact.\n".repeat(100);
  await writeFile(path.join(source, "SKILL.md"), original);
  expect(
    await context.client.invokePluginRpc("familiar-workspace", "resources.list", {}),
  ).toMatchObject({ revision: 0, skills: [] });
  expect(
    await context.client.invokePluginRpc("familiar-workspace", "resources.use-skills", {
      expectedRevision: 0,
      skills: [{ id: "review", path: source, enabled: true }],
    }),
  ).toMatchObject({ status: "added", resources: { revision: 1, skills: [{ id: "review" }] } });
  expect(
    await other.invokePluginRpc("familiar-workspace", "resources.skill.read", {
      id: "review",
      maxCharacters: 256,
    }),
  ).toMatchObject({ text: original.slice(0, 256), truncated: true });
  const ownerId = (await readFile(path.join(root, ".paseo/server-id"), "utf8")).trim();
  await context.client.invokePluginRpc("familiar-workspace", "composition.project.save", {
    id: "selected-skills",
    operationId: "project-select",
    expectedRevision: 0,
    title: "Selected skills",
    memory: "Shared project note",
    resources: [],
  });
  const selected = (await context.client.invokePluginRpc(
    "familiar-workspace",
    "composition.create",
    {
      operationId: "session-select",
      projectId: "selected-skills",
      title: "A",
      resources: [
        {
          id: "selected-review",
          kind: "skill",
          format: "path",
          locator: "review",
          label: "Review",
          serverId: ownerId,
          readOnly: true,
        },
      ],
    },
  )) as { id: string };
  expect(
    await other.invokePluginRpc("familiar-workspace", "composition.resource.read", {
      id: selected.id,
      resourceId: "selected-review",
      maxCharacters: 256,
    }),
  ).toMatchObject({ messages: [{ role: "skill", text: original.slice(0, 256) }], truncated: true });
  await other.invokePluginRpc("familiar-workspace", "composition.update", {
    id: selected.id,
    operationId: "disable-selected",
    expectedRevision: 1,
    title: "A",
    memory: "",
    resources: [],
    memoryEnabled: false,
  });
  expect(
    await context.client.invokePluginRpc("familiar-workspace", "composition.context", {
      id: selected.id,
    }),
  ).toMatchObject({ memories: [], resources: [] });
  await expect(
    context.client.invokePluginRpc("familiar-workspace", "composition.resource.read", {
      id: selected.id,
      resourceId: "selected-review",
    }),
  ).rejects.toThrow();
  await expect(
    other.invokePluginRpc("familiar-workspace", "resources.skill.change", {
      id: "review",
      action: "disable",
      expectedRevision: 0,
    }),
  ).rejects.toThrow("changed");
  await context.client.invokePluginRpc("familiar-workspace", "resources.project", {
    cwd: project,
    toolId: "claude",
    expectedRevision: 1,
  });
  const linked = path.join(await realpath(project), ".claude", "skills", "review");
  expect(await readlink(linked)).toBe(await realpath(source));
  expect(
    await other.invokePluginRpc("familiar-workspace", "resources.skill.change", {
      id: "review",
      action: "remove",
      expectedRevision: 1,
    }),
  ).toMatchObject({ revision: 2, skills: [] });
  expect(
    await context.client.invokePluginRpc("familiar-workspace", "resources.project", {
      cwd: project,
      toolId: "claude",
      expectedRevision: 2,
    }),
  ).toMatchObject({ removed: [linked] });
  expect(await readFile(path.join(source, "SKILL.md"), "utf8")).toBe(original);
}, 30000);
