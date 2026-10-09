import { NativeToolActions } from "./tool-actions.js";
import type { ResultFlow } from "./result-flow.js";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { listToolActions } from "../../shared/tool-actions.js";
import { hostRpc } from "../fleet.js";
import { registerTool, type ToolEntry } from "../../shared/tool-catalog.js";
import { ROW, HubTargetPicker, type HubUi } from "./ui.js";
import type { HubController, HubProps } from "./controller.js";

function availability(tool: ToolEntry): string {
  if (tool.installed) return "Available";
  return tool.modes.includes("reference") ? "Connect a command or URL" : "Not installed";
}
const modeLabel = {
  web: "Open inside FamiliarAgent",
  desktop: "Open app",
  terminal: "Open terminal",
};
function ToolCard({
  hub,
  ui,
  serverId,
  tool,
  hasActions,
}: {
  hub: HubController;
  ui: HubUi;
  serverId: string;
  tool: ToolEntry;
  hasActions: boolean;
}) {
  const launch = (action: "launch" | "install", surface?: "web" | "desktop" | "terminal") => {
    void hub.run(() => hub.launch(serverId, tool, action, surface));
  };
  const ask = () => {
    void hub.run(() => hub.askSetup(serverId, tool));
  };
  const website = () => {
    if (tool.sourceUrl) void hub.run(() => openExternalUrl(tool.sourceUrl!));
  };
  const usableFolder = !!hub.cwd && hub.target === serverId;
  return (
    <View style={ui.card}>
      <Text style={ui.toolHeading}>
        {tool.name} · {hub.hostName(serverId)}
      </Text>
      <Text style={ui.text}>{tool.description}</Text>
      <Text style={ui.muted}>
        {tool.capabilities.join(" · ")} · {availability(tool)}
      </Text>
      <View style={ROW}>
        {hasActions
          ? ui.button("Run actions", () => {
              hub.setTarget(serverId);
              hub.setToolId(tool.id);
            })
          : null}
        {tool.nativeProvider
          ? ui.button(
              "Use in session",
              () => {
                hub.setTarget(serverId);
                hub.setToolId(tool.id);
                hub.setTab("Sessions");
              },
              !tool.installed,
            )
          : null}
        {tool.modes
          .filter(
            (mode): mode is "web" | "desktop" | "terminal" =>
              mode === "web" || mode === "desktop" || mode === "terminal",
          )
          .map((mode) => (
            <View key={mode}>
              {ui.button(
                modeLabel[mode],
                () => launch("launch", mode),
                (mode !== "web" && !tool.installed) || !usableFolder,
              )}
            </View>
          ))}
        {tool.installAvailable
          ? ui.button("Install", () => launch("install"), !usableFolder)
          : null}
        {ui.button("Ask agent to set up", ask, !usableFolder)}
        {tool.sourceUrl ? ui.button("Project website", website) : null}
      </View>
      {tool.notes.map((note) => (
        <Text key={note} style={ui.muted}>
          {note}
        </Text>
      ))}
    </View>
  );
}
export function HubTools({
  hub,
  ui,
  flow,
}: {
  hub: HubController;
  ui: HubUi;
  props: HubProps;
  flow: ResultFlow;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [availableActions, setAvailableActions] = useState<Set<string>>(new Set());
  const online = useRef(hub.online);
  online.current = hub.online;
  const hostKey = hub.online
    .map((host) => host.serverId)
    .sort()
    .join("\0");
  useEffect(() => {
    let active = true;
    if (hub.tab !== "Tools") return;
    void Promise.allSettled(
      online.current.map(async (host) =>
        (await hostRpc(host.serverId, listToolActions, {})).map(
          (tool) => `${host.serverId}:${tool.toolId}`,
        ),
      ),
    ).then((results) => {
      if (active)
        setAvailableActions(
          new Set(results.flatMap((result) => (result.status === "fulfilled" ? result.value : []))),
        );
      return undefined;
    });
    return () => {
      active = false;
    };
  }, [hub.tab, hostKey]);
  if (hub.tab !== "Tools") return null;
  const connect = async () => {
    const entry = await hostRpc(hub.target, registerTool, {
      id: hub.customName
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, ""),
      name: hub.customName,
      url: hub.customUrl || undefined,
      launch: hub.customCommand
        ? { command: hub.customCommand, args: JSON.parse(hub.customArgs) }
        : undefined,
    });
    hub.setTools((items) => [
      ...items.filter((item) => item.serverId !== hub.target || item.tool.id !== entry.id),
      { serverId: hub.target, tool: entry },
    ]);
    hub.setNotice("Tool connected.");
  };
  return (
    <>
      <NativeToolActions hub={hub} ui={ui} flow={flow} />
      <View style={ui.card}>
        <Text style={ui.text}>Destination</Text>
        <HubTargetPicker hub={hub} ui={ui} />
        {ui.field("Project folder for launch / installation", hub.cwd, hub.setCwd)}
        <Text style={ui.muted}>
          Native chats, terminals and web apps open inside FamiliarAgent. Desktop apps open in their
          own window. Ask agent to set up starts a real setup conversation on the selected server.
        </Text>
      </View>
      {hub.tools
        .filter(
          (item) =>
            (hub.filter === "all" || item.serverId === hub.filter) &&
            `${item.tool.name} ${item.tool.capabilities.join(" ")}`
              .toLowerCase()
              .includes(hub.query.toLowerCase()),
        )
        .map(({ serverId, tool }) => (
          <ToolCard
            key={`${serverId}:${tool.id}`}
            hub={hub}
            ui={ui}
            serverId={serverId}
            tool={tool}
            hasActions={availableActions.has(`${serverId}:${tool.id}`)}
          />
        ))}
      <View style={ui.card}>
        <Text style={ui.text}>Connect another tool</Text>
        <Text style={ui.muted}>
          Enter its name and existing web URL. Advanced also accepts a native command.
        </Text>
        <HubTargetPicker hub={hub} ui={ui} />
        {ui.field("Tool name", hub.customName, hub.setCustomName)}
        {ui.field("Web URL", hub.customUrl, hub.setCustomUrl)}
        {ui.button(advanced ? "Hide Advanced" : "Advanced", () => setAdvanced(!advanced))}
        {advanced ? (
          <>
            {ui.field("Executable", hub.customCommand, hub.setCustomCommand)}
            {ui.field("Arguments as a JSON array", hub.customArgs, hub.setCustomArgs)}
          </>
        ) : null}
        {ui.button(
          "Connect tool",
          () => {
            void hub.run(connect);
          },
          !hub.customName || (!hub.customUrl && !hub.customCommand),
        )}
      </View>
    </>
  );
}
