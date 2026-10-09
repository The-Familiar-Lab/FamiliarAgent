import { mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { prepareToolSetup, type ToolSetupStatus } from "../../shared/tool-setup.js";
import type { ToolPlan } from "../../shared/tool-catalog.js";
import { ToolCatalog } from "./service.js";
import { executeCommand } from "../tool-actions/transport.js";
import { API_KEY_SETUP, apiKeySetup } from "./api-key-setup.js";
import { readIntegratedSetup, prepareIntegratedSetup } from "../integrated-tools/setup.js";
import type { ToolCommand } from "../tool-actions/contracts.js";
import { privateEnvironmentFile } from "../native-tools/aider.js";

const SIGN_IN = {
  codex: ["login", "--device-auth"],
  claude: ["auth", "login"],
  cursor: ["login"],
} as const;
const COMMANDS: Record<string, string> = {
  codex: "codex",
  claude: "claude",
  cursor: "cursor-agent",
  aider: "aider",
  goose: "goose",
  openrig: "rig",
  "claude-squad": "cs",
  superharness: "superharness",
};

/** On-demand checks only; never treats an installed binary as an authenticated agent. */
export class ToolSetup {
  constructor(
    private readonly root: string,
    private readonly tools: ToolCatalog,
  ) {}

  private async folder() {
    const cwd = path.join(this.root, "familiar", "tool-setup");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    return cwd;
  }

  private context() {
    return {
      resolveCommand: (command: string) => this.tools.resolveCommand(command),
      exec: (command: ToolCommand) =>
        executeCommand(
          { ...command, env: { PATH: this.tools.searchPath(), ...command.env } },
          new AbortController().signal,
        ),
    };
  }

  async status(id: string, probeAccount = true): Promise<ToolSetupStatus> {
    const tool = (await this.tools.list()).find((item) => item.id === id);
    if (!tool) throw new Error("Unknown tool");
    const integrated = await readIntegratedSetup(
      { id, root: this.root, cwd: await this.folder(), existingInstallation: tool.installed },
      this.context(),
    );
    if (integrated) return integrated;
    const status: ToolSetupStatus = {
      toolId: id,
      checkedAt: new Date().toISOString(),
      installation: tool.installed ? "installed" : "missing",
      account: "not-checked",
      message: tool.installed
        ? "Installed. Complete the original tool's setup before running a task."
        : "Install this tool on the selected server to continue.",
      details: [],
      actions: [],
    };
    if (tool.installAvailable)
      status.actions.push({
        id: "install",
        label: tool.installed ? "Update installation" : "Install",
      });
    else if (!tool.installed)
      status.details.push(tool.installReason ?? "Use Ask agent to set up for native installation.");
    if (!tool.installed) return status;
    if (id in SIGN_IN) {
      status.actions.push({ id: "login", label: "Sign in" });
      if (probeAccount && (id === "claude" || id === "codex")) {
        await this.accountStatus(id, status);
      }
    } else if (id === "aider") {
      await this.aiderStatus(status);
    } else if (id === "goose") {
      status.actions.push({ id: "configure", label: "Choose provider / Sign in" });
      status.message =
        "Use Goose's original provider setup, then run a native task to verify access.";
    } else if (["openrig", "claude-squad", "superharness"].includes(id)) {
      if (id === "openrig") status.actions.push({ id: "start", label: "Start OpenRig" });
      status.account = "not-required";
      status.message =
        "This tool uses its native agent's account. Sign in to Claude Code or Codex on this server.";
      status.details.push(
        "Workspace, queue and team setup remain in the original tool. Use Open terminal or Run actions for the selected project.",
      );
    } else {
      status.details.push(
        "Use the original app or Ask agent to set up. Native services, models and infrastructure must be configured on this server.",
      );
    }
    return status;
  }

  private async aiderStatus(status: ToolSetupStatus) {
    status.actions.push({ id: "api-key", label: "Add API key" });
    const files = await this.apiKeyFiles();
    if (files) status.actions.push({ id: "apply-key", label: "Use saved API key" });
    status.message = files
      ? "A private API key file is present. Select its provider and choose Use saved API key, then run a task to verify authentication."
      : "Choose your API provider, then add its key in the hidden-input terminal.";
    status.details.push(
      "Existing Aider environment and native configuration remain available. File presence does not verify billing, model access or credentials.",
    );
  }

  private async accountStatus(id: "claude" | "codex", status: ToolSetupStatus) {
    try {
      const output = await executeCommand(
        {
          command: await this.tools.resolveCommand(COMMANDS[id]!),
          args: id === "claude" ? ["auth", "status", "--json"] : ["login", "status"],
          env: { PATH: this.tools.searchPath() },
          cwd: await this.folder(),
          timeoutMs: 15_000,
          maxBytes: 16_384,
        },
        new AbortController().signal,
      );
      const authenticated =
        id === "claude"
          ? JSON.parse(output.stdout).loggedIn === true
          : output.exitCode === 0 && /logged in/iu.test(output.stdout + output.stderr);
      status.account = authenticated ? "signed-in" : "sign-in-required";
      status.message = authenticated
        ? "The original tool reports an active sign-in."
        : "Sign in on this server to continue.";
    } catch {
      status.message =
        "Could not verify the original sign-in. Open Sign in, then Check setup again.";
    }
  }

  private async apiKeyFiles() {
    let files = 0;
    for (const provider of ["openai", "anthropic", "openrouter"] as const) {
      try {
        const info = await lstat(apiKeySetup(this.root, provider).file);
        if (
          info.isFile() &&
          info.uid === process.getuid?.() &&
          !(info.mode & 0o077) &&
          info.size > 0
        )
          files++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return files;
  }

  async prepare(
    raw: z.input<typeof prepareToolSetup.input>,
  ): Promise<z.infer<typeof prepareToolSetup.output>> {
    const input = prepareToolSetup.input.parse(raw);
    const cwd = await this.folder();
    const integrated = await prepareIntegratedSetup(
      { ...input, root: this.root, cwd },
      this.context(),
    );
    if (integrated) return integrated;
    const status = await this.status(input.id, false);
    if (!status.actions.some((action) => action.id === input.action))
      throw new Error("This setup action is unavailable. Check setup first.");
    if (input.action === "install")
      return { plan: await this.tools.prepare({ id: input.id, action: "install", cwd }) };
    const plan: ToolPlan = {
      toolId: input.id,
      action: "launch",
      mode: "terminal",
      cwd,
      args: [],
      notes: ["Complete setup in the original terminal, then return here and choose Check setup."],
    };
    if (input.action === "api-key" && input.id === "aider") {
      if (!input.provider) throw new Error("Choose an API provider first.");
      const key = apiKeySetup(this.root, input.provider);
      plan.command = await this.tools.resolveCommand("python3");
      plan.args = ["-c", API_KEY_SETUP, key.file, key.variable];
      return {
        plan,
        credentialFile: key.file,
      };
    }
    if (input.action === "apply-key" && input.id === "aider") {
      if (!input.provider) throw new Error("Choose an API provider first.");
      const file = await privateEnvironmentFile(apiKeySetup(this.root, input.provider).file);
      return { settings: [{ action: "run", parameters: { envFile: file } }] };
    }
    let args: readonly string[] | null = null;
    if (input.action === "login" && input.id in SIGN_IN)
      args = SIGN_IN[input.id as keyof typeof SIGN_IN];
    else if (input.id === "goose" && input.action === "configure") args = ["configure"];
    else if (input.id === "openrig" && input.action === "start") args = ["start"];
    if (!args) throw new Error("Unsupported setup action");
    plan.command = "/usr/bin/env";
    plan.args = [
      `PATH=${this.tools.searchPath()}`,
      await this.tools.resolveCommand(COMMANDS[input.id]!),
      ...args,
    ];
    return { plan };
  }
}
