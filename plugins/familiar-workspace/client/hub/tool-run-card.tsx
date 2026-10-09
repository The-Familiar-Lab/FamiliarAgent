import { useState } from "react";
import { Text, View } from "react-native";
import {
  cancelToolRun,
  readToolRun,
  resolveToolRun,
  type ToolRunSummary,
} from "../../shared/tool-actions.js";
import { hostRpc } from "../fleet.js";
import { ROW, type HubUi } from "./ui.js";
import type { HubController } from "./controller.js";
import type { ResultFlow } from "./result-flow.js";
import type { useToolActionForm } from "./tool-action-form.js";

function supportsOriginalId(
  run: ToolRunSummary,
  target: string,
  definitions: ReturnType<typeof useToolActionForm>["definitions"],
): boolean {
  return (
    target === run.serverId &&
    !!definitions
      .find((definition) => definition.toolId === run.request.toolId)
      ?.actions.some((action) => action.nativeId)
  );
}
export function ToolRunCard({
  run,
  hub,
  ui,
  flow,
  form,
  refreshed,
}: {
  run: ToolRunSummary;
  hub: HubController;
  ui: HubUi;
  flow: ResultFlow;
  form: ReturnType<typeof useToolActionForm>;
  refreshed: () => void;
}) {
  const [full, setFull] = useState<string | null>(null);
  const canUseOriginal = supportsOriginalId(run, hub.target, form.definitions);
  const read = async () => hostRpc(run.serverId, readToolRun, { id: run.id });
  const show = async () => {
    const value = await read();
    setFull(value.result?.text ?? "");
  };
  const useResult = async () => flow.useToolResult(await read());
  const cancel = async () => {
    await hostRpc(run.serverId, cancelToolRun, { id: run.id });
    refreshed();
  };
  return (
    <View style={ui.card}>
      <Text style={ui.toolHeading}>
        {run.request.toolId} · {run.request.action} · {hub.hostName(run.serverId)}
      </Text>
      <Text style={ui.muted}>
        {run.state} · {run.createdAt}
        {run.result?.nativeId ? ` · Original ID: ${run.result.nativeId}` : ""}
      </Text>
      {run.state === "submitted" ? (
        <Text style={ui.muted}>
          The original tool accepted this request. Read its work/session to confirm completion.
        </Text>
      ) : null}
      {run.error ? (
        <Text selectable style={ui.error}>
          {run.error}
        </Text>
      ) : null}
      {run.result ? (
        <Text selectable style={ui.text}>
          {full ?? run.result.preview}
        </Text>
      ) : null}
      {run.result?.nativeId && hub.target !== run.serverId ? (
        <Text style={ui.muted}>
          Select {hub.hostName(run.serverId)} above to see available actions for this original ID.
        </Text>
      ) : null}
      <View style={ROW}>
        {run.result
          ? ui.button(full === null ? "View full result" : "Hide full result", () => {
              if (full === null) void hub.run(show);
              else setFull(null);
            })
          : null}
        {run.state === "completed" && run.result?.textBytes
          ? ui.button("Use result…", () => {
              void hub.run(useResult);
            })
          : null}
        {run.result?.nativeId && canUseOriginal
          ? ui.button("Use original ID", () =>
              form.useOriginal(
                run.serverId,
                run.request.toolId,
                run.request.cwd,
                run.result!.nativeId!,
              ),
            )
          : null}
        {run.state === "running"
          ? ui.button("Cancel action", () => {
              void hub.run(cancel);
            })
          : null}
      </View>
      {run.state === "unknown" ? (
        <RetryResolution run={run} hub={hub} ui={ui} refreshed={refreshed} />
      ) : null}
    </View>
  );
}
function RetryResolution({
  run,
  hub,
  ui,
  refreshed,
}: {
  run: ToolRunSummary;
  hub: HubController;
  ui: HubUi;
  refreshed: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState("");
  const release = async () => {
    await hostRpc(run.serverId, resolveToolRun, { id: run.id, originalChecked: true, note });
    refreshed();
  };
  return (
    <View style={ui.card}>
      <Text style={ui.muted}>
        The outcome is unknown. Inspect the original task before allowing a new attempt; this does
        not mark it successful.
      </Text>
      {ui.button("I checked the original task", () => setChecked(!checked), false, checked)}
      {ui.field("What did the original tool show?", note, setNote, true)}
      {ui.button(
        "Release retry lock",
        () => {
          void hub.run(release);
        },
        !checked || !note.trim(),
      )}
    </View>
  );
}
