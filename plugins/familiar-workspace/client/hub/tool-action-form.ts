import { useEffect, useRef, useState } from "react";
import type { output } from "zod";
import {
  readToolActionSettings,
  saveToolActionSettings,
  listToolActions,
  startToolAction,
} from "../../shared/tool-actions.js";
import { createComposition, type CompositionSession } from "../../shared/composition.js";
import { connectContextSources, hostRpc, operationId } from "../fleet.js";
import { bindToolEndpoint, type NativeToolTarget } from "./tool-action-links.js";
import type { HubController } from "./controller.js";
import type { ResultFlow } from "./result-flow.js";

interface Attempt {
  key: string;
  id: string;
  originalSessionId?: string;
  session?: CompositionSession;
}
export function useToolActionForm(
  hub: HubController,
  flow: ResultFlow,
  asInput: boolean,
  refreshed: () => void,
) {
  const [definitions, setDefinitions] = useState<output<typeof listToolActions.output>>([]);
  const [toolId, setToolId] = useState("");
  const [actionId, setActionId] = useState("");
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [nativeId, setNativeId] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const pendingNative = useRef<{ serverId: string; id: string } | null>(null);
  const settingsVersion = hub.toolSettingsVersions?.[`${hub.target}:${toolId}`] ?? 0;
  useEffect(() => {
    let active = true;
    setDefinitions([]);
    setError("");
    setParameters({});
    setNativeId(pendingNative.current?.serverId === hub.target ? pendingNative.current.id : "");
    pendingNative.current = null;
    void hostRpc(hub.target, listToolActions, {})
      .then((value) => {
        if (active) setDefinitions(value);
        return undefined;
      })
      .catch((failure: unknown) => {
        if (active) setError(String(failure));
      });
    return () => {
      active = false;
    };
  }, [hub.target]);
  useEffect(() => {
    let active = true;
    setParameters({});
    setError("");
    if (!toolId || !actionId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void hostRpc(hub.target, readToolActionSettings, { toolId, action: actionId })
      .then((value) => {
        if (active) setParameters(value.parameters);
        return undefined;
      })
      .catch((failure: unknown) => {
        if (active) setError(`Settings unavailable: ${String(failure)}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [hub.target, toolId, actionId, settingsVersion]);
  useEffect(() => {
    if (!definitions.some((value) => value.toolId === hub.toolId) || hub.toolId === toolId) return;
    setToolId(hub.toolId);
    setActionId("");
    setNativeId("");
    attempt.current = null;
  }, [hub.toolId, definitions, toolId]);
  const actions =
    definitions
      .find((value) => value.toolId === toolId)
      ?.actions.filter((value) => !asInput || (value.input && value.inputMode === "prompt")) ?? [];
  const action = actions.find((value) => value.id === actionId);
  const selectTool = (id: string) => {
    hub.setToolId(id);
    setToolId(id);
    setActionId("");
    setNativeId("");
    attempt.current = null;
  };
  const selectAction = (id: string) => {
    setActionId(id);
    attempt.current = null;
  };
  const save = async () => {
    await hostRpc(hub.target, saveToolActionSettings, { toolId, action: actionId, parameters });
    hub.setNotice("Native tool settings saved on this server.");
  };
  const useOriginal = (serverId: string, tool: string, cwd: string, id: string) => {
    if (serverId !== hub.target) pendingNative.current = { serverId, id };
    hub.setTarget(serverId);
    hub.setCwd(cwd);
    selectTool(tool);
    setNativeId(id);
  };
  const perform = async () => {
    if (!action || loading)
      throw new Error("Choose an available native action and wait for its settings.");
    const target: NativeToolTarget = {
      serverId: hub.target,
      toolId,
      cwd: hub.cwd,
      action: action.id,
      nativeId: nativeId || undefined,
      parameters,
    };
    if (asInput) {
      await flow.send(target);
      return;
    }
    const key = JSON.stringify({ ...target, input });
    const selected = hub.session?.id;
    const current = attempt.current;
    if (
      !current ||
      current.key !== key ||
      (selected !== current.originalSessionId && selected !== current.session?.id)
    )
      attempt.current = { key, id: operationId(), originalSessionId: selected };
    const request = attempt.current!;
    const project = hub.project ?? (await hub.ensureProject());
    const original =
      request.session ??
      hub.session ??
      (await hostRpc(hub.host.id, createComposition, {
        operationId: `tool-session-${request.id}`,
        projectId: project.id,
        title: hub.title.trim() || `${toolId} session`,
      }));
    request.session = original;
    const linked = await bindToolEndpoint(hub.host.id, original, target, hub.hosts);
    request.session = linked.session;
    hub.setSession(linked.session);
    hub.setProject(project);
    await connectContextSources(
      hub.host.id,
      linked.session,
      hub.hosts.find((host) => host.serverId === target.serverId),
      hub.hosts,
    );
    await hostRpc(target.serverId, startToolAction, {
      toolId: target.toolId,
      action: target.action,
      cwd: target.cwd,
      nativeId: target.nativeId,
      parameters: target.parameters,
      operationId: request.id,
      sessionId: linked.session.id,
      input,
    });
    attempt.current = null;
    refreshed();
    hub.setNotice("Native action started. Results remain linked to this shared session.");
  };
  const missing =
    loading ||
    !action ||
    (!!action.nativeId && !nativeId.trim()) ||
    (!!action.input && !asInput && !input.trim()) ||
    (action.parameters ?? []).some((value) => value.required && !parameters[value.key]?.trim());
  return {
    definitions,
    toolId,
    actionId,
    actions,
    action,
    parameters,
    setParameters,
    nativeId,
    setNativeId,
    input,
    setInput,
    error,
    loading,
    missing,
    selectTool,
    selectAction,
    save,
    useOriginal,
    perform,
  };
}
