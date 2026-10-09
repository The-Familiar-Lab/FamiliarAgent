import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { ToolEntry } from "../../shared/tool-catalog.js";
import type { HubController } from "./controller.js";
import { HubPicker, ROW, type HubUi } from "./ui.js";
import { useSetupOptions } from "./setup-options.js";

export function SetupAgentPicker({
  hub,
  ui,
  tool,
  serverId,
  tools,
  preferredProvider,
  onRequested,
}: {
  hub: HubController;
  ui: HubUi;
  tool: ToolEntry;
  serverId: string;
  tools?: ToolEntry[];
  preferredProvider?: string;
  onRequested?: (serverId: string) => void;
}) {
  const [server, setServer] = useState(serverId);
  const [agentKey, setAgentKey] = useState(
    preferredProvider ? `provider:${preferredProvider}` : "",
  );
  const [cwd, setCwd] = useState(hub.target === serverId ? hub.cwd : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (preferredProvider && server === serverId) setAgentKey(`provider:${preferredProvider}`);
  }, [preferredProvider, server, serverId]);
  const serverOptions = useMemo(
    () =>
      hub.hosts.map((host) => ({
        id: host.serverId,
        label: host.label,
        disabled: host.status !== "online",
      })),
    [hub.hosts],
  );
  const options = useMemo(
    () => [
      ...hub.tools
        .filter(
          (item) => item.serverId === server && item.tool.installed && item.tool.nativeProvider,
        )
        .map((item) => ({
          id: `provider:${item.tool.nativeProvider}`,
          label: `New ${item.tool.name} setup agent`,
        })),
      ...hub.fleet
        .filter((item) => item.server.serverId === server)
        .flatMap((item) =>
          item.agents
            .filter((agent) => agent.status !== "running")
            .map((agent) => ({
              id: `agent:${agent.id}`,
              label: `${agent.title || "Untitled"} · ${agent.provider} · ${agent.model ?? "default model"}`,
            })),
        ),
    ],
    [hub.tools, hub.fleet, server],
  );
  const selected = options.some((option) => option.id === agentKey)
    ? agentKey
    : (options[0]?.id ?? "");
  const provider = selected.startsWith("provider:") ? selected.slice(9) : "";
  const configuration = useSetupOptions(server, provider, cwd);
  const selectServer = useCallback(
    (id: string) => {
      setServer(id);
      setAgentKey(preferredProvider && id === serverId ? `provider:${preferredProvider}` : "");
      setCwd(
        hub.project?.resources.find(
          (resource) => resource.kind === "codebase" && resource.serverId === id,
        )?.locator ?? "",
      );
    },
    [hub.project, preferredProvider, serverId],
  );
  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!selected) throw new Error("Set up an agent below first.");
      if (provider && (configuration.loading || configuration.error || !configuration.model))
        throw new Error("Check the setup agent options before sending.");
      const choice = selected.startsWith("agent:")
        ? { agentId: selected.slice(6), cwd }
        : {
            provider,
            cwd,
            model: configuration.model,
            thinkingOptionId: configuration.thinking || undefined,
            modeId: configuration.mode || undefined,
          };
      await hub.askSetup(
        server,
        tool,
        tools ? { ...choice, tools: tools.map((item) => item.id) } : choice,
      );
      onRequested?.(server);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={ui.card}>
      <Text style={ui.sectionHeading}>Choose a setup agent</Text>
      <Text style={ui.muted}>
        This agent will set up {tools ? `${tools.length} selected tools` : tool.name} on the server
        you choose. Existing accounts stay on that server. A busy agent will not be interrupted.
      </Text>
      <HubPicker
        label="Setup server"
        value={server}
        options={serverOptions}
        onChange={selectServer}
        ui={ui}
      />
      {options.length ? (
        <>
          <HubPicker
            label="Setup agent"
            value={selected}
            options={options}
            onChange={setAgentKey}
            ui={ui}
          />
          {provider ? (
            <SetupConfiguration configuration={configuration} ui={ui} />
          ) : (
            <Text style={ui.muted}>
              This conversation keeps its current model, thinking and permissions. Choose a new
              setup agent to configure them here.
            </Text>
          )}
          {ui.field("Setup project folder (optional)", cwd, setCwd)}
          <Text style={ui.muted}>
            Leave empty to use this server’s private setup folder for a new agent. An existing agent
            keeps its original workspace.
          </Text>
          {ui.button(
            busy ? "Sending setup request…" : "Ask selected agent",
            () => {
              void send();
            },
            busy ||
              (!!provider &&
                (configuration.loading || !!configuration.error || !configuration.model)),
          )}
        </>
      ) : (
        <Text style={ui.muted}>
          No agent is available here. Install or sign in to an agent, then return to this tool.
        </Text>
      )}
      <View style={ROW}>
        {ui.button("Set up Codex", () => hub.openSetup(server, "codex"), busy)}
        {ui.button("Set up Claude", () => hub.openSetup(server, "claude"), busy)}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={ui.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function SetupConfiguration({
  configuration,
  ui,
}: {
  configuration: ReturnType<typeof useSetupOptions>;
  ui: HubUi;
}) {
  const model = configuration.models.find((item) => item.id === configuration.model);
  const mode = configuration.modes.find((item) => item.id === configuration.mode);
  const thinkingOptions = useMemo(
    () => [{ id: "", label: "Provider default" }, ...(model?.thinkingOptions ?? [])],
    [model],
  );
  const modeOptions = useMemo(
    () => [{ id: "", label: "Provider default" }, ...configuration.modes],
    [configuration.modes],
  );
  if (configuration.loading)
    return <Text style={ui.muted}>Loading model and permission options…</Text>;
  if (configuration.error)
    return (
      <View>
        <Text accessibilityRole="alert" style={ui.error}>
          {configuration.error}
        </Text>
        {ui.button("Retry agent options", configuration.retry)}
      </View>
    );
  return (
    <>
      <HubPicker
        label="Setup model"
        value={configuration.model}
        options={configuration.models}
        onChange={configuration.selectModel}
        ui={ui}
      />
      {model?.thinkingOptions?.length ? (
        <HubPicker
          label="Setup thinking"
          value={configuration.thinking}
          options={thinkingOptions}
          onChange={configuration.selectThinking}
          ui={ui}
        />
      ) : null}
      <HubPicker
        label="Setup permission mode"
        value={configuration.mode}
        options={modeOptions}
        onChange={configuration.selectMode}
        ui={ui}
      />
      <Text style={ui.muted}>
        {mode?.description ??
          "The original provider controls approvals. You can answer any requests in the setup conversation."}
      </Text>
    </>
  );
}
