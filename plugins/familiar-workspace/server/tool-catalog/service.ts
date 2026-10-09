import { guideForTool } from "./guides.js";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  prepareTool,
  toolId,
  toolRegistration,
  writeToolContext,
  type ToolEntry,
  type ToolPlan,
  type ToolRegistration,
} from "../../shared/tool-catalog.js";
import { BUILTIN_TOOLS, type BuiltinTool } from "./catalog.js";
import { directory, readJson, writeJson, writeText } from "./files.js";
import { prepareNativeInstaller } from "./installers.js";
import { prepareInfrastructureInstaller } from "../infrastructure/installers.js";
import { integratedInstallation } from "../integrated-tools/setup.js";
import { gooseAdapterBins, gooseProviderEnvironment } from "./goose-provider.js";

interface Options {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
const registrations = z.array(toolRegistration).max(128);
type RegisteredTool = BuiltinTool & { registration?: ToolRegistration };

export class ToolCatalog {
  async resolveCommand(command: string): Promise<string> {
    const executable = await this.findExecutable(command);
    if (!executable)
      throw new Error(
        `Native command '${command}' is unavailable on this server. Install it or select its executable in Advanced.`,
      );
    return executable;
  }
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private queue = Promise.resolve();
  constructor(
    private readonly root: string,
    options: Options = {},
  ) {
    this.home = options.home ?? os.homedir();
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
  }
  searchPath(): string {
    return this.binDirectories().join(path.delimiter);
  }
  private binDirectories(): string[] {
    return [
      path.join(this.root, "tools", "node", "node_modules", ".bin"),
      path.join(this.root, "tools", "bin"),
      path.join(this.root, "tools", "python-bootstrap", "bin"),
      ...BUILTIN_TOOLS.filter((tool) => tool.install?.kind === "python").map((tool) =>
        path.join(this.root, "tools", "venvs", tool.install!.package, "bin"),
      ),
      path.join(this.root, "providers", "node_modules", ".bin"),
      path.join(this.home, ".local", "bin"),
      ...(this.env.PATH ?? "").split(path.delimiter),
    ].filter(Boolean);
  }
  private async findExecutable(command: string): Promise<string | undefined> {
    const candidates = path.isAbsolute(command)
      ? [command]
      : this.binDirectories().map((dir) => path.join(dir, command));
    if (!path.isAbsolute(command) && /[/\\]/u.test(command)) return undefined;
    if (command === "codex" && this.platform === "darwin")
      candidates.push(
        "/Applications/Codex.app/Contents/Resources/codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        path.join(
          this.home,
          "Applications",
          "ChatGPT.app",
          "Contents",
          "Resources",
          "codex-cli",
          "CodexCLI.app",
          "Contents",
          "MacOS",
          "codex",
        ),
        path.join(this.home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
      );
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch (error) {
        if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
    }
    return undefined;
  }
  private async desktop(app: string | undefined): Promise<string | undefined> {
    if (!app || this.platform !== "darwin") return undefined;
    for (const candidate of [
      path.join("/Applications", app),
      path.join(this.home, "Applications", app),
    ]) {
      try {
        if ((await stat(candidate)).isDirectory()) return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return undefined;
  }
  private async load(): Promise<ToolRegistration[]> {
    return registrations.parse(
      (await readJson(path.join(this.root, "familiar", "tools.json"))) ?? [],
    );
  }
  private async definitions(): Promise<Array<RegisteredTool>> {
    const custom = await this.load();
    return [
      ...BUILTIN_TOOLS.map((item) => ({
        ...item,
        registration: custom.find((saved) => saved.id === item.id),
      })),
      ...custom
        .filter((item) => !BUILTIN_TOOLS.some((builtin) => builtin.id === item.id))
        .map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          capabilities: item.capabilities,
          sourceUrl: item.sourceUrl,
          license: "User-provided integration",
          registration: item,
        })),
    ];
  }
  private async installPlan(tool: BuiltinTool, cwd: string): Promise<ToolPlan> {
    const infrastructure = await prepareInfrastructureInstaller({
      id: tool.id,
      root: this.root,
      cwd,
      platform: this.platform,
      executable: (name) => this.findExecutable(name),
    });
    if (infrastructure) return infrastructure;
    if (!tool.install)
      throw new Error(
        "No verified automatic installer is configured. Open the source instructions or add a custom launch command.",
      );
    const recipe = tool.install;
    let command: string | undefined;
    let args: string[];
    const notes = [
      "Installation runs in the visible native terminal. Login and model selection remain in the original tool.",
    ];
    if (recipe.kind === "npm") {
      command = await this.findExecutable("npm");
      args = [
        "install",
        "--prefix",
        path.join(this.root, "tools", "node"),
        "--no-audit",
        "--no-fund",
        recipe.package,
      ];
      if (!command) throw new Error("Node.js and npm are required on this server.");
    } else if (recipe.kind === "python") {
      const uv = await this.findExecutable("uv");
      const pipx = await this.findExecutable("pipx");
      const dependencies = (recipe.with ?? []).flatMap((dependency) => ["--with", dependency]);
      command = "/usr/bin/env";
      if (uv)
        args = [
          `UV_TOOL_DIR=${path.join(this.root, "tools", "python")}`,
          `UV_TOOL_BIN_DIR=${path.join(this.root, "tools", "bin")}`,
          `UV_PYTHON_INSTALL_DIR=${path.join(this.root, "tools", "python-runtimes")}`,
          `UV_CACHE_DIR=${path.join(this.root, "cache", "uv")}`,
          `PATH=${this.binDirectories().join(path.delimiter)}`,
          uv,
          "tool",
          "install",
          "--python",
          "3.12",
          recipe.package,
          ...dependencies,
        ];
      else if (pipx && !dependencies.length)
        args = [
          `PIPX_HOME=${path.join(this.root, "tools", "python")}`,
          `PIPX_BIN_DIR=${path.join(this.root, "tools", "bin")}`,
          pipx,
          "install",
          recipe.package,
        ];
      else {
        const python = await this.findExecutable("python3");
        if (!python) throw new Error("Python 3, uv or pipx is required on this server.");
        command = "/bin/sh";
        args = [
          "-c",
          'set -eu; if [ ! -x "$2/bin/python" ]; then "$1" -m venv "$2"; fi; if [ ! -x "$2/bin/uv" ]; then "$2/bin/python" -m pip install --disable-pip-version-check "uv==0.12.24"; fi; export UV_TOOL_DIR="$3" UV_TOOL_BIN_DIR="$4" UV_PYTHON_INSTALL_DIR="$6" UV_CACHE_DIR="$7" PATH="$4:$PATH"; FAMILIAR_INSTALL_UV="$2/bin/uv"; FAMILIAR_INSTALL_PACKAGE="$5"; shift 7; exec "$FAMILIAR_INSTALL_UV" tool install --python 3.12 "$FAMILIAR_INSTALL_PACKAGE" "$@"',
          "familiar-python-install",
          python,
          path.join(this.root, "tools", "python-bootstrap"),
          path.join(this.root, "tools", "python"),
          path.join(this.root, "tools", "bin"),
          recipe.package,
          path.join(this.root, "tools", "python-runtimes"),
          path.join(this.root, "cache", "uv"),
          ...dependencies,
        ];
        notes.push(
          "Bootstraps pinned uv in a private Python environment and installs a compatible Python 3.12 tool environment; system Python packages are not modified.",
        );
      }
    } else {
      if (!["goose", "claude-squad", "cursor", "antigravity"].includes(tool.id))
        throw new Error("Unknown native installer");
      return prepareNativeInstaller({
        id: tool.id as Parameters<typeof prepareNativeInstaller>[0]["id"],
        root: this.root,
        cwd,
        searchPath: this.binDirectories().join(path.delimiter),
        executable: (name) => this.findExecutable(name),
      });
    }
    return { toolId: tool.id, action: "install", mode: "terminal", cwd, command, args, notes };
  }
  private async entry(tool: RegisteredTool): Promise<ToolEntry> {
    const custom = tool.registration;
    const command = custom?.launch?.command ?? tool.command;
    const executablePath = command ? await this.findExecutable(command) : undefined;
    const desktopApp = await this.desktop(tool.desktopApp);
    const canonicalInstall = await integratedInstallation(this.root, tool.id);
    let installReason: string | undefined;
    try {
      await this.installPlan(tool, this.home);
    } catch (error) {
      installReason = (error as Error).message;
    }
    const modes: ToolEntry["modes"] = [];
    if (tool.nativeProvider) modes.push("agent");
    if (command) modes.push("terminal");
    if (desktopApp) modes.push("desktop");
    if (custom?.url) modes.push("web");
    if (!modes.length) modes.push("reference");
    return {
      ...describeTool(tool),
      modes,
      custom: Boolean(custom),
      installed: Boolean(executablePath || canonicalInstall || (!command && desktopApp)),
      executablePath,
      url: custom?.url,
      installAvailable: !installReason,
      installReason,
      notes: entryNotes(tool, modes),
    };
  }
  async list(): Promise<ToolEntry[]> {
    return Promise.all((await this.definitions()).map((item) => this.entry(item)));
  }
  async childExecutables(includeTmux: boolean) {
    return {
      claude: await this.findExecutable("claude"),
      codex: await this.findExecutable("codex"),
      ...(includeTmux ? { tmux: await this.findExecutable("tmux") } : {}),
    };
  }
  async context(input: z.input<typeof writeToolContext.input>) {
    const value = writeToolContext.input.parse(input);
    const bytes = Buffer.byteLength(value.text, "utf8");
    if (bytes > 16 * 1024)
      throw new Error(
        "Context exceeds the 16 KiB handoff limit. Keep history as a source reference.",
      );
    const id = createHash("sha256").update(value.sessionId).digest("hex");
    const file = path.join(this.root, "familiar", "tool-contexts", `${id}.md`);
    await this.mutate(() => writeText(file, value.text));
    return { path: file, bytes, sha256: createHash("sha256").update(value.text).digest("hex") };
  }
  async register(input: ToolRegistration): Promise<ToolEntry> {
    const value = toolRegistration.parse(input);
    await this.mutate(async () => {
      const all = await this.load();
      await writeJson(
        path.join(this.root, "familiar", "tools.json"),
        registrations.parse([...all.filter((item) => item.id !== value.id), value]),
      );
    });
    return (await this.list()).find((item) => item.id === value.id)!;
  }
  async remove(id: string): Promise<{ removed: boolean }> {
    toolId.parse(id);
    let removed = false;
    await this.mutate(async () => {
      const all = await this.load();
      removed = all.some((item) => item.id === id);
      if (removed)
        await writeJson(
          path.join(this.root, "familiar", "tools.json"),
          all.filter((item) => item.id !== id),
        );
    });
    return { removed };
  }
  private mutate(action: () => Promise<void>): Promise<void> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  async prepare(input: z.input<typeof prepareTool.input>): Promise<ToolPlan> {
    const value = prepareTool.input.parse(input);
    const cwd = await directory(value.cwd);
    const tool = (await this.definitions()).find((item) => item.id === value.id);
    if (!tool) throw new Error("Unknown tool");
    if (value.action === "install") return this.installPlan(tool, cwd);
    const url = tool.registration?.url;
    if (value.surface === "web" || (!value.surface && url)) {
      if (!url) throw new Error("No web URL is configured for this tool on this server");
      return {
        toolId: tool.id,
        action: "launch",
        mode: "web",
        cwd,
        args: [],
        url,
        notes: ["Native web session and authentication stay in the original tool."],
      };
    }
    if (
      value.surface === "desktop" ||
      (!value.surface && !tool.command && !tool.registration?.launch)
    ) {
      const app = await this.desktop(tool.desktopApp);
      if (!app) throw new Error("The original desktop app is not installed on this host");
      return {
        toolId: tool.id,
        action: "launch",
        mode: "desktop",
        cwd,
        command: "/usr/bin/open",
        args: ["-a", app, ...(tool.desktopOpensFolder === false ? [] : [cwd])],
        notes: [
          ...(tool.notes ?? []),
          tool.desktopOpensFolder === false
            ? "Opens the original app. The FamiliarAgent project and context remain linked here; use the app's own actions to attach them. No conversation is automatically imported."
            : "Opens the original app with this project folder. It does not import a different runtime's binary session state.",
        ],
      };
    }
    return this.terminalPlan(tool, cwd, value.contextPath, value.sessionId);
  }
  private async terminalPlan(
    tool: RegisteredTool,
    cwd: string,
    requestedContext?: string,
    sessionId?: string,
  ): Promise<ToolPlan> {
    const launch =
      tool.registration?.launch ??
      (tool.command ? { command: tool.command, args: tool.args ?? [] } : undefined);
    if (!launch) throw new Error("Register a native command or web URL before launching this tool");
    const command = await this.findExecutable(launch.command);
    if (!command)
      throw new Error(
        `${tool.name} is not installed or its executable is not on this server's PATH`,
      );
    const contextPath = requestedContext ? await this.contextFile(requestedContext) : undefined;
    const args = launch.args.map((arg) => {
      if (arg.includes("{{context}}") && !contextPath)
        throw new Error("This tool requires a context file");
      return arg.replaceAll("{{workspace}}", cwd).replaceAll("{{context}}", contextPath ?? "");
    });
    if (tool.id === "aider" && contextPath && !tool.registration?.launch)
      args.push("--read", contextPath);
    const environment = await this.terminalEnvironment(tool);
    return {
      toolId: tool.id,
      action: "launch",
      mode: "terminal",
      cwd,
      command: "/usr/bin/env",
      args: [
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        ...(sessionId ? [`FAMILIAR_SESSION_ID=${sessionId}`] : []),
        ...(contextPath ? [`FAMILIAR_CONTEXT_FILE=${contextPath}`] : []),
        command,
        ...args,
      ],
      notes: [
        ...(tool.notes ?? []),
        ...(contextPath &&
        tool.id !== "aider" &&
        !launch.args.some((arg) => arg.includes("{{context}}"))
          ? [
              "This launcher does not inject the context file. Use the tool's own attach/read action or configure an explicit {{context}} argument.",
            ]
          : []),
      ],
    };
  }
  private async terminalEnvironment(tool: RegisteredTool): Promise<Record<string, string>> {
    const searchPath = this.searchPath();
    if (tool.id !== "goose") return { PATH: searchPath };
    return {
      PATH: [searchPath, ...gooseAdapterBins(this.root)].join(path.delimiter),
      ...(tool.registration?.launch ? {} : await gooseProviderEnvironment(this.root)),
    };
  }
  private async contextFile(file: string): Promise<string> {
    if (!path.isAbsolute(file) || !(await stat(file)).isFile())
      throw new Error("Context must be an existing absolute file path");
    return file;
  }
}

function describeTool(tool: RegisteredTool) {
  const custom = tool.registration;
  return {
    id: tool.id,
    name: custom?.name ?? tool.name,
    description: custom?.description || tool.description,
    capabilities: custom?.capabilities.length ? custom.capabilities : tool.capabilities,
    nativeProvider: tool.nativeProvider,
    sourceUrl: custom?.sourceUrl ?? tool.sourceUrl,
    license: tool.license,
    guide: guideForTool({
      ...tool,
      name: custom?.name ?? tool.name,
      description: custom?.description || tool.description,
    }),
  };
}
function entryNotes(tool: RegisteredTool, modes: ToolEntry["modes"]): string[] {
  const notes = [...(tool.notes ?? [])];
  if (modes.includes("reference"))
    notes.push(
      "Connect a deployed web URL or register its native command to open the original interface. Supported native actions are available in Run an original tool.",
    );
  if (tool.registration?.url)
    notes.push(
      "Configured web URL; availability and authentication are checked by the original page when opened.",
    );
  return notes;
}
