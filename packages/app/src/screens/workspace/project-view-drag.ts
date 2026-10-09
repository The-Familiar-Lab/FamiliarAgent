import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

export const PROJECT_VIEW_DRAG_MIME = "application/x-familiar-project-view+json";
const MAX_PAYLOAD_CHARACTERS = 4096;
const MAX_ID_CHARACTERS = 1024;

export interface ProjectViewDragPayload extends ActiveWorkspaceSelection {
  version: 1;
}

export function parseProjectViewDragPayload(serialized: string): ProjectViewDragPayload | null {
  if (serialized.length > MAX_PAYLOAD_CHARACTERS) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.version !== 1 ||
    !validId(record.serverId) ||
    !validId(record.workspaceId)
  )
    return null;
  return { version: 1, serverId: record.serverId, workspaceId: record.workspaceId };
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_ID_CHARACTERS &&
    !/\p{Cc}/u.test(value)
  );
}

export function serializeProjectViewDragPayload(payload: ProjectViewDragPayload): string {
  const serialized = JSON.stringify(payload);
  if (!parseProjectViewDragPayload(serialized))
    throw new Error("Invalid project view drag selection");
  return serialized;
}
