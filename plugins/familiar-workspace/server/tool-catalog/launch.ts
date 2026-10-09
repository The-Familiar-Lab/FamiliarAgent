import path from "node:path";
import { codegReady } from "./codeg-ready.js";
import type { ToolEntry, ToolPlan } from "../../shared/tool-catalog.js";
import { integratedRecipe } from "../integrated-tools/setup-recipes.js";
import { prepareIntegratedSetup } from "../integrated-tools/setup.js";
import { executeCommand } from "../tool-actions/transport.js";

/** Only original interfaces supported by the installed integration, not agent work. */
export function managedLaunchSurface(
  id: string,
  platform: NodeJS.Platform,
): ToolEntry["launchSurface"] | undefined {
  if (id === "orca") return platform === "darwin" ? "desktop" : "actions";
  if (id === "codeg") return "terminal";
  return undefined;
}

export function managedDesktopPath(root: string, id: string, platform: NodeJS.Platform) {
  if (platform !== "darwin") return undefined;
  const recipe = integratedRecipe(id, platform, process.arch);
  const app = recipe?.verify.map((file) => /^([^/]+\.app)\//u.exec(file)?.[1]).find(Boolean);
  return app && recipe
    ? path.join(root, "tools", "native", `${id}-${recipe.version}`, app)
    : undefined;
}

export async function prepareManagedLaunch(options: {
  root: string;
  id: string;
  cwd: string;
  platform: NodeJS.Platform;
  searchPath: string;
  sessionId?: string;
  contextPath?: string;
  resolveCommand: (name: string) => Promise<string>;
}): Promise<ToolPlan> {
  const prepared = await prepareIntegratedSetup(
    { ...options, action: "start" },
    {
      resolveCommand: options.resolveCommand,
      exec: (command) =>
        executeCommand(
          {
            ...command,
            cwd: command.cwd ?? options.cwd,
            env: { PATH: options.searchPath, ELECTRON_RUN_AS_NODE: "1", ...command.env },
          },
          new AbortController().signal,
        ),
    },
  );
  if (!prepared?.plan)
    throw new Error("The original tool has no launchable interface. Use Run actions.");
  const plan = prepared.plan;
  const connection =
    options.id === "codeg"
      ? prepared.settings?.find((entry) => entry.action === "list")?.parameters
      : undefined;
  if (
    connection?.url &&
    connection.tokenFile &&
    (await codegReady(connection.url, connection.tokenFile))
  )
    return {
      toolId: options.id,
      action: "launch",
      mode: "web",
      cwd: options.cwd,
      args: [],
      url: connection.url,
      notes: [
        "Opens the verified existing original Codeg service without starting another process. Its browser login and project selection remain native; the private token is never put in the URL.",
      ],
    };
  if (plan.mode !== "terminal") return plan;
  if (!plan.command) throw new Error("The original launch command is missing.");
  // Keep the canonical terminal environment so session-scoped child MCP shims still apply.
  const original = plan.command === "/usr/bin/env" ? plan.args : [plan.command, ...plan.args];
  return {
    ...plan,
    command: "/usr/bin/env",
    args: [
      `PATH=${options.searchPath}`,
      ...(options.sessionId ? [`FAMILIAR_SESSION_ID=${options.sessionId}`] : []),
      ...(options.contextPath ? [`FAMILIAR_CONTEXT_FILE=${options.contextPath}`] : []),
      ...original,
    ],
    notes: [
      ...plan.notes,
      "The original service controls its own project selection and sign-in. The selected FamiliarAgent folder and session remain linked here; starting a service does not start an agent task.",
    ],
  };
}
