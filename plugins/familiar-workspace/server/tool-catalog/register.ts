import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  listTools,
  prepareTool,
  registerTool,
  removeTool,
  writeToolContext,
  listResources,
  saveResources,
  useHttpResource,
  projectResources,
  type ToolPlan,
} from "../../shared/tool-catalog.js";
import { ResourceLibrary } from "./resources.js";
import { ToolCatalog } from "./service.js";
import { prepareContextShims } from "./context-shims.js";

/** Uses existing terminal, browser and native provider paths. The registrar
 * prepares processes; it never runs installation or agent loops in the daemon. */
export function registerToolCatalog(server: PluginServerContext, root: string): void {
  const tools = new ToolCatalog(root);
  const resources = new ResourceLibrary(root);
  server.handle(listTools, () => tools.list());
  server.handle(registerTool, (input) => tools.register(input));
  server.handle(removeTool, ({ id }) => tools.remove(id));
  server.handle(writeToolContext, (input) => tools.context(input));
  server.handle(listResources, () => resources.list());
  server.handle(saveResources, (input) => resources.save(input));
  server.handle(useHttpResource, (input) => resources.useHttp(input));
  server.handle(projectResources, (input) => resources.project(input));
  server.handle(prepareTool, async (input) => {
    const plan = await tools.prepare(input);
    if (input.action !== "launch") return plan;
    if (input.id === "claude" || input.id === "codex" || input.id === "cursor") {
      const projection = await resources.project({ cwd: plan.cwd, toolId: input.id });
      if (projection.conflicts.length)
        throw new Error(`Shared skill conflicts: ${projection.conflicts.join("; ")}`);
      plan.notes.push(...projection.notes);
    }
    if (plan.mode === "terminal") await prepareTerminalContext(plan, input, root, tools, resources);
    if (
      plan.mode === "desktop" &&
      input.sessionId &&
      (input.id === "cursor" || input.id === "vscode")
    ) {
      const connected = await resources.projectEditor({
        cwd: plan.cwd,
        toolId: input.id,
        sessionId: input.sessionId,
      });
      plan.notes.push(
        `Shared session MCP ${connected.status === "added" ? "added to" : "already configured in"} ${connected.file}.`,
        "Enable or trust the workspace and familiar_context server in the editor when prompted, then ask its agent to use familiar_context and familiar_history. Native conversations keep their original state.",
      );
      if (input.id === "vscode")
        plan.notes.push(
          "This connects VS Code's built-in MCP-capable chat/Agent Host. The Codex extension has its own provider configuration and is not automatically connected by this file.",
        );
    }
    return plan;
  });
  server.before("agent.create", async ({ request }) => {
    const provider = request.config.provider;
    if (provider !== "claude" && provider !== "codex") return request;
    const shared = await resources.runtimeMcpServers(provider);
    const configured = request.config.mcpServers ?? {};
    for (const [id, definition] of Object.entries(shared)) {
      if (configured[id] && !isDeepStrictEqual(definition, configured[id]))
        throw new Error(
          `MCP '${id}' has different shared and session configurations. Rename one entry or align its settings before starting.`,
        );
    }
    const projection = await resources.project({ cwd: request.config.cwd, toolId: provider });
    if (projection.conflicts.length)
      throw new Error(`Shared skill conflicts: ${projection.conflicts.join("; ")}`);
    return { ...request, config: { ...request.config, mcpServers: { ...shared, ...configured } } };
  });
}

async function prepareTerminalContext(
  plan: ToolPlan,
  input: { id: string; sessionId?: string; contextPath?: string },
  root: string,
  tools: ToolCatalog,
  resources: ResourceLibrary,
): Promise<void> {
  const claudeArgs =
    input.id === "claude" || input.sessionId
      ? await resources.claudeLaunchArgs(input.sessionId)
      : [];
  const codexArgs =
    input.id === "codex" || input.sessionId ? await resources.codexLaunchArgs(input.sessionId) : [];
  if (input.sessionId) {
    const searchPath = plan.args[0];
    if (plan.command !== "/usr/bin/env" || !searchPath?.startsWith("PATH="))
      throw new Error("Unexpected native terminal launch environment");
    const executables = await tools.childExecutables(input.id === "claude-squad");
    const directProvider = input.id === "claude" || input.id === "codex" ? input.id : undefined;
    const commandIndex = plan.args.findIndex((arg) => path.isAbsolute(arg));
    if (input.id === "goose")
      await prepareGooseContext(plan, input.sessionId, resources, commandIndex);
    if (directProvider) {
      if (commandIndex < 0) throw new Error("The original native command is missing");
      executables[directProvider] = plan.args[commandIndex];
    }
    const bin = await prepareContextShims({
      root,
      sessionId: input.sessionId,
      contextPath: input.contextPath,
      searchPath: searchPath.slice(5),
      executables,
      claudeArgs,
      codexArgs,
    });
    plan.args[0] = `PATH=${bin}${path.delimiter}${searchPath.slice(5)}`;
    if (directProvider) plan.args[commandIndex] = path.join(bin, directProvider);
    plan.notes.push(
      "Claude/Codex children that inherit this terminal environment share the selected FamiliarAgent session through MCP. Existing external daemons and absolute native command paths require explicit configuration.",
    );
  } else if (input.id === "claude") plan.args.push(...claudeArgs);
  else if (input.id === "codex") plan.args.push(...codexArgs);
}

async function prepareGooseContext(
  plan: ToolPlan,
  sessionId: string,
  resources: ResourceLibrary,
  commandIndex: number,
): Promise<void> {
  const args = plan.args.slice(commandIndex + 1);
  if (!["session", "run"].includes(args[0] ?? "") || (args[1] && !args[1].startsWith("-")))
    throw new Error(
      "To connect a shared session, configure Goose with its session or run command.",
    );
  if (args.some((arg) => arg === "--container" || arg.startsWith("--container=")))
    throw new Error("Goose container extensions require an explicit FamiliarAgent path mapping.");
  for (let index = 0; index < args.length; index++) {
    let value: string | undefined;
    if (args[index] === "--with-extension") value = args[index + 1];
    else if (args[index].startsWith("--with-extension="))
      value = args[index].slice("--with-extension=".length);
    if (value?.toLowerCase().startsWith("familiar_context:"))
      throw new Error(
        "Goose already defines familiar_context. Remove that override before connecting this session.",
      );
  }
  const goose = await resources.gooseLaunch(sessionId);
  const separator = plan.args.indexOf("--", commandIndex + 1);
  plan.args.splice(separator < 0 ? plan.args.length : separator, 0, ...goose.args);
  plan.args.splice(
    commandIndex,
    0,
    ...Object.entries(goose.env).map(([key, value]) => `${key}=${value}`),
  );
  plan.notes.push(
    "Goose receives the selected session through its native familiar_context stdio extension. Ask it to use familiar_context, familiar_history and familiar_memory; its own profile, provider and conversation remain Goose-owned.",
  );
}
