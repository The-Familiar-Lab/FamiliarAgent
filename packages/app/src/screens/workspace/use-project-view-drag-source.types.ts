import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

export interface ProjectViewDragSourceInput {
  selection: ActiveWorkspaceSelection;
  disabled?: boolean;
}
