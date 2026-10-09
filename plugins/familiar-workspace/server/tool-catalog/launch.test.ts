import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { ToolCatalog } from "./service.js";
import { integratedRecipe } from "../integrated-tools/setup-recipes.js";
import { managedDesktopPath } from "./launch.js";

let root: string;
let cwd: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "familiar-original-launch-")));
  cwd = path.join(root, "project with ' spaces");
  await mkdir(cwd);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function catalog(platform: NodeJS.Platform = "linux") {
  return new ToolCatalog(root, { home: root, env: { PATH: path.join(root, "bin") }, platform });
}
async function binary(name: string) {
  const command = path.join(root, "bin", name);
  await mkdir(path.dirname(command), { recursive: true });
  await writeFile(command, "#!/bin/sh\nexit 91\n");
  await chmod(command, 0o700);
  return command;
}
async function managed(id: string) {
  const recipe = integratedRecipe(id, process.platform, process.arch)!;
  const directory = path.join(root, "tools", "native", `${id}-${recipe.version}`);
  for (const file of recipe.verify) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), "fixture");
  }
  await writeFile(
    path.join(directory, ".familiar-install.json"),
    JSON.stringify({ id, version: recipe.version }),
  );
  return directory;
}

describe("original interface selection", () => {
  it("prefers the existing editor with the selected folder while respecting explicit CLI selection", async () => {
    const command = await binary("cursor-agent");
    await mkdir(path.join(root, "Applications", "Cursor.app"), { recursive: true });
    const tools = catalog("darwin");
    expect((await tools.list()).find((tool) => tool.id === "cursor")?.launchSurface).toBe(
      "desktop",
    );
    const desktop = await tools.prepare({ id: "cursor", action: "launch", cwd });
    expect(desktop.mode).toBe("desktop");
    expect(desktop.args.at(-1)).toBe(cwd);
    const terminal = await tools.prepare({
      id: "cursor",
      action: "launch",
      cwd,
      surface: "terminal",
    });
    expect(terminal.mode).toBe("terminal");
    expect(terminal.args.at(-1)).toBe(command);
  });
  it("does not pass an unsupported folder to the original desktop or launch a desktop on Linux", async () => {
    for (const app of ["Orca.app", "Hydra.app", "Codeg.app"])
      await mkdir(path.join(root, "Applications", app), { recursive: true });
    const tools = catalog("darwin");
    for (const id of ["orca", "hydra", "codeg"]) {
      const plan = await tools.prepare({ id, action: "launch", cwd });
      expect(plan.mode).toBe("desktop");
      expect(plan.args).toHaveLength(2);
      expect(plan.notes.join(" ")).toContain("use the app's own actions");
      await expect(
        catalog().prepare({ id, action: "launch", cwd, surface: "desktop" }),
      ).rejects.toThrow("not installed");
    }
  });
  it.skipIf(process.platform !== "darwin")(
    "opens a managed desktop bundle without claiming it is a terminal or copying its project",
    async () => {
      await managed("alethe");
      const tools = catalog("darwin");
      expect(managedDesktopPath(root, "alethe", "darwin")).toContain("Alethe.app");
      const entry = (await tools.list()).find((tool) => tool.id === "alethe");
      expect(entry).toMatchObject({ installed: true, launchSurface: "desktop" });
      const plan = await tools.prepare({ id: "alethe", action: "launch", cwd });
      expect(plan.args).toHaveLength(2);
      expect(plan.cwd).toBe(cwd);
    },
  );
  it("routes command-only infrastructure to explicit native actions instead of an immediately exiting help command", async () => {
    const ids = ["firetower", "skulk", "bssh", "coder", "juicefs"];
    for (const id of ids) await binary(id);
    const tools = catalog();
    const entries = await tools.list();
    for (const id of ids) {
      expect(entries.find((tool) => tool.id === id)).toMatchObject({
        installed: true,
        launchSurface: "actions",
        modes: ["reference"],
      });
      await expect(tools.prepare({ id, action: "launch", cwd })).rejects.toThrow("Run actions");
    }
  });
  it("keeps explicit custom launch and web registrations authoritative", async () => {
    const tools = catalog();
    const command = await binary("configured");
    await tools.register({
      id: "coder",
      name: "Original",
      description: "",
      capabilities: [],
      launch: { command, args: ["--folder", "{{workspace}}"] },
    });
    const cli = await tools.prepare({ id: "coder", action: "launch", cwd });
    expect(cli.args.slice(-3)).toEqual([command, "--folder", cwd]);
    await tools.register({
      id: "coder",
      name: "Original",
      description: "",
      capabilities: [],
      url: "https://coder.example.test/workspaces",
    });
    expect((await tools.prepare({ id: "coder", action: "launch", cwd })).mode).toBe("web");
  });
  it("uses the original OpenHarness TUI and foreground superharness dashboard in the selected project", async () => {
    const harness = await binary("harness");
    const dashboard = await binary("superharness");
    const tools = catalog();
    const first = await tools.prepare({ id: "openharness", action: "launch", cwd });
    expect(first.args.slice(-2)).toEqual([harness, "tui"]);
    const second = await tools.prepare({ id: "superharness", action: "launch", cwd });
    expect(second.args.slice(-4)).toEqual([dashboard, "dashboard-ui", "--foreground", "--no-open"]);
    expect(second.cwd).toBe(cwd);
  });
  it("reuses the managed Codeg service plan with private credentials and the common session environment", async () => {
    const directory = await managed("codeg");
    const tools = catalog(process.platform);
    const contextPath = path.join(root, "context.md");
    await writeFile(contextPath, "session context");
    const plan = await tools.prepare({
      id: "codeg",
      action: "launch",
      surface: "terminal",
      cwd,
      contextPath,
      sessionId: "same-session",
    });
    expect(plan.mode).toBe("terminal");
    expect(plan.cwd).toBe(cwd);
    expect(plan.args[0]).toMatch(/^PATH=/u);
    expect(plan.args).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(plan.args).toContain("FAMILIAR_SESSION_ID=same-session");
    expect(plan.args).toContain(`FAMILIAR_CONTEXT_FILE=${contextPath}`);
    expect(plan.args.some((arg) => arg.startsWith(directory))).toBe(true);
    const token = await readFile(path.join(root, "familiar/native/codeg/familiar-token"), "utf8");
    expect(JSON.stringify(plan)).not.toContain(token.trim());
    expect(plan.notes.join(" ")).toContain("does not start an agent task");
  });
  it("reopens an existing managed Codeg web endpoint without requiring a custom URL or starting another service", async () => {
    await managed("codeg");
    const tools = catalog(process.platform);
    const first = await tools.prepare({ id: "codeg", action: "launch", surface: "terminal", cwd });
    expect(first.mode).toBe("terminal");
    const profile = path.join(root, "familiar/native/codeg");
    const token = (await readFile(path.join(profile, "familiar-token"), "utf8")).trim();
    const { port } = JSON.parse(await readFile(path.join(profile, "familiar-server.json"), "utf8"));
    const server = createServer((request, response) => {
      response.statusCode = request.headers.authorization === `Bearer ${token}` ? 200 : 401;
      response.end('{"status":"ok"}');
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      const reopened = await tools.prepare({ id: "codeg", action: "launch", surface: "web", cwd });
      expect(reopened).toMatchObject({
        mode: "web",
        url: `http://127.0.0.1:${port}`,
        cwd,
        args: [],
      });
      expect(reopened.command).toBeUndefined();
      expect(JSON.stringify(reopened)).not.toContain(token);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
