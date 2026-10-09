import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { familiarHubTarget } from "@/workspace-tabs/launcher/internal/familiar-context";

/** Keep the original conversation visible while opening its companion Hub. */
export function openFamiliarHub(input: Parameters<typeof familiarHubTarget>[0]): void {
  const workspaceKey = `${input.serverId}:${input.workspaceId}`;
  const paneId = useWorkspaceLayoutStore.getState().showExplorerSidebar(workspaceKey);
  if (!paneId) throw new Error("The Familiar Hub side panel is unavailable.");
  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    target: familiarHubTarget(input),
    placement: { mode: "pane", paneId },
  });
}
