import { getPaseoClient, type PluginHostSummary } from "@getpaseo/plugin/client";
import type { PaseoAgent } from "@getpaseo/client";
import type { output } from "zod";
import { selectedResult, type SelectedResult } from "../../shared/result-selection.js";
import { captureCompositionResult } from "../../shared/results.js";
import {
  bindComposition,
  createComposition,
  listComposition,
  readComposition,
  readCompositionProject,
  saveCompositionProject,
  type CompositionProject,
  type CompositionSession,
} from "../../shared/composition.js";
import { hostRpc, operationId } from "../fleet.js";
import { findNativeSession } from "./entry.js";

export interface ResultDraft {
  sourceServerId: string;
  source: PaseoAgent;
  selection: SelectedResult;
  capture: output<typeof captureCompositionResult.output>;
  session: CompositionSession | null;
  project: CompositionProject | null;
}
export function parseResultRoute(params?: Record<string, string>) {
  if (!params?.resultAgentId || !params.resultSelection) return null;
  return {
    agentId: params.resultAgentId,
    selection: selectedResult.parse(JSON.parse(params.resultSelection)),
  };
}
export async function findResultSession(catalog: string, serverId: string, agentId: string) {
  const found = await findNativeSession(serverId, agentId, (input) =>
    hostRpc(catalog, listComposition, input),
  );
  if (!found) return null;
  const session = await hostRpc(catalog, readComposition, { id: found.id });
  const project = await hostRpc(catalog, readCompositionProject, { id: session.projectId });
  return { session, project };
}
/** Opening this preview reads originals only; creating a shared session is a separate action. */
export async function loadResultDraft(
  catalog: string,
  serverId: string,
  route: NonNullable<ReturnType<typeof parseResultRoute>>,
): Promise<ResultDraft> {
  const [current, capture, linked] = await Promise.all([
    getPaseoClient(serverId).agents.ref(route.agentId).refresh(),
    hostRpc(serverId, captureCompositionResult, route),
    findResultSession(catalog, serverId, route.agentId),
  ]);
  if (!current) throw new Error("The source conversation is no longer available.");
  return {
    sourceServerId: serverId,
    source: current.agent,
    selection: route.selection,
    capture,
    session: linked?.session ?? null,
    project: linked?.project ?? null,
  };
}
function sourceEndpoint(serverId: string, agent: PaseoAgent, hosts: readonly PluginHostSummary[]) {
  return {
    kind: "agent" as const,
    serverId,
    connection: hosts.find((host) => host.serverId === serverId)?.connection,
    agentId: agent.id,
    provider: agent.provider,
    model: agent.model ?? undefined,
    cwd: agent.cwd,
  };
}
/** Called only after Send input. It never borrows an unrelated selected Hub project. */
export async function ensureResultSession(
  catalog: string,
  draft: ResultDraft,
  hosts: readonly PluginHostSummary[],
) {
  const linked = await findResultSession(catalog, draft.sourceServerId, draft.source.id);
  if (linked) {
    if (draft.session && linked.session.id !== draft.session.id)
      throw new Error(
        "The source session link changed. Reopen the selected result before sending.",
      );
    return linked;
  }
  if (draft.session)
    throw new Error("The source shared session is no longer linked. Reopen the result.");
  const project = await hostRpc(catalog, saveCompositionProject, {
    id: operationId(),
    title: draft.source.cwd.split("/").findLast(Boolean) || "Project",
    memory: "",
    resources: [
      {
        id: operationId(),
        kind: "codebase",
        label: "Source project folder",
        serverId: draft.sourceServerId,
        connection: hosts.find((host) => host.serverId === draft.sourceServerId)?.connection,
        format: "path",
        locator: draft.source.cwd,
        readOnly: true,
      },
    ],
    expectedRevision: 0,
    operationId: operationId(),
  });
  const session = await hostRpc(catalog, createComposition, {
    projectId: project.id,
    title: draft.source.title || "Session",
    operationId: operationId(),
    endpoint: sourceEndpoint(draft.sourceServerId, draft.source, hosts),
  });
  return { session, project };
}
export async function bindResultTarget(
  catalog: string,
  session: CompositionSession,
  serverId: string,
  agent: PaseoAgent,
  hosts: readonly PluginHostSummary[],
) {
  const linked = await findResultSession(catalog, serverId, agent.id);
  if (linked && linked.session.id !== session.id)
    throw new Error(
      "This target belongs to another shared session. Choose New agent to keep the sessions separate.",
    );
  const existing = session.endpoints.find(
    (endpoint) =>
      endpoint.serverId === serverId && endpoint.agentId === agent.id && endpoint.kind === "agent",
  );
  if (existing) return { session, endpoint: existing };
  const next = await hostRpc(catalog, bindComposition, {
    id: session.id,
    expectedRevision: session.revision,
    operationId: operationId(),
    endpoint: sourceEndpoint(serverId, agent, hosts),
  });
  const endpoint = next.endpoints.find(
    (item) => item.serverId === serverId && item.agentId === agent.id && item.kind === "agent",
  );
  if (!endpoint)
    throw new Error(
      "The target was linked but its endpoint could not be read. Reload the session.",
    );
  return { session: next, endpoint };
}

export function resultInputStatus(state: string) {
  switch (state) {
    case "accepted":
      return "Accepted by the target. Open its conversation for progress; this does not mean the task is complete.";
    case "unknown":
      return "Delivery is uncertain. Check status or open the target before sending another input.";
    case "failed":
      return "Input was not accepted. Read the error before preparing a new input.";
    default:
      return "Prepared input. Delivery has not been confirmed.";
  }
}
