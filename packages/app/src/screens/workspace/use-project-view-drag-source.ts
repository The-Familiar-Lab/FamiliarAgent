import type { RefCallback } from "react";
import type { View } from "react-native";
import type { ProjectViewDragSourceInput } from "./use-project-view-drag-source.types";

export function useProjectViewDragSource(
  _input: ProjectViewDragSourceInput,
): RefCallback<View> | undefined {
  return undefined;
}
