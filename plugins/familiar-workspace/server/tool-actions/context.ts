import path from "node:path";
import type { ToolCatalog } from "../tool-catalog/service.js";
import { ResourceLibrary } from "../tool-catalog/resources.js";
import { prepareContextShims } from "../tool-catalog/context-shims.js";
import { gooseAdapterBins, gooseProviderEnvironment } from "../tool-catalog/goose-provider.js";
import { gooseContextReadEnvironment } from "../tool-catalog/claude-acp-reads.js";

const CHILD_CONTEXT_TOOLS = new Set([
  "goose",
  "superharness",
  "claude-squad",
  "hydra",
  "alethe",
  "orca",
  "codey",
  "codeg",
  "agents",
  "openharness",
]);
export function nativeActionContext(root: string, catalog: ToolCatalog) {
  const resources = new ResourceLibrary(root);
  return async (
    toolId: string,
    sessionId: string,
  ): Promise<{ args: string[]; env: Record<string, string> }> => {
    if (!CHILD_CONTEXT_TOOLS.has(toolId))
      return { args: [], env: { FAMILIAR_SESSION_ID: sessionId } };
    const searchPath = catalog.searchPath();
    const executables = await catalog.childExecutables(toolId === "claude-squad");
    const bin = await prepareContextShims({
      root,
      sessionId,
      searchPath,
      executables,
      claudeArgs: await resources.claudeLaunchArgs(sessionId),
      codexArgs: await resources.codexLaunchArgs(sessionId),
    });
    const goose =
      toolId === "goose" ? await resources.gooseLaunch(sessionId) : { args: [], env: {} };
    return {
      args: goose.args,
      env: {
        ...goose.env,
        ...(toolId === "goose" ? await gooseProviderEnvironment(root) : {}),
        ...gooseContextReadEnvironment(goose.args),
        FAMILIAR_SESSION_ID: sessionId,
        ...(toolId === "claude-squad" && executables.claude
          ? { FAMILIAR_CLAUDE_EXECUTABLE: executables.claude }
          : {}),
        PATH: [bin, searchPath, ...(toolId === "goose" ? gooseAdapterBins(root) : [])].join(
          path.delimiter,
        ),
      },
    };
  };
}
