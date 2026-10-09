import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Terminal } from "lucide-react-native";
import { Text, View } from "react-native";
import invariant from "tiny-invariant";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { deriveTerminalActivityStatusBucket } from "@getpaseo/protocol/terminal-activity";
import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser, getBrowserRecord, useBrowserStore } from "@/desktop/browser/store";
import { prepareHostBrowserUrl } from "@/plugins/host-navigation";
import { openFamiliarHub } from "@/plugins/familiar-navigation";
import { Button } from "@/components/ui/button";
import type { OpenTerminalWebView } from "@/terminal/runtime/use-terminal-web-view";
import { TerminalPane } from "@/components/terminal-pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { queryClient } from "@/data/query-client";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory, useWorkspaceFields } from "@/stores/session-store-hooks";

type ListTerminalsPayload = ListTerminalsResponse["payload"];
const PANEL_STYLE = { flex: 1 } as const;
const SESSION_LINK_STYLE = { alignItems: "flex-end", padding: 4 } as const;

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function useTerminalPanelDescriptor(
  target: { kind: "terminal"; terminalId: string },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[context.serverId]?.client ?? null);
  const workspaceDirectory = useWorkspaceDirectory(context.serverId, context.workspaceId);
  const terminalsQuery = useQuery(
    {
      queryKey: buildTerminalsQueryKey(
        context.serverId,
        workspaceDirectory,
        context.workspaceId || null,
      ),
      enabled: Boolean(client && workspaceDirectory),
      queryFn: async (): Promise<ListTerminalsPayload> => {
        if (!client || !workspaceDirectory) {
          throw new Error("Workspace directory not found");
        }
        return client.listTerminals(workspaceDirectory, undefined, {
          workspaceId: context.workspaceId || undefined,
        });
      },
      staleTime: 5_000,
    },
    queryClient,
  );
  const terminal =
    terminalsQuery.data?.terminals.find((entry) => entry.id === target.terminalId) ?? null;
  const label =
    trimNonEmpty(terminal?.title ?? terminal?.name ?? null) ??
    t("workspace.tabs.fallback.terminal");

  return {
    label,
    subtitle: t("workspace.tabs.fallback.terminal"),
    tooltip: label,
    titleState: terminalsQuery.isPending ? "loading" : "ready",
    icon: Terminal,
    statusBucket: deriveTerminalActivityStatusBucket(terminal?.activity),
  };
}

function TerminalPanel() {
  const { serverId, workspaceId, target, openFileInWorkspace, openTab } = usePaneContext();
  invariant(target.kind === "terminal", "TerminalPanel requires terminal target");
  const { isWorkspaceFocused, isPaneFocused } = usePaneFocus();
  const workspaceFields = useWorkspaceFields(serverId, workspaceId, (w) => ({
    workspaceDirectory: w.workspaceDirectory,
    isGitCheckout: w.projectKind === "git",
  }));
  const workspaceDirectory = workspaceFields?.workspaceDirectory || null;
  const isGitCheckout = workspaceFields?.isGitCheckout ?? false;
  const openCompactFileExplorer = usePanelStore((state) => state.openCompactFileExplorer);
  const openHub = useCallback(() => {
    if (!workspaceDirectory) return;
    openFamiliarHub({
      serverId,
      workspaceId,
      cwd: workspaceDirectory,
      terminalId: target.terminalId,
    });
  }, [serverId, workspaceId, workspaceDirectory, target.terminalId]);
  const handleOpenFileExplorer = useCallback(() => {
    if (!workspaceDirectory) {
      return;
    }
    openCompactFileExplorer({
      serverId,
      cwd: workspaceDirectory,
      isGit: isGitCheckout,
    });
  }, [isGitCheckout, openCompactFileExplorer, serverId, workspaceDirectory]);
  const openWebView = useCallback<OpenTerminalWebView>(
    async (view, existingBrowserId, signal) => {
      const url = await prepareHostBrowserUrl({
        serverId,
        url: view.url,
        preserveHost: view.preserveHost,
      });
      if (signal.aborted) throw new Error("Terminal view closed.");
      const browserId =
        existingBrowserId && getBrowserRecord(existingBrowserId)
          ? existingBrowserId
          : createWorkspaceBrowser({ initialUrl: url, ephemeral: true }).browserId;
      if (getBrowserRecord(browserId)?.url !== url) {
        useBrowserStore.getState().updateBrowser(browserId, { url });
      }
      return { browserId, show: () => openTab({ kind: "browser", browserId }) };
    },
    [serverId, openTab],
  );

  if (!workspaceDirectory) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>Workspace directory not found.</Text>
      </View>
    );
  }

  return (
    <View style={PANEL_STYLE}>
      <View style={SESSION_LINK_STYLE}>
        <Button size="sm" variant="secondary" onPress={openHub}>
          View session activity
        </Button>
      </View>
      <TerminalPane
        serverId={serverId}
        cwd={workspaceDirectory}
        terminalId={target.terminalId}
        isWorkspaceFocused={isWorkspaceFocused}
        isPaneFocused={isPaneFocused}
        onOpenWebView={getIsElectron() ? openWebView : undefined}
        onOpenFileExplorer={handleOpenFileExplorer}
        onOpenWorkspaceFile={openFileInWorkspace}
      />
    </View>
  );
}

export const terminalPanelRegistration = definePanel("terminal", {
  component: TerminalPanel,
  useDescriptor: useTerminalPanelDescriptor,
});
