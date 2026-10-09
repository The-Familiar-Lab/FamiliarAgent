import type { PaseoApi, PaseoAgentListResult, PaseoTerminalListResult } from "@getpaseo/client";
import type { CompositionEndpoint, CompositionSession } from "../../shared/composition.js";
import type { CompositionActivity, EndpointActivity } from "../../shared/activity.js";
import type { ToolRunStore } from "../tool-actions/store.js";

const ACTIVITY_READ_TIMEOUT_MS = 5000;
const AGENT_SNAPSHOT_LIMIT = 200;
type Facts = Pick<EndpointActivity, "state" | "readiness" | "source" | "detail">;

async function boundedObservation<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function terminalFacts(
  endpoint: CompositionEndpoint,
  terminals: PaseoTerminalListResult | null,
): Facts {
  const source = "native-terminal";
  if (!terminals)
    return {
      source,
      state: "unavailable",
      readiness: "unavailable",
      detail: "Terminal status could not be read. Refresh or open the original tool to check.",
    };
  const terminal = terminals.entries.find((entry) => entry.id === endpoint.agentId);
  if (!terminal)
    return endpoint.kind === "desktop"
      ? {
          source: "external-app",
          state: "external",
          readiness: "unknown",
          detail:
            "The launcher is no longer running. Launch success and app progress are not observable here; open the original app or view launcher diagnostics.",
        }
      : {
          source,
          state: "closed",
          readiness: "unavailable",
          detail:
            "This terminal is no longer running. Its exit does not confirm that the native task completed.",
        };
  if (
    terminal.cwd !== endpoint.cwd ||
    (endpoint.workspaceId && terminal.workspaceId !== endpoint.workspaceId)
  )
    return {
      source,
      state: "unavailable",
      readiness: "unavailable",
      detail: "The terminal no longer matches this linked workspace.",
    };
  return endpoint.kind === "desktop"
    ? {
        source,
        state: "starting",
        readiness: "unknown",
        detail:
          "The desktop launch process is running. Open the original application to check its readiness and progress.",
      }
    : {
        source,
        state: "running",
        readiness: "unknown",
        detail:
          "The native terminal process is running. Open it to check tool readiness, prompts and actual progress.",
      };
}

function agentFacts(endpoint: CompositionEndpoint, snapshot: PaseoAgentListResult | null): Facts {
  const source = "native-agent";
  if (!snapshot)
    return {
      source,
      state: "unavailable",
      readiness: "unavailable",
      detail:
        "Native agent status could not be read. Refresh or open the original conversation to check.",
    };
  const agent = snapshot.entries.find((entry) => entry.agent.id === endpoint.agentId)?.agent;
  if (!agent)
    return {
      source,
      state: "unavailable",
      readiness: "unknown",
      detail: snapshot.pageInfo.hasMore
        ? "This agent is outside the bounded status snapshot. Open its original conversation to check."
        : "This agent is not in the native directory on this server.",
    };
  if (agent.cwd !== endpoint.cwd || agent.provider !== endpoint.provider)
    return {
      source,
      state: "unavailable",
      readiness: "unavailable",
      detail: "The native agent no longer matches this linked workspace and provider.",
    };
  if (agent.providerUnavailable || agent.status === "error")
    return {
      source,
      state: "unavailable",
      readiness: "unavailable",
      detail:
        "The native provider reports an error or is unavailable. Open the original conversation for diagnostics.",
    };
  if (agent.archivedAt || agent.status === "closed")
    return {
      source,
      state: "closed",
      readiness: "unknown",
      detail:
        "The native conversation is closed. Its history remains separate from task completion.",
    };
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission")
    return {
      source,
      state: "waiting",
      readiness: "ready",
      detail: "The native agent is waiting for your approval in its original conversation.",
    };
  if (agent.status === "initializing")
    return {
      source,
      state: "starting",
      readiness: "unknown",
      detail: "The native provider is initializing this conversation.",
    };
  if (agent.status === "running" || agent.activeTurn)
    return {
      source,
      state: "running",
      readiness: "ready",
      detail: "A native agent turn is running. The original provider owns its execution.",
    };
  return {
    source,
    state: "idle",
    readiness: "ready",
    detail:
      "The native agent is idle and ready for input. This does not mark the logical session complete.",
  };
}

function endpointFacts(
  endpoint: CompositionEndpoint,
  terminals: PaseoTerminalListResult | null,
  agents: PaseoAgentListResult | null,
): Facts {
  switch (endpoint.kind) {
    case "agent":
      return agentFacts(endpoint, agents);
    case "terminal":
    case "desktop":
      return terminalFacts(endpoint, terminals);
    case "tool":
      return {
        source: "native-action",
        state: "external",
        readiness: "unknown",
        detail:
          "Individual native action states are listed separately. They do not mark the whole session complete.",
      };
    case "web":
      return {
        source: "external-app",
        state: "external",
        readiness: "unknown",
        detail:
          "The original web application owns its progress. Open it to check readiness and work status.",
      };
  }
}

export async function readSessionActivity(input: {
  session: CompositionSession;
  serverId: string;
  paseo: Pick<PaseoApi, "agents" | "terminals">;
  runs?: Pick<ToolRunStore, "listActivity">;
  offset: number;
  limit: number;
  timeoutMs?: number;
}): Promise<CompositionActivity> {
  const endpoints = input.session.endpoints.filter(
    (endpoint) => endpoint.serverId === input.serverId,
  );
  const timeoutMs = input.timeoutMs ?? ACTIVITY_READ_TIMEOUT_MS;
  const [terminals, agents] = await Promise.all([
    endpoints.some((endpoint) => endpoint.kind === "terminal" || endpoint.kind === "desktop")
      ? boundedObservation(() => input.paseo.terminals.list(), timeoutMs)
      : null,
    endpoints.some((endpoint) => endpoint.kind === "agent")
      ? boundedObservation(
          () =>
            input.paseo.agents.list({
              page: { limit: AGENT_SNAPSHOT_LIMIT },
              filter: { includeArchived: true },
              timeout: timeoutMs,
              signal: AbortSignal.timeout(timeoutMs),
            }),
          timeoutMs,
        )
      : null,
  ]);
  const runs = input.runs?.listActivity(input.session.id, input.offset, input.limit) ?? {
    runs: [],
    total: 0,
  };
  return {
    sessionId: input.session.id,
    serverId: input.serverId,
    observedAt: new Date().toISOString(),
    endpoints: endpoints.map((endpoint) =>
      Object.assign(
        {
          endpointId: endpoint.id,
          serverId: endpoint.serverId,
          nativeId: endpoint.agentId,
          toolId: endpoint.harness ?? endpoint.provider,
          kind: endpoint.kind,
          cwd: endpoint.cwd,
          workspaceId: endpoint.workspaceId,
        },
        endpointFacts(endpoint, terminals, agents),
      ),
    ),
    runs: runs.runs,
    totalRuns: runs.total,
  };
}
