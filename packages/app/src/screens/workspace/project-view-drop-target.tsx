import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { resolveSplitDropPosition } from "@/components/split-drop-zone";
import { useSessionStore } from "@/stores/session-store";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import { PROJECT_VIEW_DRAG_MIME, parseProjectViewDragPayload } from "./project-view-drag";
import type { ProjectDropPosition } from "./project-views";

interface ProjectViewDropInput {
  disabled?: boolean;
  tab?: boolean;
  onDrop: (selection: ActiveWorkspaceSelection, position: ProjectDropPosition) => void;
}

/** Intercept only project drags; file uploads and native tool interactions retain their handlers. */
export function useProjectViewDrop({
  disabled = false,
  tab = false,
  onDrop,
}: ProjectViewDropInput) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<ProjectDropPosition | null>(null);
  const ref = useCallback(
    (node: View | null) => setElement(node as unknown as HTMLElement | null),
    [],
  );
  useEffect(() => {
    if (!isWeb || !element || disabled) return;
    const accepts = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes(PROJECT_VIEW_DRAG_MIME);
    const locate = (event: DragEvent): ProjectDropPosition => {
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (tab) return x < rect.width / 2 ? "left" : "right";
      return resolveSplitDropPosition({
        width: rect.width,
        height: rect.height,
        x,
        y: event.clientY - rect.top,
      });
    };
    const clear = () => setPosition(null);
    const over = (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      setPosition(locate(event));
    };
    const leave = (event: DragEvent) => {
      if (!accepts(event)) return;
      event.stopPropagation();
      if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
      clear();
    };
    const drop = (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      clear();
      const payload = parseProjectViewDragPayload(
        event.dataTransfer!.getData(PROJECT_VIEW_DRAG_MIME),
      );
      if (!payload) return;
      const workspace = useSessionStore
        .getState()
        .sessions[payload.serverId]?.workspaces.get(payload.workspaceId);
      if (!workspace || workspace.archivingAt) return;
      onDrop({ serverId: payload.serverId, workspaceId: payload.workspaceId }, locate(event));
    };
    element.addEventListener("dragenter", over, true);
    element.addEventListener("dragover", over, true);
    element.addEventListener("dragleave", leave, true);
    element.addEventListener("drop", drop, true);
    window.addEventListener("dragend", clear);
    window.addEventListener("blur", clear);
    return () => {
      element.removeEventListener("dragenter", over, true);
      element.removeEventListener("dragover", over, true);
      element.removeEventListener("dragleave", leave, true);
      element.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("blur", clear);
    };
  }, [disabled, element, onDrop, tab]);
  return { ref, position: disabled ? null : position };
}

export function ProjectViewDropTarget({
  children,
  testID,
  ...input
}: ProjectViewDropInput & { children: ReactNode; testID: string }) {
  const { ref, position } = useProjectViewDrop(input);
  return (
    <View ref={ref} collapsable={false} style={styles.root} testID={testID}>
      {children}
      {position ? (
        <View
          pointerEvents="none"
          style={[styles.preview, styles[position]]}
          testID={`${testID}-preview-${position}`}
        >
          <Text style={styles.hint}>
            {position === "center" ? "Move project here" : "Split project here"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minWidth: 0, minHeight: 0 },
  preview: {
    position: "absolute",
    zIndex: 100,
    borderWidth: 2,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface1,
    opacity: 0.85,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  hint: { color: theme.colors.foreground, fontSize: 13, padding: 8 },
  left: { left: 0, top: 0, bottom: 0, width: "50%" },
  right: { right: 0, top: 0, bottom: 0, width: "50%" },
  top: { left: 0, right: 0, top: 0, height: "50%" },
  bottom: { left: 0, right: 0, bottom: 0, height: "50%" },
  center: { left: 4, right: 4, top: 4, bottom: 4 },
}));
