import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { prepareProviderSignIn } from "./familiar-provider-setup-action";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
const CARD_STYLE = { padding: 16, gap: 12 };
const ROW_STYLE = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;
export function FamiliarProviderSetup({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setup = useCallback(
    async (provider: "codex" | "claude") => {
      if (!client || busy) return;
      setBusy(true);
      setError("");
      try {
        const prepared = await prepareProviderSignIn(client, provider);
        const workspace = normalizeWorkspaceDescriptor(prepared.workspace);
        useSessionStore.getState().mergeWorkspaces(serverId, [workspace]);
        navigateToWorkspace({
          serverId,
          workspaceId: workspace.id,
          target: { kind: "terminal", terminalId: prepared.terminalId },
        });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(false);
      }
    },
    [client, busy, serverId],
  );
  const codex = useCallback(() => {
    void setup("codex");
  }, [setup]);
  const claude = useCallback(() => {
    void setup("claude");
  }, [setup]);
  return (
    <SettingsSection title="Agent setup & sign-in">
      <View style={CARD_STYLE}>
        <Text style={settingsStyles.rowHint}>
          Open the selected host’s terminal for official sign-in. Missing tools are installed in
          your user folder. Existing tools and accounts are reused. Return here and refresh after
          signing in.
        </Text>
        <View style={ROW_STYLE}>
          <Button variant="outline" disabled={busy} onPress={codex}>
            Set up Codex
          </Button>
          <Button variant="outline" disabled={busy} onPress={claude}>
            Set up Claude Code
          </Button>
        </View>
        {error ? (
          <Text selectable style={settingsStyles.rowHint}>
            {error}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
