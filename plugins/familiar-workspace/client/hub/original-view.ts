import { getPaseoClient, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ToolEntry, ToolPlan } from "../../shared/tool-catalog.js";
import type { CompositionEndpoint } from "../../shared/composition.js";

/** Creation and navigation are separate so linking can finish before the user leaves the Hub. */
export async function prepareOriginalView(input: {
  serverId: string;
  tool: ToolEntry;
  plan: ToolPlan;
  navigation: PluginSurfaceProps["navigation"];
}): Promise<{
  endpoint: Pick<CompositionEndpoint, "kind" | "agentId" | "workspaceId" | "cwd">;
  open: () => Promise<void>;
}> {
  const { serverId, tool, plan, navigation } = input;
  if (plan.url && !navigation?.openBrowser)
    throw new Error(
      "Open this tool in the FamiliarAgent desktop app to use its original web interface.",
    );
  if (!plan.url && plan.mode !== "desktop" && !navigation?.openTerminal)
    throw new Error(
      "This view cannot open original tool terminals. Open the Familiar Hub in a workspace.",
    );
  if (!plan.url && !plan.command) throw new Error("The tool did not return a launch command.");
  const api = getPaseoClient(serverId);
  const workspace = await api.workspaces.open({ cwd: plan.cwd });
  if (plan.url) {
    return {
      // URLs can contain short-lived access keys. Reopening prepares the original interface again.
      endpoint: { kind: "web", agentId: tool.id, workspaceId: workspace.id, cwd: plan.cwd },
      open: async () =>
        navigation!.openBrowser!({
          url: plan.url!,
          workspaceId: workspace.id,
          serverId,
          ephemeral: true,
        }),
    };
  }
  const terminal = await api.terminals.create({
    workspaceId: workspace.id,
    cwd: plan.cwd,
    name: `${plan.action === "install" ? "Install " : ""}${tool.name}`,
    command: plan.command!,
    args: plan.args,
  });
  return {
    endpoint: {
      kind: plan.mode === "desktop" ? "desktop" : "terminal",
      agentId: terminal.id,
      workspaceId: workspace.id,
      cwd: plan.cwd,
    },
    open: async () => {
      // Native app launchers commonly exit after handing off. Keep session activity visible.
      if (plan.mode !== "desktop")
        navigation!.openTerminal!({ serverId, workspaceId: workspace.id, terminalId: terminal.id });
    },
  };
}
