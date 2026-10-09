import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { createPluginHostNavigation, preparePluginBrowserUrl } from "./host-navigation-model";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { router } from "expo-router";
import { buildSettingsAddHostRoute } from "@/utils/host-routes";
import { publicSshHostConnection } from "./hosts";

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(
    () =>
      createPluginHostNavigation(serverId, {
        browserAvailable: getIsElectron(),
        openAgent: navigateToAgent,
        openWorkspace: navigateToWorkspace,
        createBrowser: createWorkspaceBrowser,
        openServers: () => router.push(buildSettingsAddHostRoute(Date.now())),
        prepareBrowserUrl: prepareHostBrowserUrl,
        resolveWorkspace: ({ serverId: targetServerId, workspaceId }) =>
          resolveWorkspaceMapKeyByIdentity({
            workspaces: useSessionStore.getState().sessions[targetServerId]?.workspaces,
            workspaceId,
          }),
      }),
    [serverId],
  );
}

export function prepareHostBrowserUrl({
  serverId: targetServerId,
  url,
  preserveHost,
}: {
  serverId: string;
  url: string;
  preserveHost?: boolean;
}): Promise<string> {
  const registry = getHostRuntimeStore();
  const state = registry.getSnapshot(targetServerId);
  const configured = registry.getHosts().find((item) => item.serverId === targetServerId);
  const sshEndpoint = publicSshHostConnection(state, configured?.connections);
  const requiresSsh =
    state?.activeConnection?.type === "remoteSsh" ||
    !!configured?.connections.some((item) => item.type === "remoteSsh");
  return preparePluginBrowserUrl({ url, sshEndpoint, requiresSsh, preserveHost }, (input) =>
    invokeDesktopCommand<{ url: string }>("familiar_prepare_remote_web", input),
  );
}
