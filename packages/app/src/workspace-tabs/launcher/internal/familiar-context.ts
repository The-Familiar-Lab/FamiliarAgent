import {
  collectAllPanes,
  collectAllTabs,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { PluginWorkspaceTabTarget, WorkspaceTabTarget } from "@/workspace-tabs/model";

export const FAMILIAR_PLUGIN_ID = "familiar-workspace";
export const FAMILIAR_PANEL_ID = "shared";

function agentFromTarget(
  target: WorkspaceTabTarget | undefined,
  serverId: string,
): string | undefined {
  if (target?.kind === "agent") return target.agentId;
  if (target?.kind === "provider_subagent") return target.parentAgentId;
  if (target?.kind !== "plugin") return undefined;
  if (target.context === "agent") return target.agentId;
  if (target.pluginId === FAMILIAR_PLUGIN_ID && target.params?.serverId === serverId)
    return target.params.agentId;
  return undefined;
}

/** A supporting New tab inherits its visible conversation, never an unrelated host or hidden tab. */
export function resolveFamiliarAgent(input: {
  serverId: string;
  layout?: WorkspaceLayout;
  tabId?: string;
  paneId?: string;
}): string | undefined {
  const { layout, serverId } = input;
  if (!layout) return undefined;
  const panes = collectAllPanes(layout.root).filter((pane) => !pane.hidden);
  const tabs = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
  const selectedPane = panes.find((pane) => pane.id === (input.paneId ?? layout.focusedPaneId));
  let tabId = input.tabId ?? selectedPane?.focusedTabId;
  const visited = new Set<string>();
  while (tabId && !visited.has(tabId)) {
    visited.add(tabId);
    const agentId = agentFromTarget(tabs.get(tabId)?.target, serverId);
    if (agentId) return agentId;
    tabId = layout.parentTabIdByTabId?.[tabId];
  }
  // An explorer/new pane may own keyboard focus while the main conversation stays visible.
  const visible = panes.flatMap((pane) => {
    const agentId = agentFromTarget(tabs.get(pane.focusedTabId ?? "")?.target, serverId);
    return agentId ? [agentId] : [];
  });
  return new Set(visible).size === 1 ? visible[0] : undefined;
}

export function familiarHubTarget(input: {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  cwd?: string;
  toolId?: string;
}): PluginWorkspaceTabTarget {
  return {
    kind: "plugin",
    pluginId: FAMILIAR_PLUGIN_ID,
    panelId: FAMILIAR_PANEL_ID,
    context: "workspace",
    params: {
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.toolId ? { toolId: input.toolId, setup: "1" } : {}),
    },
  };
}
