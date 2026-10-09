import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import { isHttpUrl } from "@/utils/http-url";

export async function preparePluginBrowserUrl(
  input: {
    url: string;
    sshEndpoint?: string;
    requiresSsh: boolean;
    preserveHost?: boolean;
  },
  forward: (input: {
    url: string;
    sshEndpoint: string;
    preserveHost?: boolean;
  }) => Promise<{ url: string }>,
): Promise<string> {
  if (!isHttpUrl(input.url)) throw new Error("Only absolute HTTP(S) URLs are supported.");
  const url = new URL(input.url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!loopback || !input.requiresSsh) return input.url;
  if (!input.sshEndpoint)
    throw new Error("Reconnect this server over SSH before opening its local web app.");
  const result = await forward({
    sshEndpoint: input.sshEndpoint,
    url: input.url,
    ...(input.preserveHost ? { preserveHost: true } : {}),
  });
  if (!isHttpUrl(result.url))
    throw new Error("SSH forwarding did not return a usable web address.");
  const prepared = new URL(result.url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(prepared.hostname) ||
    prepared.protocol !== url.protocol
  )
    throw new Error("SSH forwarding returned an unexpected web address.");
  return result.url;
}

interface HostNavigationOwner {
  browserAvailable: boolean;
  openAgent(input: { serverId: string; agentId: string }): void;
  openWorkspace(input: NavigateToWorkspaceInput): void;
  resolveWorkspace(input: { serverId: string; workspaceId: string }): string | null;
  createBrowser(input: { initialUrl: string; ephemeral?: boolean }): { browserId: string };
  openServers?(): void;
  prepareBrowserUrl?(input: {
    serverId: string;
    url: string;
    preserveHost?: boolean;
  }): Promise<string>;
}

export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
): NonNullable<PluginSurfaceProps["navigation"]> {
  function workspace(input: { workspaceId: string; serverId?: string }) {
    if (!input.workspaceId.trim()) throw new Error("workspaceId is required.");
    const destinationServerId = input.serverId ?? serverId;
    const destinationWorkspaceId = owner.resolveWorkspace({
      serverId: destinationServerId,
      workspaceId: input.workspaceId,
    });
    if (!destinationWorkspaceId) throw new Error("Workspace is unavailable on the requested host.");
    return {
      serverId: destinationServerId,
      workspaceId: destinationWorkspaceId,
    };
  }
  return {
    openServers: owner.openServers,
    openTerminal: ({ terminalId, ...input }) => {
      if (!terminalId.trim()) throw new Error("terminalId is required.");
      owner.openWorkspace({
        ...workspace(input),
        target: { kind: "terminal", terminalId },
      });
    },
    openAgent: ({ agentId, serverId: targetServerId }) =>
      owner.openAgent({ serverId: targetServerId ?? serverId, agentId }),
    openWorkspace: ({ workspaceId, serverId: targetServerId }) =>
      owner.openWorkspace({
        serverId: targetServerId ?? serverId,
        workspaceId,
      }),
    openBrowser: owner.browserAvailable
      ? ({ url, workspaceId, serverId: targetServerId, ephemeral, preserveHost }) => {
          if (!isHttpUrl(url)) throw new Error("Only absolute HTTP(S) URLs are supported.");
          const destination = workspace({
            serverId: targetServerId,
            workspaceId,
          });
          const open = (preparedUrl: string) => {
            if (!isHttpUrl(preparedUrl))
              throw new Error("Only absolute HTTP(S) URLs are supported.");
            // A workspace can be removed while an SSH tunnel is being prepared.
            const current = workspace({
              serverId: targetServerId,
              workspaceId,
            });
            const { browserId } = owner.createBrowser({
              initialUrl: preparedUrl,
              ...(ephemeral ? { ephemeral: true } : {}),
            });
            owner.openWorkspace({
              ...current,
              target: { kind: "browser", browserId },
            });
          };
          if (owner.prepareBrowserUrl)
            return owner
              .prepareBrowserUrl({
                serverId: destination.serverId,
                url,
                ...(preserveHost ? { preserveHost: true } : {}),
              })
              .then(open);
          open(url);
        }
      : undefined,
  };
}
