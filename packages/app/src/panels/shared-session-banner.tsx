import React, { memo, useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { openFamiliarHub } from "@/plugins/familiar-navigation";
import { useSessionStore } from "@/stores/session-store";

interface SharedSessionBannerProps {
  serverId: string;
  workspaceId: string;
  agentId: string;
}

export const SharedSessionBanner = memo(function SharedSessionBanner({
  serverId,
  workspaceId,
  agentId,
}: SharedSessionBannerProps) {
  const isLinked = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const labels = (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.labels;
    return Boolean(labels?.familiarSession?.trim() && labels?.familiarProject?.trim());
  });
  const exists = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return Boolean(session?.agents.has(agentId) || session?.agentDetails.has(agentId));
  });
  const openHub = useCallback(() => {
    openFamiliarHub({ serverId, workspaceId, agentId });
  }, [serverId, workspaceId, agentId]);

  if (!exists) return null;

  return (
    <View style={styles.banner} testID={isLinked ? "shared-session-banner" : "familiar-hub-entry"}>
      {isLinked ? (
        <View style={styles.message}>
          <Text style={styles.title}>Shared session connected</Text>
          <Text style={styles.description}>
            Memory and earlier conversations are available to this agent.
          </Text>
        </View>
      ) : null}
      <Button size="sm" variant="secondary" onPress={openHub}>
        Open Familiar Hub
      </Button>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  message: { flexGrow: 1, flexShrink: 1, gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
