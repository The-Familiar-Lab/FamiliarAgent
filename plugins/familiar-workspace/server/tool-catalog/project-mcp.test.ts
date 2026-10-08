import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { ResourceLibrary } from "./resources.js";
import { registerToolCatalog } from "./register.js";
import { ToolCatalog } from "./service.js";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ToolPlan } from "../../shared/tool-catalog.js";

let root: string;
let project: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "familiar-editor-mcp-")));
  project = path.join(root, "project");
  await mkdir(project);
  vi.stubEnv("PASEO_CLI", "/usr/bin/true");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it("uses each documented project schema and preserves foreign JSONC comments, inputs and credentials", async () => {
  for (const [toolId, folder, key] of [
    ["cursor", ".cursor", "mcpServers"],
    ["vscode", ".vscode", "servers"],
  ] as const) {
    const file = path.join(project, folder, "mcp.json");
    await mkdir(path.dirname(file));
    await writeFile(
      file,
      `{// retained workspace note\n "${key}": {"existing":{"url":"https://example.test/mcp","headers":{"Authorization":"test-credential"}},},\n "inputs":[{"id":"existing-input","type":"promptString"}],\n}\n`,
    );
    const resources = new ResourceLibrary(root);
    expect(await resources.projectEditor({ cwd: project, toolId, sessionId: "session-A" })).toEqual(
      { file, status: "added" },
    );
    const text = await readFile(file, "utf8");
    expect(text).toContain("// retained workspace note");
    expect(parse(text)[key].existing.headers.Authorization).toBe("test-credential");
    expect(parse(text).inputs).toEqual([{ id: "existing-input", type: "promptString" }]);
    expect(parse(text)[key].familiar_context).toEqual({
      type: "stdio",
      command: "/usr/bin/true",
      args: ["context", "mcp", "--home", root, "--session", "session-A"],
      env: { PASEO_HOME: root },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await resources.projectEditor({ cwd: project, toolId, sessionId: "session-A" })).toEqual(
      { file, status: "unchanged" },
    );
    expect(await readFile(file, "utf8")).toBe(text);
  }
});
it("preserves another session or foreign same-name connection and rejects malformed or duplicate settings", async () => {
  const resources = new ResourceLibrary(root);
  const { file } = await resources.projectEditor({
    cwd: project,
    toolId: "cursor",
    sessionId: "first",
  });
  const first = await readFile(file, "utf8");
  await expect(
    resources.projectEditor({ cwd: project, toolId: "cursor", sessionId: "second" }),
  ).rejects.toThrow("already has a different");
  expect(await readFile(file, "utf8")).toBe(first);
  for (const original of [
    '{"mcpServers":{"familiar_context":{"command":"foreign"}}}',
    "{broken",
    '{"mcpServers":[]}',
    '{"mcpServers":{},"mcpServers":{}}',
    '{"mcpServers":{"familiar_context":{},"familiar_context":{}}}',
  ]) {
    await writeFile(file, original);
    await expect(
      resources.projectEditor({ cwd: project, toolId: "cursor", sessionId: "first" }),
    ).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(original);
  }
});
it("does not project through a linked folder or file", async () => {
  const resources = new ResourceLibrary(root);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(project, ".cursor"));
  await expect(
    resources.projectEditor({ cwd: project, toolId: "cursor", sessionId: "one" }),
  ).rejects.toThrow("symbolic link");
  const target = path.join(outside, "mcp.json");
  await writeFile(target, "{}");
  await mkdir(path.join(project, ".vscode"));
  await symlink(target, path.join(project, ".vscode", "mcp.json"));
  await expect(
    resources.projectEditor({ cwd: project, toolId: "vscode", sessionId: "one" }),
  ).rejects.toThrow("regular file");
  expect(await readFile(target, "utf8")).toBe("{}");
});
it("creates one selected-session connection only when preparing a supported desktop launch", async () => {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  registerToolCatalog(
    {
      handle: (rpc: { name: string }, handler: (input: unknown) => Promise<unknown>) =>
        handlers.set(rpc.name, handler),
      before: () => {},
    } as unknown as PluginServerContext,
    root,
  );
  vi.spyOn(ToolCatalog.prototype, "prepare").mockImplementation(async (input) => ({
    toolId: input.id,
    action: input.action,
    mode: input.surface === "terminal" ? "terminal" : "desktop",
    cwd: project,
    command: "/usr/bin/open",
    args: [],
    notes: [],
  }));
  const prepare = handlers.get("tools.prepare")!;
  await prepare({ id: "vscode", action: "launch", cwd: project, surface: "desktop" });
  await expect(stat(path.join(project, ".vscode", "mcp.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const result = (await prepare({
    id: "vscode",
    action: "launch",
    cwd: project,
    surface: "desktop",
    sessionId: "chosen",
  })) as ToolPlan;
  expect(result.notes.join(" ")).toContain("Codex extension");
  expect(
    parse(await readFile(path.join(project, ".vscode", "mcp.json"), "utf8")).servers
      .familiar_context.args,
  ).toContain("chosen");
  await prepare({
    id: "antigravity-ide",
    action: "launch",
    cwd: project,
    surface: "desktop",
    sessionId: "chosen",
  });
  await expect(stat(path.join(project, ".gemini"))).rejects.toMatchObject({ code: "ENOENT" });
});
