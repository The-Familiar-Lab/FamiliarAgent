import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { Button } from "@/components/ui/button";
import { SortableInlineList } from "@/components/sortable-inline-list";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  navigateToWorkspace,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useProjectViewStore } from "@/stores/project-view-store";
import { areWorkspaceSelectionsEqual, getWorkspaceSelectionKey } from "./workspace-deck-retention";
import { isNative } from "@/constants/platform";
import type { ProjectViews } from "./project-views";

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
  const [adding, setAdding] = useState(false);
  const { close, layout, reorder } = useProjectViewStore();
  const closeView = useCallback(
    (selection: ActiveWorkspaceSelection) => {
      close(selection);
      if (!areWorkspaceSelectionsEqual(selection, active)) return;
      const next = state.views.find((item) => !areWorkspaceSelectionsEqual(item, selection));
      if (next) navigateToWorkspace(next);
      else router.replace("/open-project");
    },
    [close, active, state.views],
  );
  const reorderViews = useCallback(
    (items: ActiveWorkspaceSelection[]) => reorder(items.map(getWorkspaceSelectionKey)),
    [reorder],
  );
  const renderTab = useCallback(
    (info: DraggableRenderItemInfo<ActiveWorkspaceSelection>) => (
      <ProjectTab
        info={info}
        selected={areWorkspaceSelectionsEqual(info.item, active)}
        onClose={closeView}
      />
    ),
    [active, closeView],
  );
  const add = useCallback(() => setAdding(true), []);
  const dismiss = useCallback(() => setAdding(false), []);
  const single = useCallback(() => layout(null, active), [layout, active]);
  const horizontal = useCallback(() => layout("horizontal", active), [layout, active]);
  const vertical = useCallback(() => layout("vertical", active), [layout, active]);
  return (
    <View style={styles.root}>
      <ScrollView
        horizontal
        contentContainerStyle={styles.tabs}
        showsHorizontalScrollIndicator={false}
      >
        <SortableInlineList
          data={state.views}
          keyExtractor={getWorkspaceSelectionKey}
          useDragHandle
          onDragEnd={reorderViews}
          renderItem={renderTab}
        />
      </ScrollView>
      <View style={styles.actions}>
        <Button size="sm" variant="ghost" onPress={add}>
          Add project
        </Button>
        {!isNative ? (
          <>
            <Button
              size="sm"
              variant={state.direction === null ? "outline" : "ghost"}
              onPress={single}
            >
              Single view
            </Button>
            <Button
              size="sm"
              variant={state.direction === "horizontal" ? "outline" : "ghost"}
              disabled={state.views.length < 2}
              onPress={horizontal}
            >
              Side by side
            </Button>
            <Button
              size="sm"
              variant={state.direction === "vertical" ? "outline" : "ghost"}
              disabled={state.views.length < 2}
              onPress={vertical}
            >
              Stacked
            </Button>
          </>
        ) : null}
      </View>
      {adding ? <AddProjectView active={active} onClose={dismiss} /> : null}
    </View>
  );
}

function ProjectTab({
  info,
  selected,
  onClose,
}: {
  info: DraggableRenderItemInfo<ActiveWorkspaceSelection>;
  selected: boolean;
  onClose: (selection: ActiveWorkspaceSelection) => void;
}) {
  const { item, drag, dragHandleProps } = info;
  const focus = useCallback(() => navigateToWorkspace(item), [item]);
  const close = useCallback(() => onClose(item), [onClose, item]);
  return (
    <View style={[styles.tab, selected && styles.selected]}>
      <Pressable
        accessibilityLabel="Move project view"
        onLongPress={drag}
        ref={dragHandleProps?.setActivatorNodeRef}
        {...dragHandleProps?.attributes}
        {...dragHandleProps?.listeners}
        style={styles.control}
      >
        <Text style={styles.muted}>⠿</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Focus project ${item.workspaceId} on ${item.serverId}`}
        onPress={focus}
      >
        <ProjectLabel selection={item} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Close project view ${item.workspaceId}`}
        accessibilityHint="Closes this view. Sessions and files stay on the server."
        onPress={close}
        style={styles.control}
      >
        <Text style={styles.muted}>×</Text>
      </Pressable>
    </View>
  );
}

function AddProjectView({
  active,
  onClose,
}: {
  active: ActiveWorkspaceSelection;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const hosts = useHosts();
  const sessions = useSessionStore((state) => state.sessions);
  const openProject = useOpenAddProject();
  const options = hosts
    .flatMap((host) =>
      [...(sessions[host.serverId]?.workspaces.values() ?? [])]
        .filter((workspace) => !workspace.archivingAt)
        .map((workspace) => ({ host, workspace })),
    )
    .filter(({ host, workspace }) =>
      `${host.label} ${workspace.projectDisplayName} ${workspace.title ?? ""} ${workspace.workspaceDirectory}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  const choose = useCallback(
    (selection: ActiveWorkspaceSelection) => {
      useProjectViewStore.getState().show(selection, !isNative);
      navigateToWorkspace(selection);
      onClose();
    },
    [onClose],
  );
  const openFolder = useCallback(() => {
    if (!isNative) useProjectViewStore.getState().layout("horizontal", active);
    onClose();
    openProject();
  }, [active, onClose, openProject]);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.dialog}>
          <Text style={styles.heading}>Add project view</Text>
          <Text style={styles.muted}>
            Show another project beside this one. Each project keeps its own sessions, terminals and
            files.
          </Text>
          <TextInput
            initialValue=""
            onChangeText={setQuery}
            accessibilityLabel="Find a project"
            placeholder="Find a project or server"
            style={styles.input}
          />
          <ScrollView style={styles.options}>
            {options.map(({ host, workspace }) => (
              <ProjectOption
                key={getWorkspaceSelectionKey({
                  serverId: host.serverId,
                  workspaceId: workspace.id,
                })}
                serverId={host.serverId}
                label={host.label}
                workspace={workspace}
                onChoose={choose}
              />
            ))}
            {!options.length ? (
              <Text style={styles.muted}>No matching projects. Open a folder to add one.</Text>
            ) : null}
          </ScrollView>
          <View style={styles.actions}>
            <Button variant="outline" onPress={onClose}>
              Cancel
            </Button>
            <Button onPress={openFolder}>Open another folder</Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ProjectOption({
  serverId,
  label,
  workspace,
  onChoose,
}: {
  serverId: string;
  label: string;
  workspace: WorkspaceDescriptor;
  onChoose: (selection: ActiveWorkspaceSelection) => void;
}) {
  const choose = useCallback(
    () => onChoose({ serverId, workspaceId: workspace.id }),
    [onChoose, serverId, workspace.id],
  );
  return (
    <Pressable style={styles.option} accessibilityRole="button" onPress={choose}>
      <Text style={styles.text}>
        {workspace.projectDisplayName} · {label}
      </Text>
      <Text style={styles.muted}>
        {workspace.title ?? workspace.name} · {workspace.workspaceDirectory}
      </Text>
    </Pressable>
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
  label: { maxWidth: 240, paddingVertical: 4, paddingHorizontal: 6 },
  control: { padding: 8 },
  actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, padding: 4 },
  text: { color: theme.colors.foreground, fontSize: 13 },
  muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  dialog: {
    width: 640,
    maxWidth: "100%",
    maxHeight: "80%",
    padding: 16,
    gap: 12,
    backgroundColor: theme.colors.surface0,
    borderRadius: 12,
  },
  heading: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" },
  input: {
    padding: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 6,
    color: theme.colors.foreground,
  },
  options: { maxHeight: 400 },
  option: { gap: 4, paddingVertical: 10 },
}));
