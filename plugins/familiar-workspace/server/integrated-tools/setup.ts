import { access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ToolPlan } from "../../shared/tool-catalog.js";
import type { ToolSetupStatus } from "../../shared/tool-setup.js";
import type { ToolActionContext } from "../tool-actions/contracts.js";
import { integratedInstallPlan } from "./setup-install.js";
import { integratedRecipe, INTEGRATED_SETUP_IDS } from "./setup-recipes.js";
import { HYDRA_COMPAT } from "./hydra-compat.js";
import { prepareCodegRuntime, prepareOrcaCli, privateProfile } from "./setup-runtime.js";
import { inspectDockerSkills } from "./docker-skills.js";

type Context = Pick<ToolActionContext, "resolveCommand" | "exec">;
interface SetupOptions {
  id: string;
  root: string;
  cwd: string;
  platform?: string;
  arch?: string;
  existingInstallation?: boolean;
}
type Defaults = { action: string; parameters: Record<string, string> }[];

function paths(options: SetupOptions) {
  const recipe = integratedRecipe(
    options.id,
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  const directory = join(
    options.root,
    "tools",
    "native",
    `${options.id}-${recipe?.version ?? "native"}`,
  );
  return { recipe, directory, profile: join(options.root, "familiar", "native", options.id) };
}

async function optionalCommand(context: Context, command: string) {
  try {
    return await context.resolveCommand(command);
  } catch {
    return undefined;
  }
}

export async function readOpenHarnessSetup(context: Context, cwd: string) {
  const command = await optionalCommand(context, "harness");
  if (!command) return { installed: false, account: "unknown", runtime: "unknown" } as const;
  try {
    const result = await context.exec({
      command,
      args: ["auth", "status", "--json"],
      cwd,
      timeoutMs: 15_000,
      maxBytes: 16_384,
    });
    if (result.exitCode !== 0) throw new Error("Native sign-in check failed.");
    const value: unknown = JSON.parse(result.stdout);
    if (
      !value ||
      typeof value !== "object" ||
      !("loggedIn" in value) ||
      typeof value.loggedIn !== "boolean"
    )
      throw new Error("Unknown native sign-in response.");
    const status = await context.exec({
      command,
      args: ["status"],
      cwd,
      timeoutMs: 10_000,
      maxBytes: 16_384,
    });
    const line = stripVTControlCharacters(status.stdout);
    let runtime: "running" | "stopped" | "unknown" = "unknown";
    if (status.exitCode === 0 && /● running/u.test(line) && !/not answering/iu.test(line))
      runtime = "running";
    else if (/○ stopped/u.test(line)) runtime = "stopped";
    let account: "signed-out" | "signed-in" | "offline" = "signed-out";
    if (value.loggedIn)
      account = "offline" in value && value.offline === true ? "offline" : "signed-in";
    return {
      installed: true,
      command,
      account,
      runtime,
    } as const;
  } catch {
    return { installed: true, command, account: "unknown", runtime: "unknown" } as const;
  }
}

async function installed(options: SetupOptions): Promise<boolean> {
  const { recipe, directory } = paths(options);
  if (!recipe) return false;
  try {
    const marker = JSON.parse(await readFile(join(directory, ".familiar-install.json"), "utf8"));
    if (marker.id !== options.id || marker.version !== recipe.version) return false;
    await Promise.all(recipe.verify.map((file) => access(join(directory, file))));
    return true;
  } catch {
    return false;
  }
}

export async function integratedInstallation(root: string, id: string): Promise<boolean> {
  if (!INTEGRATED_SETUP_IDS.includes(id)) return false;
  if (id === "openharness") {
    try {
      await access(join(homedir(), ".local/bin/harness"), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return installed({ id, root, cwd: root });
}

async function compatibleNode(context: Context): Promise<string> {
  const candidates = [process.execPath, await optionalCommand(context, "node")].filter(
    (value): value is string => Boolean(value),
  );
  for (const command of new Set(candidates)) {
    try {
      const output = await context.exec({
        command,
        args: ["--version"],
        timeoutMs: 5000,
        maxBytes: 1024,
      });
      const match = /^v(\d+)\.(\d+)\.\d+\s*$/u.exec(output.stdout);
      if (output.exitCode === 0 && match && Number(match[1]) >= 20) return command;
    } catch {
      /* Try the separately installed Node runtime. */
    }
  }
  throw new Error(
    "Native setup requires Node.js 20 or newer. Update FamiliarAgent or install a compatible Node executable on this server.",
  );
}

export async function readIntegratedSetup(
  options: SetupOptions,
  context: Context,
): Promise<ToolSetupStatus | null> {
  if (!INTEGRATED_SETUP_IDS.includes(options.id)) return null;
  const { recipe } = paths(options);
  const harness =
    options.id === "openharness" ? await readOpenHarnessSetup(context, options.cwd) : undefined;
  const canonical = harness?.installed ?? (await installed(options));
  const present = canonical || options.existingInstallation === true;
  const status: ToolSetupStatus = {
    toolId: options.id,
    checkedAt: new Date().toISOString(),
    installation: present ? "installed" : "missing",
    account: "not-checked",
    message: present
      ? "The original tool is installed. Its agent account and runtime are checked separately."
      : "Install the original tool on this server, then choose Check setup.",
    details: [],
    actions:
      recipe && !canonical
        ? [{ id: "install", label: present ? "Install integration files" : "Install" }]
        : [],
  };
  if (!recipe)
    status.details.push(
      "A verified automatic installer is not available for this OS/architecture. Install the original release and register its executable or service URL in Run actions.",
    );
  if (!present) return status;
  if (!canonical) {
    status.message = "The original app is installed. Its native settings remain in place.";
    status.details.push(
      "Install integration files to prepare verified action paths, or use Run actions with the original service/executable you already configured.",
    );
    return status;
  }
  if (options.id === "docker-skills") {
    status.account = "not-required";
    status.message =
      "Docker's original knowledge skills are installed. Add references to Memory & Skills to use them with a supported agent.";
    status.details.push(
      "This pack does not install Docker, sign in to a registry or run containers. Each original skill documents its own runtime requirements.",
    );
    status.actions.push({ id: "configure", label: "Add to Memory & Skills" });
    return status;
  }
  if (harness) {
    status.account = "not-checked";
    status.message =
      "OpenHarness sign-in could not be verified online. Use its original terminal to check the account.";
    if (harness.account === "signed-in") {
      status.account = "signed-in";
      status.message = "OpenHarness reports an active sign-in.";
    } else if (harness.account === "signed-out") {
      status.account = "sign-in-required";
      status.message = "Sign in to use OpenHarness's public New agent command.";
    }
    status.details.push(
      `Native daemon: ${harness.runtime}. Local TUI use supports signed-out operation, but the current public new-agent CLI requires a native account.`,
    );
    status.actions.push(
      { id: "login", label: "Sign in" },
      { id: "start", label: "Start native daemon" },
      { id: "configure", label: "Open native terminal" },
    );
  } else {
    status.details.push(
      "Sign in to the original Claude Code or Codex provider on this server. Installing a harness does not authenticate its agents.",
    );
    if (["hydra", "orca", "codeg"].includes(options.id))
      status.actions.push({ id: "start", label: "Start original tool" });
    status.actions.push({ id: "configure", label: "Use installed paths" });
    if (options.id === "codeg")
      status.details.push(
        "Start original tool prepares its loopback URL and private token file automatically. Install and authenticate a provider in original Agent Settings.",
      );
  }
  return status;
}

export function integratedActionDefaults(options: SetupOptions, node: string): Defaults {
  const { directory, profile, recipe } = paths(options);
  const map = (actions: string[], parameters: Record<string, string>) =>
    actions.map((action) => ({ action, parameters }));
  if (options.id === "docker-skills") return map(["inspect", "read"], { packRoot: directory });
  if (options.id === "codey")
    return map(["list", "read", "run", "send"], {
      moduleRoot: directory,
      dataRoot: profile,
      nodeCommand: recipe?.runtime
        ? join(directory, ".familiar-runtime", recipe.runtime.directory, "bin/node")
        : node,
    });
  if (options.id === "agents")
    return map(["inspect", "run"], {
      pluginPath: join(directory, "plugins", "python-development"),
    });
  if (options.id === "hydra") {
    const socketPath = join(
      tmpdir(),
      `fa-hydra-${createHash("sha256").update(options.root).digest("hex").slice(0, 12)}`,
      "h.sock",
    );
    return [
      ...map(["list", "read", "run"], { socketPath }),
      {
        action: "prepare",
        parameters: {
          socketPath,
          daemonPath: join(directory, "out/main/daemon.js"),
          dataRoot: profile,
          nodeCommand: node,
        },
      },
    ];
  }
  if (options.id === "alethe" && recipe)
    return map(["run"], { command: join(directory, recipe.verify[0]!), codexCommand: "codex" });
  if (options.id === "openharness")
    return map(["status", "search", "run"], { command: join(homedir(), ".local/bin/harness") });
  if (options.id === "orca")
    return map(["list", "create", "send", "read"], { command: join(profile, "orca-cli") });
  return [];
}

async function prepareHydra(options: SetupOptions, node: string): Promise<ToolPlan> {
  const { directory, profile } = paths(options);
  const settings = integratedActionDefaults(options, node).find(
    (item) => item.action === "prepare",
  )!.parameters;
  await privateProfile(profile);
  await privateProfile(join(settings.socketPath!, ".."));
  try {
    await writeFile(
      join(profile, "config.json"),
      JSON.stringify({ importSessionsOnStartup: false, mcpEnabled: false }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const launcher = join(profile, "familiar-launcher.cjs");
  await writeFile(
    launcher,
    `process.env.FAMILIAR_HYDRA_COMPAT='1';\nprocess.argv=${JSON.stringify([node, join(directory, "out/main/daemon.js"), "--socket-path", settings.socketPath, "--user-data", profile])};\n${HYDRA_COMPAT}\nrequire(${JSON.stringify(join(directory, "out/main/daemon.js"))});\n`,
    { mode: 0o600 },
  );
  return {
    toolId: options.id,
    action: "launch",
    mode: "terminal",
    cwd: options.cwd,
    command: node,
    args: [launcher],
    notes: [
      "Starts the original Hydra daemon with its dedicated profile and the verified Claude stream compatibility launcher. Keep this terminal open while using Run actions.",
    ],
  };
}

export async function prepareIntegratedSetup(
  options: SetupOptions & { action: string },
  context: Context,
): Promise<{
  plan?: ToolPlan;
  settings?: Defaults;
  skills?: { id: string; path: string; enabled: boolean }[];
} | null> {
  if (!INTEGRATED_SETUP_IDS.includes(options.id)) return null;
  const { recipe, directory, profile } = paths(options);
  const node = await compatibleNode(context);
  const settings = integratedActionDefaults(options, node);
  if (options.action === "install") {
    if (!recipe)
      throw new Error(
        "No verified original installer is available for this platform. Use the original release instructions.",
      );
    return {
      plan: integratedInstallPlan({ recipe, destination: directory, cwd: options.cwd, node }),
      settings,
    };
  }
  if (options.id === "openharness") {
    const command = await context.resolveCommand("harness");
    const commands: Record<string, string[]> = {
      login: ["login"],
      start: ["start"],
      configure: ["tui"],
    };
    const args = commands[options.action];
    if (!args) throw new Error("Unknown OpenHarness setup action.");
    return {
      plan: {
        toolId: options.id,
        action: "launch",
        mode: "terminal",
        cwd: options.cwd,
        command,
        args,
        notes: [
          "Uses OpenHarness's original account and profile. Browser sign-in is completed by you. No force, logout, credential copy or running-daemon replacement is requested.",
        ],
      },
      settings: settings.map((item) => ({ ...item, parameters: { command } })),
    };
  }
  if (!(await installed(options)))
    throw new Error("Install this original tool first, then choose Check setup.");
  if (options.id === "docker-skills" && options.action === "configure")
    return {
      settings,
      skills: (await inspectDockerSkills(directory)).map(({ id, path }) => ({
        id,
        path,
        enabled: true,
      })),
    };
  if (options.id === "orca" && recipe)
    await prepareOrcaCli(node, join(directory, recipe.verify[0]!), join(profile, "orca-cli"));
  if (options.id === "codeg" && ["start", "configure"].includes(options.action)) {
    const prepared = await prepareCodegRuntime({
      directory,
      profile,
      executable: join(directory, recipe!.verify[0]!),
      node,
      cwd: options.cwd,
    });
    return options.action === "start" ? prepared : { settings: prepared.settings };
  }
  if (options.action === "start" && options.id === "hydra")
    return { plan: await prepareHydra(options, node), settings };
  if (options.action === "start" && options.id === "orca")
    return {
      plan: {
        toolId: options.id,
        action: "launch",
        mode: "desktop",
        cwd: options.cwd,
        command: "/usr/bin/open",
        args: [join(directory, "Orca.app")],
        notes: [
          "Opens the original Orca app. Register its CLI in Settings, and add the project before using terminal actions.",
        ],
      },
      settings,
    };
  if (options.action !== "configure") throw new Error("Unknown integrated tool setup action.");
  return { settings };
}
