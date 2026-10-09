import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";

import { listToolRuns, type ToolRunSummary } from "../../shared/tool-actions.js";
import { ToolRunCard } from "./tool-run-card.js";
import { useToolActionForm } from "./tool-action-form.js";
import { hostRpc } from "../fleet.js";

import { ToolGuide } from "./tool-guide.js";
import { HubPicker, HubTargetPicker, ROW, type HubUi } from "./ui.js";
import type { HubController } from "./controller.js";
import type { ResultFlow } from "./result-flow.js";

export function NativeToolActions({
  hub,
  ui,
  flow,
  asInput = false,
}: {
  hub: HubController;
  ui: HubUi;
  flow: ResultFlow;
  asInput?: boolean;
}) {
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [runs, setRuns] = useState<ToolRunSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const latest = useRef(hub);
  latest.current = hub;

  const hostKey = hub.online
    .map((host) => host.serverId)
    .sort()
    .join("\0");
  const sessionId = hub.session?.id;
  useEffect(() => {
    setOffset(0);
  }, [sessionId]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRuns([]);
    if (!sessionId || asInput) return;
    const refresh = async () => {
      const hosts = latest.current.online;
      const results = await Promise.allSettled(
        hosts.map((host) => hostRpc(host.serverId, listToolRuns, { sessionId, offset, limit: 30 })),
      );
      if (!active) return;
      const entries = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value.runs : [],
      );
      setRuns(entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setHasMore(
        results.some((result) => result.status === "fulfilled" && result.value.total > offset + 30),
      );
      const failures = results.flatMap((result, index) =>
        result.status === "rejected" ? [`${hosts[index]!.label}: ${String(result.reason)}`] : [],
      );
      setError(failures.join("\n"));
      if (entries.some((run) => run.state === "running"))
        timer = setTimeout(() => {
          void refresh();
        }, 1500);
    };
    void refresh();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [hostKey, sessionId, asInput, offset, version]);
  const refreshed = useCallback(() => {
    setOffset(0);
    setVersion((value) => value + 1);
  }, []);
  const form = useToolActionForm(hub, flow, asInput, refreshed);
  const { definitions, toolId, actionId, actions, selectTool, selectAction } = form;
  const toolOptions = useMemo(
    () =>
      definitions
        .filter(
          (definition) =>
            !asInput ||
            definition.actions.some((entry) => entry.input && entry.inputMode === "prompt"),
        )
        .map((definition) => ({
          id: definition.toolId,
          label:
            hub.tools.find(
              (item) => item.serverId === hub.target && item.tool.id === definition.toolId,
            )?.tool.name ?? definition.toolId,
        })),
    [definitions, asInput, hub.tools, hub.target],
  );
  const actionOptions = useMemo(
    () =>
      actions.map((definition) => ({
        id: definition.id,
        label: definition.label,
      })),
    [actions],
  );
  return (
    <View style={ui.card}>
      <Text style={ui.sectionHeading}>
        {asInput ? "Send selected result to an original tool" : "Run an original tool"}
      </Text>
      <Text style={ui.muted}>
        The original tool keeps its own execution, login and permissions. FamiliarAgent connects
        inputs and completed results in this shared session.
      </Text>
      <HubTargetPicker hub={hub} ui={ui} />
      {ui.field("Project folder on this server", hub.cwd, hub.setCwd)}
      <HubPicker label="Tool" value={toolId} options={toolOptions} onChange={selectTool} ui={ui} />
      {hub.tools.find((item) => item.serverId === hub.target && item.tool.id === toolId)?.tool ? (
        <ToolGuide
          tool={
            hub.tools.find((item) => item.serverId === hub.target && item.tool.id === toolId)!.tool
          }
          ui={ui}
        />
      ) : null}
      {ui.button("Tool settings / Sign in", () => hub.openSetup(hub.target, toolId), !toolId)}
      <HubPicker
        label="Action"
        value={actionId}
        options={actionOptions}
        onChange={selectAction}
        ui={ui}
      />
      <ToolActionFields
        hub={hub}
        ui={ui}
        form={form}
        asInput={asInput}
        submitted={!!flow.submitted}
      />
      {form.error ? (
        <Text selectable style={ui.error}>
          {form.error}
        </Text>
      ) : null}
      {error ? (
        <Text selectable style={ui.error}>
          {error}
        </Text>
      ) : null}
      {!asInput ? (
        <>
          <Text style={ui.sectionHeading}>
            Native actions · {hub.session?.title ?? "Choose or create a shared session"}
          </Text>
          <View style={ROW}>
            {ui.button("Refresh actions", () => setVersion((value) => value + 1))}
            {ui.button("Previous actions", () => setOffset(Math.max(0, offset - 30)), offset === 0)}
            {ui.button("Next actions", () => setOffset(offset + 30), !hasMore)}
          </View>
          {runs
            .filter((run) => hub.filter === "all" || run.serverId === hub.filter)
            .map((run) => (
              <ToolRunCard
                key={`${run.serverId}:${run.id}`}
                run={run}
                hub={hub}
                ui={ui}
                flow={flow}
                form={form}
                refreshed={refreshed}
              />
            ))}
        </>
      ) : null}
    </View>
  );
}

function ToolActionFields({
  hub,
  ui,
  form,
  asInput,
  submitted,
}: {
  hub: HubController;
  ui: HubUi;
  form: ReturnType<typeof useToolActionForm>;
  asInput: boolean;
  submitted: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const { action, input, setInput, nativeId, setNativeId, parameters, setParameters, perform } =
    form;
  return (
    <>
      {" "}
      {action ? (
        <>
          <Text style={ui.text}>{action.description}</Text>
          {!asInput && action.input
            ? ui.field("Input for the original tool", input, setInput, true)
            : null}
          {action.nativeId ? ui.field("Original session / work ID", nativeId, setNativeId) : null}
          {(action.parameters ?? [])
            .filter((parameter) => parameter.required || advanced)
            .map((parameter) => (
              <View key={parameter.key}>
                <Text style={ui.text}>
                  {parameter.label}
                  {parameter.required ? " *" : ""}
                </Text>
                {parameter.description ? (
                  <Text style={ui.muted}>{parameter.description}</Text>
                ) : null}
                {ui.field(parameter.label, parameters[parameter.key] ?? "", (value) =>
                  setParameters((previous) => ({ ...previous, [parameter.key]: value })),
                )}
              </View>
            ))}
          {action.parameters?.some((parameter) => !parameter.required)
            ? ui.button(advanced ? "Hide Advanced" : "Advanced", () => setAdvanced(!advanced))
            : null}
          {action.parameters?.length
            ? ui.button(
                "Save settings",
                () => {
                  void hub.run(form.save);
                },
                form.loading,
              )
            : null}
          {ui.button(
            asInput ? "Send input to tool" : action.label,
            () => {
              void hub.run(perform);
            },
            !hub.cwd.trim() || form.missing || (asInput && submitted),
          )}
        </>
      ) : null}
    </>
  );
}
