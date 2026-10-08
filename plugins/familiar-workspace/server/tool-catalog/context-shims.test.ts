import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { prepareContextShims } from "./context-shims.js";
import { registerToolCatalog } from "./register.js";
import { ToolCatalog } from "./service.js";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ToolPlan } from "../../shared/tool-catalog.js";

let root: string;
let bin: string;
let sharedFile: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "familiar-child-"));
  const special = path.join(root, "native ' ; $(false)");
  await mkdir(special);
  const command = path.join(special, "agent");
  const source = path.join(root, "native.cjs");
  await writeFile(
    source,
    "console.log(JSON.stringify({args:process.argv.slice(2),session:process.env.FAMILIAR_SESSION_ID,context:process.env.FAMILIAR_CONTEXT_FILE,path:process.env.PATH}));",
  );
  await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${source}' "$@"\n`);
  await chmod(command, 0o700);
  sharedFile = path.join(root, "context.json");
  await writeFile(
    sharedFile,
    JSON.stringify({
      mcpServers: { familiar_context: { command: "/usr/bin/true", args: ["session-A"] } },
    }),
  );
  bin = await prepareContextShims({
    root,
    sessionId: "session-A",
    contextPath: path.join(root, "context.md"),
    searchPath: "/usr/bin:/bin",
    executables: { claude: command, codex: command, tmux: command },
    claudeArgs: ["--mcp-config", sharedFile],
    codexArgs: ["-c", 'mcp_servers.familiar_context.command="/usr/bin/true"'],
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it("routes direct registered Claude and Codex commands through the same conflict checks without double injection", async () => {
  vi.stubEnv("PASEO_CLI", "/usr/bin/true");
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  registerToolCatalog(
    {
      handle: (rpc: { name: string }, handler: (input: unknown) => Promise<unknown>) =>
        handlers.set(rpc.name, handler),
      before: () => {},
    } as unknown as PluginServerContext,
    root,
  );
  const tools = new ToolCatalog(root);
  const native = path.join(root, "native ' ; $(false)", "agent");
  const own = path.join(root, "own-direct.json");
  await writeFile(own, JSON.stringify({ mcpServers: { own: { command: "native" } } }));
  for (const id of ["claude", "codex"]) {
    const args = id === "claude" ? ["--mcp-config", own, "--print"] : ["exec", "test prompt"];
    await tools.register({
      id,
      name: id,
      capabilities: [],
      description: "",
      launch: { command: native, args },
    });
    const plan = (await handlers.get("tools.prepare")!({
      id,
      cwd: root,
      action: "launch",
      surface: "terminal",
      sessionId: "direct-session",
    })) as ToolPlan;
    const result = JSON.parse(execFileSync(plan.command!, plan.args, { encoding: "utf8" }));
    expect(result.session).toBe("direct-session");
    if (id === "claude") {
      expect(result.args.filter((arg: string) => arg === "--mcp-config")).toHaveLength(1);
      expect(result.args).toContain(own);
      await writeFile(
        own,
        JSON.stringify({ mcpServers: { familiar_context: { command: "conflict" } } }),
      );
      const failed = spawnSync(plan.command!, plan.args, { encoding: "utf8" });
      expect(failed.status).not.toBe(0);
      expect(failed.stdout).toBe("");
    } else {
      expect(
        result.args.filter((arg: string) =>
          arg.startsWith("mcp_servers.familiar_context.command="),
        ),
      ).toHaveLength(1);
      expect(result.args.slice(-2)).toEqual(["exec", "test prompt"]);
    }
  }
});
it("adds Goose's native session extension without replacing its profile and rejects incompatible overrides", async () => {
  vi.stubEnv("PASEO_CLI", "/usr/bin/true");
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  registerToolCatalog(
    {
      handle: (rpc: { name: string }, handler: (input: unknown) => Promise<unknown>) =>
        handlers.set(rpc.name, handler),
      before: () => {},
    } as unknown as PluginServerContext,
    root,
  );
  const tools = new ToolCatalog(root);
  const register = (args: string[]) =>
    tools.register({
      id: "goose",
      name: "Goose",
      capabilities: [],
      description: "",
      launch: { command: path.join(root, "native ' ; $(false)", "agent"), args },
    });
  const prepare = () =>
    handlers.get("tools.prepare")!({
      id: "goose",
      cwd: root,
      action: "launch",
      surface: "terminal",
      sessionId: "goose-session",
    }) as Promise<ToolPlan>;
  await register(["session", "--with-extension", "own:/usr/bin/true"]);
  const plan = await prepare();
  const result = JSON.parse(execFileSync(plan.command!, plan.args, { encoding: "utf8" }));
  expect(result.args.slice(0, 3)).toEqual(["session", "--with-extension", "own:/usr/bin/true"]);
  expect(result.args[3]).toBe("--with-extension");
  expect(result.args[4]).toMatch(/^familiar_context:/);
  expect(result.args).not.toContain("--no-profile");
  expect(plan.args).toContain("FAMILIAR_MCP_CLI=/usr/bin/true");
  expect(result.session).toBe("goose-session");
  for (const args of [
    ["session", "--with-extension", "FAMILIAR_CONTEXT:/other"],
    ["run", "--with-extension=familiar_context:/other"],
    ["session", "--container=other"],
    ["session", "list"],
  ]) {
    await register(args);
    await expect(prepare()).rejects.toThrow();
  }
});
function run(provider: string, args: string[]) {
  return JSON.parse(execFileSync(path.join(bin, provider), args, { encoding: "utf8" }));
}
it("preserves prompt arguments and exports the selected session without shell expansion", () => {
  const result = run("claude", ["a ' ; $(touch bad)", "--verbose"]);
  expect(result.args).toEqual(["a ' ; $(touch bad)", "--verbose", "--mcp-config", sharedFile]);
  expect(result.session).toBe("session-A");
  expect(result.context).toBe(path.join(root, "context.md"));
  expect(result.path).toBe(`${bin}:/usr/bin:/bin`);
  expect(run("codex", ["exec", "one two"]).args.slice(-2)).toEqual(["exec", "one two"]);
});
it("preserves native help, authentication and MCP administration utilities", () => {
  for (const provider of ["claude", "codex"]) {
    for (const args of [["--help"], ["login"], ["mcp", "list"]])
      expect(run(provider, args).args).toEqual(args);
  }
});
it("merges an explicit Claude MCP config and rejects shared-name collisions", async () => {
  const own = path.join(root, "own.json");
  await writeFile(own, JSON.stringify({ mcpServers: { own: { command: "native" } } }));
  expect(run("claude", ["--mcp-config", own, "--", "prompt"]).args).toEqual([
    "--mcp-config",
    own,
    sharedFile,
    "--",
    "prompt",
  ]);
  expect(run("claude", [`--mcp-config=${own}`, "--print"]).args).toEqual([
    `--mcp-config=${own}`,
    sharedFile,
    "--print",
  ]);
  await writeFile(
    own,
    JSON.stringify({ mcpServers: { familiar_context: { command: "different" } } }),
  );
  const conflict = spawnSync(path.join(bin, "claude"), ["--mcp-config", own], { encoding: "utf8" });
  expect(conflict.status).not.toBe(0);
  expect(conflict.stderr).toContain("conflicts with this FamiliarAgent session");
  expect(JSON.parse(await readFile(own, "utf8")).mcpServers.familiar_context.command).toBe(
    "different",
  );
});
it("rejects Codex reserved config overrides while preserving other provider settings", () => {
  for (const args of [
    ["-c", 'mcp_servers.familiar_context.command="bad"'],
    ['--config=mcp_servers."familiar_context".args=[]'],
    ["-cmcp_servers={}"],
  ]) {
    expect(spawnSync(path.join(bin, "codex"), args).status).not.toBe(0);
  }
  expect(run("codex", ["-c", 'mcp_servers.other.command="native"']).args).toContain(
    'mcp_servers.other.command="native"',
  );
});
it("passes context to new Squad tmux sessions without changing other tmux commands", () => {
  const result = run("tmux", ["new-session", "-d", "-s", "one", "claude"]);
  expect(result.args.slice(0, 3)).toEqual(["new-session", "-e", `PATH=${bin}:/usr/bin:/bin`]);
  expect(result.args).toContain("FAMILIAR_SESSION_ID=session-A");
  expect(result.args.slice(-4)).toEqual(["-d", "-s", "one", "claude"]);
  expect(run("tmux", ["list-sessions"]).args).toEqual(["list-sessions"]);
});
