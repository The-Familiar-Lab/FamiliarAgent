import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ResourceLibrary, ToolCatalog } from "./index.js";
import {
  prepareTool,
  toolPlan,
  toolRegistration,
  useHttpResource,
} from "../../shared/tool-catalog.js";

let root: string;
let project: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "familiar-tools-")));
  project = path.join(root, "project");
  await mkdir(project);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function binary(name: string) {
  const file = path.join(root, "bin", name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\nprintf must-not-run\n");
  await chmod(file, 0o700);
  return file;
}
function catalog() {
  return new ToolCatalog(root, {
    home: root,
    env: { PATH: path.join(root, "bin") },
    platform: "linux",
  });
}
describe("explicit HTTP MCP use on another server", () => {
  const entry = {
    id: "shared-search",
    type: "http" as const,
    url: "https://mcp.example.test/service",
    enabled: true,
  };
  it("adds one connection, retains existing resources and does not rewrite an identical entry", async () => {
    const library = new ResourceLibrary(root);
    const source = await skill("retained");
    await library.save({
      revision: 0,
      skills: [{ id: "retained", path: source, enabled: true }],
      mcp: [{ id: "native", type: "stdio", command: "original", args: [], enabled: false }],
    });
    const first = await library.useHttp({ expectedRevision: 1, entry });
    expect(first.status).toBe("added");
    expect(first.resources.revision).toBe(2);
    expect(first.resources.skills).toEqual([{ id: "retained", path: source, enabled: true }]);
    expect(first.resources.mcp[0]).toMatchObject({
      id: "native",
      command: "original",
      enabled: false,
    });
    const again = await library.useHttp({ expectedRevision: 2, entry });
    expect(again).toEqual({ status: "unchanged", resources: first.resources });
  });
  it("preserves different settings and rejects concurrent or stale edits", async () => {
    const library = new ResourceLibrary(root);
    await library.useHttp({ expectedRevision: 0, entry });
    await expect(library.useHttp({ expectedRevision: 0, entry })).rejects.toThrow("changed");
    await expect(
      library.useHttp({
        expectedRevision: 1,
        entry: { ...entry, url: "https://other.example.test/mcp" },
      }),
    ).rejects.toThrow("preserved");
    const results = await Promise.allSettled(
      ["one", "two"].map((id) => library.useHttp({ expectedRevision: 1, entry: { ...entry, id } })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await library.list()).mcp.find((item) => item.id === entry.id)).toEqual(entry);
  });
  it("refuses local addresses, reserved names, stdio and credential-bearing fields", async () => {
    const library = new ResourceLibrary(root);
    for (const url of [
      "http://localhost:1000/mcp",
      "http://LOCALHOST./mcp",
      "http://a.localhost/mcp",
      "http://127.2.3.4/mcp",
      "http://127.1/mcp",
      "http://2130706433/mcp",
      "http://0.0.0.0/mcp",
      "http://[::]/mcp",
      "http://[::1]/mcp",
      "http://[::ffff:127.0.0.1]/mcp",
      "http://[::ffff:0.0.0.0]/mcp",
    ]) {
      await expect(
        library.useHttp({ expectedRevision: 0, entry: { ...entry, url } }),
      ).rejects.toThrow("reachable");
    }
    await expect(
      library.useHttp({ expectedRevision: 0, entry: { ...entry, id: "familiar_context" } }),
    ).rejects.toThrow("reserved");
    for (const invalid of [
      { ...entry, headers: { Authorization: "secret" } },
      { ...entry, env: { TOKEN: "secret" } },
      { id: "local", type: "stdio", command: "server", args: [], enabled: true },
      { ...entry, url: "https://user:secret@example.test/mcp" },
    ]) {
      expect(useHttpResource.input.safeParse({ expectedRevision: 0, entry: invalid }).success).toBe(
        false,
      );
    }
    expect((await library.list()).revision).toBe(0);
  });
});
async function skill(name: string) {
  const file = path.join(root, "sources", name);
  await mkdir(file, { recursive: true });
  await writeFile(path.join(file, "SKILL.md"), `# ${name}\n`);
  return file;
}

describe("native tool catalog", () => {
  it("distinguishes the ChatGPT conversation app, Codex app and project-capable editors without launching them", async () => {
    const apps = {
      chatgpt: "ChatGPT Classic.app",
      codex: "ChatGPT.app",
      vscode: "Visual Studio Code.app",
      "antigravity-ide": "Antigravity IDE.app",
    };
    for (const app of Object.values(apps))
      await mkdir(path.join(root, "Applications", app), { recursive: true });
    const tools = new ToolCatalog(root, {
      home: root,
      env: { PATH: path.join(root, "bin") },
      platform: "darwin",
    });
    const entries = await tools.list();
    for (const [id, app] of Object.entries(apps)) {
      expect(entries.find((item) => item.id === id)).toMatchObject({
        installed:
          id === "codex" ? Boolean(entries.find((item) => item.id === id)?.executablePath) : true,
        modes: expect.arrayContaining(["desktop"]),
      });
      const plan = await tools.prepare({ id, action: "launch", surface: "desktop", cwd: project });
      expect(plan.command).toBe("/usr/bin/open");
      expect(path.basename(plan.args[1]!)).toBe(app);
      if (id === "chatgpt" || id === "codex") {
        expect(plan.args).toHaveLength(2);
        expect(plan.notes.join(" ")).toContain("No conversation is automatically imported");
      } else expect(plan.args[2]).toBe(project);
    }
    const linux = await catalog().list();
    for (const id of ["chatgpt", "vscode", "antigravity-ide"])
      expect(linux.find((item) => item.id === id)).toMatchObject({
        installed: false,
        modes: ["reference"],
      });
  });
  it("keeps desktop opening available without treating an app folder as its missing agent CLI", async () => {
    const tools = new ToolCatalog(root, {
      home: root,
      env: { PATH: path.join(root, "bin") },
      platform: "darwin",
    });
    for (const [id, app] of [
      ["codex", "ChatGPT.app"],
      ["cursor", "Cursor.app"],
      ["antigravity", "Antigravity.app"],
    ]) {
      await mkdir(path.join(root, "Applications", app!), { recursive: true });
      const command = path.join(root, "missing", id!);
      const entry = await tools.register({
        id: id!,
        name: id!,
        capabilities: [],
        description: "",
        launch: { command, args: [] },
      });
      expect(entry).toMatchObject({
        installed: false,
        executablePath: undefined,
        modes: expect.arrayContaining(["desktop", "terminal"]),
      });
      expect(
        (await tools.prepare({ id: id!, action: "launch", surface: "desktop", cwd: project }))
          .command,
      ).toBe("/usr/bin/open");
      await expect(
        tools.prepare({ id: id!, action: "launch", surface: "terminal", cwd: project }),
      ).rejects.toThrow("not installed");
      await mkdir(path.dirname(command), { recursive: true });
      await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      expect((await tools.list()).find((item) => item.id === id)).toMatchObject({
        installed: true,
        executablePath: command,
      });
    }
  });
  it("detects installed executables without spawning them and does not claim reference-only integrations", async () => {
    const aider = await binary("aider");
    const entries = await catalog().list();
    expect(entries.find((entry) => entry.id === "aider")).toMatchObject({
      installed: true,
      executablePath: aider,
      modes: ["terminal"],
    });
    expect(entries.find((entry) => entry.id === "hydra")).toMatchObject({
      installed: false,
      modes: ["reference"],
    });
    expect(entries.find((entry) => entry.id === "codex")).toMatchObject({
      installed: false,
      nativeProvider: "codex",
    });
  });
  it("keeps untrusted project and context text in separate argv entries", async () => {
    const command = await binary("custom-agent");
    const contextPath = path.join(project, "$(touch stolen); history.md");
    await writeFile(contextPath, "context");
    await catalog().register({
      id: "custom",
      name: "Custom",
      capabilities: ["orchestration"],
      description: "",
      launch: { command, args: ["--context", "{{context}}", "{{workspace}}"] },
    });
    const plan = await catalog().prepare({
      id: "custom",
      cwd: project,
      action: "launch",
      contextPath,
    });
    expect(plan.command).toBe("/usr/bin/env");
    expect(plan.args.slice(1)).toEqual([
      `FAMILIAR_CONTEXT_FILE=${contextPath}`,
      command,
      "--context",
      contextPath,
      project,
    ]);
    expect(toolPlan.parse(plan)).toEqual(plan);
    await expect(access(path.join(project, "stolen"))).rejects.toThrow();
  });
  it("resolves Aider context using its actual read-only file option", async () => {
    const command = await binary("aider");
    const contextPath = path.join(project, "history.md");
    await writeFile(contextPath, "archive");
    const plan = await catalog().prepare({
      id: "aider",
      cwd: project,
      action: "launch",
      contextPath,
    });
    expect(plan.args.slice(1)).toEqual([
      `FAMILIAR_CONTEXT_FILE=${contextPath}`,
      command,
      "--read",
      contextPath,
    ]);
  });
  it("prepares isolated installers and reports missing prerequisites", async () => {
    const npm = await binary("npm");
    const plan = await catalog().prepare({ id: "openrig", cwd: project, action: "install" });
    expect(plan.command).toBe(npm);
    expect(plan.args).toContain("@openrig/cli");
    expect(plan.args).toContain(path.join(root, "tools", "node"));
    await expect(
      catalog().prepare({ id: "aider", cwd: project, action: "install" }),
    ).rejects.toThrow("Python 3, uv or pipx");
    const uv = await binary("uv");
    const python = await catalog().prepare({ id: "aider", cwd: project, action: "install" });
    expect(python.args).toContain(uv);
    expect(python.args).toContain(`UV_TOOL_BIN_DIR=${path.join(root, "tools", "bin")}`);
  });
  it("writes bounded private context with stable session references", async () => {
    const first = await catalog().context({
      sessionId: "session/../../A",
      text: "Native source: server-1 / session-A",
    });
    expect(first.path.startsWith(path.join(root, "familiar", "tool-contexts"))).toBe(true);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
    const second = await catalog().context({
      sessionId: "session/../../A",
      text: "Updated shared context",
    });
    expect(second.path).toBe(first.path);
    expect(second.sha256).not.toBe(first.sha256);
    await expect(catalog().context({ sessionId: "A", text: "한".repeat(6000) })).rejects.toThrow(
      "16 KiB",
    );
    expect(await readFile(second.path, "utf8")).toBe("Updated shared context");
  });
  it("installs the declared native Python SDK dependency through uv and the private bootstrap fallback", async () => {
    const uv = await binary("uv");
    const plan = await catalog().prepare({ id: "superharness", cwd: project, action: "install" });
    expect(plan.args).toContain(uv);
    expect(plan.args.slice(-2)).toEqual(["--with", "claude-agent-sdk==0.2.165"]);
    await rm(uv);
    await binary("pipx");
    await binary("python3");
    const fallback = await catalog().prepare({
      id: "superharness",
      cwd: project,
      action: "install",
    });
    expect(fallback.command).toBe("/bin/sh");
    expect(fallback.args.slice(-2)).toEqual(["--with", "claude-agent-sdk==0.2.165"]);
    expect(fallback.args[1]).toContain('shift 7; exec "$FAMILIAR_INSTALL_UV"');
  });
  it("persists URL registrations, keeps URL reachability unclaimed and removes overrides", async () => {
    const entry = await catalog().register({
      id: "openrig",
      name: "My OpenRig",
      description: "",
      capabilities: [],
      url: "http://127.0.0.1:12345",
    });
    expect(entry.installed).toBe(false);
    expect(entry.modes).toContain("web");
    const plan = await catalog().prepare({
      id: "openrig",
      action: "launch",
      cwd: project,
      surface: "web",
    });
    expect(plan.url).toBe("http://127.0.0.1:12345");
    expect(plan.command).toBeUndefined();
    expect(await catalog().remove("openrig")).toEqual({ removed: true });
    expect((await catalog().list()).find((item) => item.id === "openrig")?.name).toBe("OpenRig");
  });
  it("rejects unsafe URL schemes, credentials, control characters and missing context", async () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:secret@example.com",
    ])
      expect(toolRegistration.safeParse({ id: "bad", name: "Bad", url }).success).toBe(false);
    expect(
      prepareTool.input.safeParse({ id: "aider", action: "launch", cwd: "/tmp\0x" }).success,
    ).toBe(false);
    const command = await binary("custom");
    await catalog().register({
      id: "custom",
      name: "Custom",
      description: "",
      capabilities: [],
      launch: { command, args: ["{{context}}"] },
    });
    await expect(
      catalog().prepare({ id: "custom", action: "launch", cwd: project }),
    ).rejects.toThrow("requires a context");
    await expect(
      catalog().prepare({ id: "aider", action: "launch", cwd: "relative" }),
    ).rejects.toThrow("absolute");
  });
});

