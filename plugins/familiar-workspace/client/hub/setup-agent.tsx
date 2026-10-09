import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { ToolEntry } from "../../shared/tool-catalog.js";
import type { HubController } from "./controller.js";
import { HubPicker, ROW, type HubUi } from "./ui.js";

export function SetupAgentPicker({
  hub,
  ui,
  tool,
  serverId,
  tools,
  onRequested,
}: {
  hub: HubController;
  ui: HubUi;
  tool: ToolEntry;
  serverId: string;
  tools?: ToolEntry[];
  onRequested?: (serverId: string) => void;
}) {
  const [server, setServer] = useState(serverId);
  const [agentKey, setAgentKey] = useState("");
  const [cwd, setCwd] = useState(hub.target === serverId ? hub.cwd : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  const selectServer = useCallback(
    (id: string) => {
      setServer(id);
      setAgentKey("");
      setCwd(
        hub.project?.resources.find(
          (resource) => resource.kind === "codebase" && resource.serverId === id,
        )?.locator ?? "",
      );
    },
    [hub.project],
  );
  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!selected) throw new Error("Set up an agent below first.");
      const choice = selected.startsWith("agent:")
        ? { agentId: selected.slice(6), cwd }
        : { provider: selected.slice(9), cwd };
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
            busy,
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
