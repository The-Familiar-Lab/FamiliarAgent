import { useCallback, useEffect, useState, type RefCallback } from "react";
import type { View } from "react-native";
import { PROJECT_VIEW_DRAG_MIME, serializeProjectViewDragPayload } from "./project-view-drag";
import type { ProjectViewDragSourceInput } from "./use-project-view-drag-source.types";

/** Native drag crosses the independent sidebar and workspace dnd-kit contexts. */
export function useProjectViewDragSource({
  selection,
  disabled = false,
}: ProjectViewDragSourceInput): RefCallback<View> {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const ref = useCallback(
    (node: View | null) => setElement(node as unknown as HTMLElement | null),
    [],
  );
  const { serverId, workspaceId } = selection;
  useEffect(() => {
    if (!element || disabled) return;
    const serialized = serializeProjectViewDragPayload({ version: 1, serverId, workspaceId });
    const previousDraggable = element.draggable;
    let dragged = false;
    element.draggable = true;
    const isolatePrimaryDrag = (event: MouseEvent | PointerEvent) => {
      if (event.button !== 0 || ("pointerType" in event && event.pointerType !== "mouse")) return;
      dragged = false;
      // Keep browser drag/click defaults, but do not arm an ancestor's local reorder sensor.
      event.stopPropagation();
    };
    const start = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      dragged = true;
      event.dataTransfer.effectAllowed = "copyMove";
      event.dataTransfer.setData(PROJECT_VIEW_DRAG_MIME, serialized);
      event.stopPropagation();
    };
    const click = (event: MouseEvent) => {
      if (!dragged || event.detail === 0) return;
      dragged = false;
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener("pointerdown", isolatePrimaryDrag, true);
    element.addEventListener("mousedown", isolatePrimaryDrag, true);
    element.addEventListener("dragstart", start);
    element.addEventListener("click", click, true);
    return () => {
      element.draggable = previousDraggable;
      element.removeEventListener("pointerdown", isolatePrimaryDrag, true);
      element.removeEventListener("mousedown", isolatePrimaryDrag, true);
      element.removeEventListener("dragstart", start);
      element.removeEventListener("click", click, true);
    };
  }, [disabled, element, serverId, workspaceId]);
  return ref;
}
