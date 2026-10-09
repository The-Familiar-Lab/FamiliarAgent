import { useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { useHosts } from "@/runtime/host-runtime";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  navigateToWorkspace,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useProjectViewStore } from "@/stores/project-view-store";
import { areWorkspaceSelectionsEqual, getWorkspaceSelectionKey } from "./workspace-deck-retention";
import { useProjectViewDragSource } from "./use-project-view-drag-source";
import { useProjectViewDrop } from "./project-view-drop-target";
import type { ProjectDropPosition, ProjectViews } from "./project-views";

function ProjectLabel({ selection }: { selection: ActiveWorkspaceSelection }) {
  const workspace = useWorkspace(selection.serverId, selection.workspaceId);
  const host = useHosts().find((item) => item.serverId === selection.serverId);
  return (
    <View style={styles.label}>
      <Text numberOfLines={1} style={styles.text}>
        {workspace?.projectDisplayName ?? "Project"}
        {workspace?.title ? ` · ${workspace.title}` : ""}
      </Text>
      <Text numberOfLines={1} style={styles.muted}>
        {host?.label ?? "Offline server"}
      </Text>
    </View>
  );
}

export function ProjectViewsBar({
  active,
  state,
}: {
  active: ActiveWorkspaceSelection;
  state: ProjectViews;
}) {
  const closeView = useCallback(
    (selection: ActiveWorkspaceSelection) => {
      const store = useProjectViewStore.getState();
      store.close(selection);
      if (!areWorkspaceSelectionsEqual(selection, active)) return;
      const nextState = useProjectViewStore.getState().state;
      const next =
        nextState.views.find((item) => getWorkspaceSelectionKey(item) === nextState.focusedKey) ??
        nextState.views[0];
      if (next) navigateToWorkspace(next);
      else router.replace("/open-project");
    },
    [active],
  );
  return (
    <View style={styles.root}>
      <ScrollView
        horizontal
        contentContainerStyle={styles.tabs}
        showsHorizontalScrollIndicator={false}
      >
        {state.views.map((selection) => (
          <ProjectTab
            key={getWorkspaceSelectionKey(selection)}
            selection={selection}
            selected={areWorkspaceSelectionsEqual(selection, active)}
            onClose={closeView}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function ProjectTab({
  selection,
  selected,
  onClose,
}: {
  selection: ActiveWorkspaceSelection;
  selected: boolean;
  onClose: (selection: ActiveWorkspaceSelection) => void;
}) {
  const focus = useCallback(() => navigateToWorkspace(selection), [selection]);
  const close = useCallback(() => onClose(selection), [onClose, selection]);
  const dragRef = useProjectViewDragSource({ selection });
  const reorder = useCallback(
    (source: ActiveWorkspaceSelection, position: ProjectDropPosition) => {
      if (areWorkspaceSelectionsEqual(source, selection)) return;
      const store = useProjectViewStore.getState();
      const sourceKey = getWorkspaceSelectionKey(source);
      if (!store.state.views.some((item) => getWorkspaceSelectionKey(item) === sourceKey))
        store.show(source);
      const keys = useProjectViewStore
        .getState()
        .state.views.map(getWorkspaceSelectionKey)
        .filter((key) => key !== sourceKey);
      const target = keys.indexOf(getWorkspaceSelectionKey(selection));
      if (target < 0) return;
      keys.splice(target + (position === "right" ? 1 : 0), 0, sourceKey);
      store.reorder(keys);
      navigateToWorkspace(source);
    },
    [selection],
  );
  const { ref: dropRef, position } = useProjectViewDrop({ tab: true, onDrop: reorder });
  return (
    <View
      ref={dropRef}
      collapsable={false}
      style={[
        styles.tab,
        selected && styles.selected,
        position === "left" && styles.dropLeft,
        position === "right" && styles.dropRight,
      ]}
    >
      <Pressable
        ref={dragRef}
        accessibilityRole="button"
        accessibilityLabel={`Focus project ${selection.workspaceId} on ${selection.serverId}`}
        accessibilityHint="Drag to a screen edge to split projects, or along this bar to reorder."
        onPress={focus}
      >
        <ProjectLabel selection={selection} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Close project view ${selection.workspaceId}`}
        accessibilityHint="Closes this view. Sessions and files stay on the server."
        onPress={close}
        style={styles.control}
      >
        <Text style={styles.muted}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  tabs: { flexDirection: "row", padding: 4, gap: 4 },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: 6,
  },
  selected: { borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
  dropLeft: { borderLeftColor: theme.colors.accent },
  dropRight: { borderRightColor: theme.colors.accent },
  label: { maxWidth: 240, paddingVertical: 4, paddingHorizontal: 6 },
  control: { padding: 8 },
  text: { color: theme.colors.foreground, fontSize: 13 },
  muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
}));