describe("shared resources", () => {
  it("shares source skills by reference, sees edits immediately and removes only managed links", async () => {
    const library = new ResourceLibrary(root);
    const source = await skill("testing");
    await library.save({
      revision: 0,
      skills: [{ id: "testing", path: source, enabled: true }],
      mcp: [],
    });
    const output = await library.project({ cwd: project, toolId: "claude" });
    const target = path.join(project, ".claude", "skills", "testing");
    expect(output.paths).toEqual([target]);
    expect(await readlink(target)).toBe(source);
    await writeFile(path.join(source, "SKILL.md"), "updated source");
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe("updated source");
    expect((await library.project({ cwd: project, toolId: "claude" })).unchanged).toEqual([target]);
    expect(
      (await library.project({ cwd: project, toolId: "claude", remove: true })).removed,
    ).toEqual([target]);
    expect(await readFile(path.join(source, "SKILL.md"), "utf8")).toBe("updated source");
  });
  it("preserves user-created matching links when projection is removed", async () => {
    const library = new ResourceLibrary(root);
    const source = await skill("testing");
    const target = path.join(project, ".agents", "skills", "testing");
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(source, target);
    await library.save({
      revision: 0,
      skills: [{ id: "testing", path: source, enabled: true }],
      mcp: [],
    });
    expect((await library.project({ cwd: project, toolId: "codex" })).unchanged).toEqual([target]);
    expect(
      (await library.project({ cwd: project, toolId: "codex", remove: true })).removed,
    ).toEqual([]);
    expect(await readlink(target)).toBe(source);
  });
  it("reports conflicts before applying any changes and preserves edited links", async () => {
    const library = new ResourceLibrary(root);
    const first = await skill("first");
    const second = await skill("second");
    const nativeRoot = path.join(project, ".cursor", "skills");
    await mkdir(path.join(nativeRoot, "second"), { recursive: true });
    await writeFile(path.join(nativeRoot, "second", "SKILL.md"), "user-owned");
    await library.save({
      revision: 0,
      skills: [
        { id: "first", path: first, enabled: true },
        { id: "second", path: second, enabled: true },
      ],
      mcp: [],
    });
    const result = await library.project({ cwd: project, toolId: "cursor" });
    expect(result.conflicts).toHaveLength(1);
    expect(result.paths).toEqual([]);
    await expect(access(path.join(nativeRoot, "first"))).rejects.toThrow();
    expect(await readFile(path.join(nativeRoot, "second", "SKILL.md"), "utf8")).toBe("user-owned");
  });
  it("does not traverse native projection directory symlinks", async () => {
    const library = new ResourceLibrary(root);
    const source = await skill("test");
    await library.save({
      revision: 0,
      skills: [{ id: "test", path: source, enabled: true }],
      mcp: [],
    });
    await symlink(path.join(root, "sources"), path.join(project, ".claude"));
    await expect(library.project({ cwd: project, toolId: "claude" })).rejects.toThrow(
      "symbolic link",
    );
  });
  it("replaces a managed source and retires disabled skills without touching either source", async () => {
    const library = new ResourceLibrary(root);
    const a = await skill("a");
    const b = await skill("b");
    await library.save({ revision: 0, skills: [{ id: "test", path: a, enabled: true }], mcp: [] });
    await library.project({ cwd: project, toolId: "codex" });
    await library.save({ revision: 1, skills: [{ id: "test", path: b, enabled: true }], mcp: [] });
    const replaced = await library.project({ cwd: project, toolId: "codex" });
    expect(replaced.removed).toHaveLength(1);
    expect(replaced.paths).toHaveLength(1);
    expect(await readlink(replaced.paths[0]!)).toBe(b);
    await library.save({ revision: 2, skills: [{ id: "test", path: b, enabled: false }], mcp: [] });
    expect((await library.project({ cwd: project, toolId: "codex" })).removed).toHaveLength(1);
    await access(path.join(a, "SKILL.md"));
    await access(path.join(b, "SKILL.md"));
  });
  it("projects the same logical session MCP into both terminal harnesses without credentials", async () => {
    const library = new ResourceLibrary(root);
    const cli = await binary("familiar");
    vi.stubEnv("PASEO_CLI", cli);
    const claude = await library.claudeLaunchArgs("session A");
    const config = JSON.parse(await readFile(claude[1]!, "utf8"));
    expect(config.mcpServers.familiar_context).toEqual({
      type: "stdio",
      command: cli,
      args: ["context", "mcp", "--home", root, "--session", "session A"],
      env: { PASEO_HOME: root },
    });
    const codex = await library.codexLaunchArgs("session A");
    expect(codex).toContain(`mcp_servers.familiar_context.command=${JSON.stringify(cli)}`);
    expect(codex).toContain(
      `mcp_servers.familiar_context.args=${JSON.stringify(config.mcpServers.familiar_context.args)}`,
    );
    expect(codex).toContain(`mcp_servers.familiar_context.env.PASEO_HOME=${JSON.stringify(root)}`);
    await expect(
      library.save({
        revision: 0,
        skills: [],
        mcp: [
          { id: "familiar_context", type: "http", url: "https://mcp.example.test", enabled: true },
        ],
      }),
    ).rejects.toThrow("reserved");
  });
  it("passes literal Goose MCP paths and session arguments through its fixed command without shell expansion", async () => {
    const special = path.join(root, "state 'with\" quotes ; $(false)");
    await mkdir(special);
    const cli = path.join(special, "familiar 'and\" cli");
    await writeFile(
      cli,
      `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),home:process.env.PASEO_HOME}));\n`,
      { mode: 0o700 },
    );
    vi.stubEnv("PASEO_CLI", cli);
    const session = "session 'and\" ; $(false)";
    const launch = await new ResourceLibrary(special).gooseLaunch(session);
    expect(launch.args[0]).toBe("--with-extension");
    expect(launch.args[1]).not.toContain(special);
    const prefix = "familiar_context:/bin/sh -c '";
    expect(launch.args[1].startsWith(prefix)).toBe(true);
    const command = launch.args[1].slice(prefix.length, -1);
    expect(command).not.toContain("'");
    const result = JSON.parse(
      execFileSync("/bin/sh", ["-c", command], {
        env: { ...process.env, ...launch.env },
        encoding: "utf8",
      }),
    );
    expect(result).toEqual({
      args: ["context", "mcp", "--home", special, "--session", session],
      home: special,
    });
    await expect(access(path.join(special, "config.yaml"))).rejects.toThrow();
  });
  it("detects installer dependencies before downloading native releases", async () => {
    for (const name of ["bash", "curl", "tar"]) await binary(name);
    await expect(
      catalog().prepare({ id: "goose", action: "install", cwd: project }),
    ).rejects.toThrow("bzip2");
    await binary("bzip2");
    const plan = await catalog().prepare({ id: "goose", action: "install", cwd: project });
    expect(plan.command).toBe("/usr/bin/env");
    expect(plan.args.slice(0, 2)).toEqual(["ELECTRON_RUN_AS_NODE=1", process.execPath]);
    expect(plan.args.some((arg) => arg.includes("9560429ff982bbfecec5094963e5f34696b63a1c"))).toBe(
      true,
    );
    expect(plan.args).toContain("710f208cf0225ac330f71cc1540d36b10a6be7a850334b5ec4770fe96fbc57c4");
  });
  it("rejects stale concurrent saves and projects MCP through supported native session config", async () => {
    const library = new ResourceLibrary(root);
    const next = {
      revision: 0,
      skills: [],
      mcp: [
        { id: "search", type: "http" as const, url: "https://mcp.example.test/api", enabled: true },
      ],
    };
    const saves = await Promise.allSettled([library.save(next), library.save(next)]);
    expect(saves.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(await library.runtimeMcpServers("codex")).toEqual({
      search: { type: "http", url: next.mcp[0]!.url },
    });
    expect(await library.runtimeMcpServers("unknown-provider")).toEqual({});
    const args = await library.claudeLaunchArgs();
    expect(args[0]).toBe("--mcp-config");
    expect(JSON.parse(await readFile(args[1]!, "utf8"))).toEqual({
      mcpServers: await library.runtimeMcpServers("claude"),
    });
    expect(await library.claudeLaunchArgs()).toEqual(args);
  });
});
