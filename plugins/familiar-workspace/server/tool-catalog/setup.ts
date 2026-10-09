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
import { prepareGooseProvider, readGooseProvider, resetGooseProvider } from "./goose-provider.js";

const SIGN_IN = {
  codex: ["login", "--device-auth"],
  claude: ["auth", "login"],
  cursor: ["login"],
  antigravity: [],
} as const;
const COMMANDS: Record<string, string> = {
  codex: "codex",
  claude: "claude",
  cursor: "cursor-agent",
  antigravity: "agy",
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

  async workspace(): Promise<{ cwd: string }> {
    return { cwd: await this.folder() };
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
      if (id === "antigravity")
        status.details.push(
          "The original CLI manages its own updates. Update installation re-runs its installer; an existing CLI may be retained and update when next launched.",
        );
      if (probeAccount) await this.accountStatus(id as keyof typeof SIGN_IN, status);
    } else if (id === "aider") {
      await this.aiderStatus(status);
    } else if (id === "goose") {
      await this.gooseStatus(status, probeAccount);
    } else if (id === "pullboard") {
      status.account = "not-required";
      status.message =
        "Pullboard is installed. It needs Node.js 22.13 or newer and Git; no account or model is required.";
      status.details.push(
        "Use in this session, then explicitly Initialize project board in Run actions. Open terminal starts the original live board for your selected project. Init adds managed docs and hooks; it does not commit or launch agents.",
      );
    } else if (["openrig", "claude-squad", "superharness"].includes(id)) {
      await this.harnessStatus(id, status, probeAccount);
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

  private async harnessStatus(id: string, status: ToolSetupStatus, probeAccount: boolean) {
    status.account = "not-required";
    status.message =
      "This tool uses its native agent's account. Sign in to Claude Code or Codex on this server.";
    status.details.push(
      "Workspace, queue and team setup remain in the original tool. Use Open terminal or Run actions for the selected project.",
    );
    if (id === "openrig") {
      status.actions.push({ id: "start", label: "Start OpenRig service" });
      if (probeAccount) await this.openRigStatus(status);
    }
  }

  private async openRigStatus(status: ToolSetupStatus) {
    try {
      const result = await this.context().exec({
        command: await this.tools.resolveCommand("rig"),
        args: ["daemon", "status"],
        cwd: await this.folder(),
        timeoutMs: 15_000,
        maxBytes: 16_384,
      });
      const running =
        result.exitCode === 0 &&
        /Daemon running on port/iu.test(result.stdout) &&
        !/UNHEALTHY|UNVERIFIED/iu.test(result.stdout);
      status.message = running
        ? "OpenRig is installed and its original daemon reports running. Open its native interface to choose a rig."
        : "OpenRig is installed, but its daemon is not ready. Choose Start OpenRig service, then open its native interface.";
    } catch {
      status.message =
        "OpenRig is installed, but daemon readiness could not be checked. Choose Start OpenRig service to inspect its original startup result.";
    }
  }

  private async gooseStatus(status: ToolSetupStatus, probeAccount: boolean) {
    status.actions.push(
      { id: "use-codex", label: "Use existing Codex" },
      { id: "use-claude", label: "Use existing Claude Code" },
      { id: "configure", label: "Other providers / Original Goose setup" },
      { id: "use-goose-profile", label: "Use original Goose profile" },
    );
    const selected = await readGooseProvider(this.root);
    status.message =
      "Choose an existing Codex or Claude Code account on this server. No provider API URL or new API key is needed.";
    if (selected) {
      const account = selected.provider === "codex-acp" ? "codex" : "claude";
      if (probeAccount) await this.accountStatus(account, status);
      status.details.push(status.message);
      status.message = `Goose uses ${account === "codex" ? "Codex" : "Claude Code"} through its original ACP adapter. FamiliarAgent keeps this selection separate from your Goose profile.`;
    }
    status.details.push(
      "Existing authentication remains on its original server. Sign in to the original Codex or Claude Code provider if needed; this check does not run a model request.",
      "ACP continuation keeps the same FamiliarAgent session and shared memory, using a fresh native runtime and bounded recent history. It does not restore another tool's private checkpoint.",
      "Explicit Provider or Model values in Run actions Advanced override this default. Use original Goose profile removes the Familiar choice and clears those action overrides, leaving your native profile untouched.",
    );
  }

  private async accountStatus(id: keyof typeof SIGN_IN, status: ToolSetupStatus) {
    try {
      const output = await executeCommand(
        {
          command: await this.tools.resolveCommand(COMMANDS[id]!),
          args: {
            claude: ["auth", "status", "--json"],
            codex: ["login", "status"],
            cursor: ["status", "--format", "json"],
            antigravity: ["models"],
          }[id],
          env: { PATH: this.tools.searchPath() },
          cwd: await this.folder(),
          timeoutMs: 15_000,
          maxBytes: 16_384,
        },
        new AbortController().signal,
      );
      const text = output.stdout + output.stderr;
      let authenticated: boolean;
      if (id === "claude" || id === "cursor") {
        const account = JSON.parse(output.stdout);
        const flag = id === "claude" ? account.loggedIn : account.isAuthenticated;
        if (typeof flag !== "boolean") throw new Error("Unknown native account response");
        authenticated = output.exitCode === 0 && flag;
      } else if (id === "antigravity") {
        const models = output.stdout.trim().split(/\r?\n/u);
        authenticated =
          output.exitCode === 0 && models.every((line) => /^[^\t]+\t[^\t]+$/u.test(line));
        if (!authenticated && !/please sign in|not signed in/iu.test(text))
          throw new Error("Could not verify the Antigravity model catalog");
      } else {
        authenticated =
          output.exitCode === 0 && /logged in/iu.test(text) && !/not logged in/iu.test(text);
      }
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
    const gooseSetup =
      input.id === "goose" ? await this.prepareGoose(input.action, cwd) : undefined;
    if (gooseSetup) return gooseSetup;
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
    else if (input.id === "openrig" && input.action === "start")
      args = ["daemon", "start", "--no-kernel"];
    if (!args) throw new Error("Unsupported setup action");
    plan.command = "/usr/bin/env";
    plan.args = [
      `PATH=${this.tools.searchPath()}`,
      await this.tools.resolveCommand(COMMANDS[input.id]!),
      ...args,
    ];
    return { plan };
  }

  private async prepareGoose(
    action: string,
    cwd: string,
  ): Promise<z.infer<typeof prepareToolSetup.output> | undefined> {
    if (action === "use-goose-profile") {
      await resetGooseProvider(this.root);
      return {
        settings: ["run", "resume"].map((nativeAction) => ({
          action: nativeAction,
          parameters: { provider: "", model: "" },
        })),
      };
    }
    if (["use-codex", "use-claude"].includes(action))
      return {
        plan: await prepareGooseProvider(
          this.root,
          cwd,
          this.tools,
          action === "use-codex" ? "codex" : "claude",
        ),
      };
    return undefined;
  }
}
