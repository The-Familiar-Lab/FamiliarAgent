import type { PluginHostSummary } from "@getpaseo/plugin/client";
import type { CompositionSession } from "../../shared/composition.js";
import {
  bindComposition,
  readComposition,
  readCompositionProject,
  updateComposition,
} from "../../shared/composition.js";
import { captureToolRunResult } from "../../shared/results.js";
import type { ToolRun } from "../../shared/tool-actions.js";
import { hostRpc, operationId } from "../fleet.js";
import type { ResultDraft } from "./result-actions.js";

export interface NativeToolTarget {
  serverId: string;
  toolId: string;
  cwd: string;
  action: string;
  nativeId?: string;
  parameters: Record<string, string>;
}
export async function bindToolEndpoint(
  catalog: string,
  session: CompositionSession,
  target: Pick<NativeToolTarget, "serverId" | "toolId" | "cwd">,
  hosts: readonly PluginHostSummary[],
) {
  session = await hostRpc(catalog, readComposition, { id: session.id });
  const existing = session.endpoints.find(
    (endpoint) =>
      endpoint.kind === "tool" &&
      endpoint.serverId === target.serverId &&
      endpoint.provider === target.toolId &&
      endpoint.cwd === target.cwd,
  );
  if (existing) return { session, endpoint: existing };
  const agentId = operationId();
  const next = await hostRpc(catalog, bindComposition, {
    id: session.id,
    expectedRevision: session.revision,
    operationId: operationId(),
    endpoint: {
      serverId: target.serverId,
      provider: target.toolId,
      kind: "tool",
      cwd: target.cwd,
      agentId,
      connection: hosts.find((host) => host.serverId === target.serverId)?.connection,
    },
  });
  const endpoint = next.endpoints.find(
    (value) => value.agentId === agentId && value.kind === "tool",
  );
  if (!endpoint) throw new Error("Native tool endpoint was not linked. Reload this session.");
  return { session: next, endpoint };
}
export async function loadToolResultDraft(
  catalog: string,
  run: ToolRun,
  hosts: readonly PluginHostSummary[],
): Promise<ResultDraft> {
  const capture = await hostRpc(run.serverId, captureToolRunResult, { id: run.id });
  const original = await hostRpc(catalog, readComposition, { id: run.request.sessionId });
  const linked = await bindToolEndpoint(
    catalog,
    original,
    { serverId: run.serverId, toolId: run.request.toolId, cwd: run.request.cwd },
    hosts,
  );
  let session = linked.session;
  if (!session.resources.some((resource) => resource.id === capture.anchor.resource.id)) {
    session = await hostRpc(catalog, updateComposition, {
      id: session.id,
      expectedRevision: session.revision,
      operationId: operationId(),
      title: session.title,
      memory: session.memory,
      memoryEnabled: session.memoryEnabled,
      disabledResourceIds: session.disabledResourceIds,
      resources: [
        ...session.resources,
        { ...capture.anchor.resource, connection: linked.endpoint.connection },
      ],
    });
  }
  return {
    toolRunId: run.id,
    sourceServerId: run.serverId,
    source: {
      id: linked.endpoint.agentId,
      provider: run.request.toolId,
      cwd: run.request.cwd,
      title: `${run.request.toolId} · ${run.request.action}`,
      model: null,
    },
    capture,
    session,
    project: await hostRpc(catalog, readCompositionProject, { id: session.projectId }),
  };
}
