import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";
import type { LaunchTarget } from "@/new-workspace-launch/target";
import type { AgentAttachment } from "@getpaseo/protocol/messages";

function isLikelyWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path);
}

function isChatHistoryTextAttachment(attachment: AgentAttachment): boolean {
  return attachment.type === "text" && attachment.contextKind === "chat_history";
}

export function getWorkspaceNamingAttachments(
  attachments: readonly AgentAttachment[],
): AgentAttachment[] {
  return attachments.filter((attachment) => !isChatHistoryTextAttachment(attachment));
}

export function remapDraftCwdToWorkspace(input: {
  cwd: string;
  sourceDirectory?: string | null;
  workspaceDirectory: string;
}): string {
  const cwd = input.cwd.trim();
  const sourceDirectory = input.sourceDirectory?.trim();
  const workspaceDirectory = input.workspaceDirectory.trim();
  if (!cwd || !sourceDirectory) {
    return workspaceDirectory;
  }
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedSource = sourceDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
  const compareCaseInsensitively =
    isLikelyWindowsPath(normalizedCwd) || isLikelyWindowsPath(normalizedSource);
  const comparableCwd = compareCaseInsensitively ? normalizedCwd.toLowerCase() : normalizedCwd;
  const comparableSource = compareCaseInsensitively
    ? normalizedSource.toLowerCase()
    : normalizedSource;
  if (comparableCwd === comparableSource) {
    return workspaceDirectory;
  }
  const relativePath = comparableCwd.startsWith(`${comparableSource}/`)
    ? normalizedCwd.slice(normalizedSource.length + 1)
    : "";
  if (!relativePath) {
    return workspaceDirectory;
  }
  const separator =
    workspaceDirectory.includes("\\") && !workspaceDirectory.includes("/") ? "\\" : "/";
  return [workspaceDirectory.replace(/[\\/]+$/, ""), ...relativePath.split("/")]
    .filter(Boolean)
    .join(separator);
}

export function portableForkSetup(setup: WorkspaceDraftTabSetup): WorkspaceDraftTabSetup {
  return {
    provider: setup.provider,
    cwd: "",
    modeId: null,
    model: null,
    thinkingOptionId: null,
    featureValues: {},
  };
}

export function forkLaunchTarget(
  manual: LaunchTarget | null,
  preferred: LaunchTarget | undefined,
  hasFork: boolean,
): LaunchTarget {
  return manual ?? (hasFork ? { kind: "chat" } : (preferred ?? { kind: "chat" }));
}
