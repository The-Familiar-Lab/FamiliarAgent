import { TerminalWebViewRegistry } from "./terminal-web-view";
import type { TerminalState } from "@getpaseo/protocol/messages";

export interface WorkspaceTerminalSnapshots {
  get: (input: { terminalId: string }) => TerminalState | null;
  set: (input: { terminalId: string; state: TerminalState }) => void;
  clear: (input: { terminalId: string }) => void;
  prune: (input: { terminalIds: string[] }) => void;
}

export interface WorkspaceTerminalSession {
  scopeKey: string;
  snapshots: WorkspaceTerminalSnapshots;
  webViews: TerminalWebViewRegistry;
}

interface WorkspaceTerminalSessionRecord {
  snapshotByTerminalId: Map<string, TerminalState>;
  session: WorkspaceTerminalSession;
}

const sessionsByScopeKey = new Map<string, WorkspaceTerminalSessionRecord>();
const refCountByScopeKey = new Map<string, number>();

function createSnapshots(input: {
  snapshotByTerminalId: Map<string, TerminalState>;
  webViews: TerminalWebViewRegistry;
}): WorkspaceTerminalSnapshots {
  return {
    get: ({ terminalId }) => input.snapshotByTerminalId.get(terminalId) ?? null,
    set: ({ terminalId, state }) => {
      input.snapshotByTerminalId.set(terminalId, state);
    },
    clear: ({ terminalId }) => {
      input.snapshotByTerminalId.delete(terminalId);
    },
    prune: ({ terminalIds }) => {
      input.webViews.prune(terminalIds);
      const terminalIdSet = new Set(terminalIds);
      for (const terminalId of Array.from(input.snapshotByTerminalId.keys())) {
        if (!terminalIdSet.has(terminalId)) {
          input.snapshotByTerminalId.delete(terminalId);
        }
      }
    },
  };
}

export function getWorkspaceTerminalSession(input: { scopeKey: string }): WorkspaceTerminalSession {
  const existing = sessionsByScopeKey.get(input.scopeKey);
  if (existing) {
    return existing.session;
  }

  const snapshotByTerminalId = new Map<string, TerminalState>();
  const webViews = new TerminalWebViewRegistry();
  const session: WorkspaceTerminalSession = {
    webViews,
    scopeKey: input.scopeKey,
    snapshots: createSnapshots({
      snapshotByTerminalId,
      webViews,
    }),
  };

  sessionsByScopeKey.set(input.scopeKey, {
    snapshotByTerminalId,
    session,
  });
  return session;
}

export function retainWorkspaceTerminalSession(input: { scopeKey: string }): void {
  const current = refCountByScopeKey.get(input.scopeKey) ?? 0;
  refCountByScopeKey.set(input.scopeKey, current + 1);
}

export function releaseWorkspaceTerminalSession(input: { scopeKey: string }): void {
  const current = refCountByScopeKey.get(input.scopeKey) ?? 0;
  if (current > 1) {
    refCountByScopeKey.set(input.scopeKey, current - 1);
    return;
  }
  refCountByScopeKey.delete(input.scopeKey);
  sessionsByScopeKey.delete(input.scopeKey);
}
