import { Text, View } from "react-native";
import type { CompositionInput, CompositionResult } from "../../shared/results.js";
import type { HubController, HubProps } from "./controller.js";
import { INPUT_PAGE_SIZE, nativeTargetKey, type ResultFlow } from "./result-flow.js";
import { resultInputStatus } from "./result-actions.js";
import { ROW, type HubUi } from "./ui.js";
import { HubWorkspace } from "./workspace.js";

interface InputRecord {
  result: CompositionResult;
  input: CompositionInput;
}
function InputCard({
  hub,
  ui,
  flow,
  record,
}: {
  hub: HubController;
  ui: HubUi;
  flow: ResultFlow;
  record: InputRecord;
}) {
  const { input, result } = record;
  const source = result.anchor.resource;
  const endpoint = hub.session?.endpoints.find((item) => item.id === input.targetEndpointId);
  const sourceEndpoint = hub.session?.endpoints.find((item) => item.id === result.sourceEndpointId);
  return (
    <View style={ui.card}>
      <Text style={ui.text}>
        {sourceEndpoint?.provider ?? "Source response"} · {hub.hostName(source.serverId)} →{" "}
        {endpoint?.provider ?? "Native agent"} · {hub.hostName(input.targetServerId)}
      </Text>
      <Text style={ui.muted}>
        {result.createdAt} · {result.anchor.selection.bytes.toLocaleString()} bytes selected
      </Text>
      <Text selectable style={ui.text}>
        {flow.expanded?.resultId === result.id ? flow.expanded.text : result.preview}
      </Text>
      {input.instruction ? (
        <Text selectable style={ui.text}>
          Instruction: {input.instruction}
        </Text>
      ) : null}
      <Text style={ui.text}>
        {input.state} · {resultInputStatus(input.state)}
      </Text>
      {flow.unconfirmed.has(input.id) ? (
        <Text style={ui.error}>
          Delivery confirmation is unavailable. Check status before sending another input.
        </Text>
      ) : null}
      {input.error ? (
        <Text selectable style={ui.error}>
          {input.error}
        </Text>
      ) : null}
      <View style={ROW}>
        {ui.button("View selected result", () => {
          void hub.run(() => flow.preview(record));
        })}
        {ui.button("Open original", () =>
          hub.navigation?.openAgent({ serverId: source.serverId, agentId: source.locator }),
        )}
        {ui.button("Open conversation", () =>
          hub.navigation?.openAgent({
            serverId: input.targetServerId,
            agentId: input.targetAgentId,
          }),
        )}
        {input.state === "unknown" || input.state === "prepared"
          ? ui.button("Check status", () => {
              void hub.run(() => flow.check(record));
            })
          : null}
        {input.state === "prepared" && !flow.unconfirmed.has(input.id)
          ? ui.button("Send prepared input", () => {
              void hub.run(() => flow.sendPrepared(record));
            })
          : null}
      </View>
    </View>
  );
}
function ResultTargetPicker({
  hub,
  ui,
  flow,
}: {
  hub: HubController;
  ui: HubUi;
  flow: ResultFlow;
}) {
  const source = flow.draft;
  const recent = hub.fleet.flatMap(({ server, agents }) =>
    server.status !== "online"
      ? []
      : agents
          .filter(
            (agent) =>
              !(agent.id === source?.source.id && server.serverId === source.sourceServerId),
          )
          .map((agent) => ({
            key: nativeTargetKey(server.serverId, agent.id),
            label: `${agent.title || agent.cwd} · ${agent.provider} · ${server.label}`,
          })),
  );
  const connected = (source?.session?.endpoints ?? [])
    .filter(
      (endpoint) =>
        endpoint.kind === "agent" &&
        !(endpoint.agentId === source?.source.id && endpoint.serverId === source.sourceServerId),
    )
    .map((endpoint) => ({
      key: nativeTargetKey(endpoint.serverId, endpoint.agentId),
      label: `${endpoint.provider} · ${hub.hostName(endpoint.serverId)} · linked conversation`,
    }));
  const choices = [
    ...new Map([...connected, ...recent].map((choice) => [choice.key, choice])).values(),
  ];
  return (
    <>
      <Text style={ui.sectionHeading}>Send to</Text>
      <Text style={ui.muted}>
        Choose an existing conversation or create a native agent. A target already linked to another
        shared session stays in that session.
      </Text>
      <View style={ROW}>
        {ui.button(
          "New agent",
          () => flow.setTargetKey("new"),
          Boolean(flow.submitted || flow.pendingTarget),
          flow.targetKey === "new",
        )}
        {choices.map((choice) => (
          <View key={choice.key}>
            {ui.button(
              choice.label,
              () => flow.setTargetKey(choice.key),
              Boolean(flow.submitted || flow.pendingTarget),
              flow.targetKey === choice.key,
            )}
          </View>
        ))}
      </View>
    </>
  );
}
function ManualInput({ hub, ui, flow }: { hub: HubController; ui: HubUi; flow: ResultFlow }) {
  return (
    <View style={ui.card}>
      <Text style={ui.sectionHeading}>Use with another app</Text>
      <Text style={ui.muted}>
        Terminal, web and desktop tools keep their own input controls. Copy the input and paste it
        into the original tool. Familiar does not record this as delivered or capture its results
        automatically.
      </Text>
      <View style={ROW}>
        {ui.button("Copy input", () => {
          void hub.run(flow.copy);
        })}
        {ui.button("Open tools", () => hub.setTab("Tools"))}
        {hub.session?.endpoints
          .filter((endpoint) => endpoint.kind !== "agent")
          .map((endpoint) => (
            <View key={endpoint.id}>
              {ui.button(`Open tool · ${endpoint.harness ?? endpoint.provider}`, () => {
                void hub.run(() => hub.openEndpoint(endpoint, hub.session!.id));
              })}
            </View>
          ))}
      </View>
    </View>
  );
}
function ManualSourcePreview({
  hub,
  ui,
  flow,
}: {
  hub: HubController;
  ui: HubUi;
  flow: ResultFlow;
}) {
  return flow.manual ? (
    <View style={ui.card}>
      <Text style={ui.sectionHeading}>Manual input</Text>
      <Text style={ui.muted}>
        This response could not be linked to a durable original result. Automatic Send input is
        unavailable.
      </Text>
      <Text selectable style={ui.error}>
        {flow.manual.reason}
      </Text>
      {flow.manual.text !== null ? (
        <>
          <Text selectable style={ui.text}>
            {flow.manual.text}
          </Text>
          {ui.field("Instruction for the target", flow.instruction, flow.setInstruction, true)}
          <Text style={ui.muted}>
            This is a validated preview of the selected native response. Copy it and paste it into
            the original tool; no result connection or delivery is recorded.
          </Text>
          {ui.button("Copy input", () => {
            void hub.run(flow.copy);
          })}
        </>
      ) : (
        <Text style={ui.muted}>
          A current preview could not be verified. Open the original conversation and use Copy below
          the response you want.
        </Text>
      )}
      <View style={ROW}>
        {ui.button("Open original", () =>
          hub.navigation?.openAgent({
            serverId: flow.manual!.serverId,
            agentId: flow.manual!.agentId,
          }),
        )}
        {ui.button("Open tools", () => hub.setTab("Tools"))}
        {ui.button("Cancel", flow.cancel)}
      </View>
    </View>
  ) : null;
}
export function HubResults({
  hub,
  ui,
  flow,
  props,
}: {
  hub: HubController;
  ui: HubUi;
  flow: ResultFlow;
  props: HubProps;
}) {
  if (hub.tab !== "Inputs / Results") return null;
  return (
    <>
      <ManualSourcePreview hub={hub} ui={ui} flow={flow} />
      {flow.draft ? (
        <>
          <View style={ui.card}>
            <Text style={ui.sectionHeading}>Selected response</Text>
            <Text style={ui.muted}>
              {flow.draft.source.title || "Conversation"} · {flow.draft.source.provider} ·{" "}
              {hub.hostName(flow.draft.sourceServerId)}
            </Text>
            <Text style={ui.muted}>
              Shared session:{" "}
              {flow.draft.session?.title ??
                `${flow.draft.source.title || "Session"} (created when you send)`}
              . Only the selected response and your instruction are sent as input.
            </Text>
            <Text selectable style={ui.text}>
              {flow.draft.capture.text}
            </Text>
            {ui.button("Open original", () =>
              hub.navigation?.openAgent({
                serverId: flow.draft!.sourceServerId,
                agentId: flow.draft!.source.id,
              }),
            )}
            {ui.field("Instruction for the target", flow.instruction, flow.setInstruction, true)}
            <ResultTargetPicker hub={hub} ui={ui} flow={flow} />
          </View>
          {flow.pendingTarget ? (
            <Text style={ui.muted}>
              Target: {flow.pendingTarget.title || "New agent"} · {flow.pendingTarget.provider}/
              {flow.pendingTarget.modelId} · {hub.hostName(flow.pendingTarget.serverId)} ·{" "}
              {flow.pendingTarget.cwd}. Retries keep this original choice. Cancel to choose a
              different target; existing agents are kept.
            </Text>
          ) : null}
          {flow.targetKey === "new" && !flow.submitted && !flow.pendingTarget ? (
            <HubWorkspace hub={hub} ui={ui} props={props} forResult />
          ) : null}
          <View style={ROW}>
            {ui.button(
              "Send input",
              () => {
                void hub.run(flow.send);
              },
              Boolean(flow.submitted),
            )}
            {ui.button(flow.submitted ? "Close preview" : "Cancel", flow.cancel)}
          </View>
          {flow.deliveryError ? (
            <Text accessibilityRole="alert" style={ui.error}>
              {flow.deliveryError}
            </Text>
          ) : null}
          {flow.submitted ? (
            <InputCard hub={hub} ui={ui} flow={flow} record={flow.submitted} />
          ) : null}
          <ManualInput hub={hub} ui={ui} flow={flow} />
        </>
      ) : null}
      {!flow.draft && !flow.manual ? (
        <Text style={ui.muted}>
          Choose Use result… below a completed native response to connect its selected text to
          another agent. Existing tools keep their own execution and permissions.
        </Text>
      ) : null}
      <Text style={ui.sectionHeading}>
        Inputs / Results{hub.session ? ` · ${hub.session.title}` : ""}
      </Text>
      {hub.session ? (
        <>
          <View style={ROW}>
            {ui.button("Refresh inputs", flow.refresh)}
            {ui.button(
              "Previous inputs",
              () => flow.setOffset(Math.max(0, flow.offset - INPUT_PAGE_SIZE)),
              flow.offset === 0,
            )}
            <Text style={ui.muted}>
              {flow.records.total
                ? `${flow.offset + 1}–${Math.min(flow.offset + flow.records.records.length, flow.records.total)} of ${flow.records.total}`
                : "No inputs in this session yet"}
            </Text>
            {ui.button(
              "Next inputs",
              () => flow.setOffset(flow.offset + INPUT_PAGE_SIZE),
              flow.offset + INPUT_PAGE_SIZE >= flow.records.total,
            )}
          </View>
          {flow.records.records
            .filter((record) => record.input.id !== flow.submitted?.input.id)
            .map((record) => (
              <InputCard key={record.input.id} hub={hub} ui={ui} flow={flow} record={record} />
            ))}
        </>
      ) : (
        <Text style={ui.muted}>Select a shared session to view its result connections.</Text>
      )}
    </>
  );
}
