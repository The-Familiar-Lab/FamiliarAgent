import { Text, View } from "react-native";
import { ROW, type HubUi } from "./ui.js";
import type { HubController, HubProps } from "./controller.js";
import type { FleetSnapshot } from "../fleet.js";
import type { PaseoAgent } from "@getpaseo/client";
import { CATALOG_PAGE_SIZE } from "./entry.js";

function LogicalSessionCard({
  hub,
  ui,
  session,
}: {
  hub: HubController;
  ui: HubUi;
  session: HubController["sessions"][number];
}) {
  const active = session.endpoints.find((item) => item.id === session.activeEndpointId);
  return (
    <View style={ui.card}>
      <Text style={ui.text}>{session.title}</Text>
      <Text style={ui.muted}>
        {session.endpoints
          .map(
            (endpoint) =>
              `${endpoint.harness ?? endpoint.provider} · ${hub.hostName(endpoint.serverId)}`,
          )
          .join(" → ") || "Ready to connect a tool"}
      </Text>
      <View style={ROW}>
        {ui.button("Select session", () => {
          void hub.run(() => hub.selectSession(session.id));
        })}
        {active
          ? ui.button("Open conversation", () => {
              void hub.run(() => hub.openEndpoint(active, session.id));
            })
          : null}
      </View>
    </View>
  );
}
function NativeSessionCard({
  hub,
  ui,
  server,
  agent,
}: {
  hub: HubController;
  ui: HubUi;
  server: FleetSnapshot["server"];
  agent: PaseoAgent;
}) {
  const linked = hub.sessions.some((session) =>
    session.endpoints.some(
      (endpoint) => endpoint.serverId === server.serverId && endpoint.agentId === agent.id,
    ),
  );
  return (
    <View style={ui.card}>
      <Text style={ui.text}>{agent.title || agent.cwd}</Text>
      <Text style={ui.muted}>
        {server.label} · {agent.provider} · {agent.model} · {agent.status}
      </Text>
      <View style={ROW}>
        {ui.button("Open", () =>
          hub.navigation?.openAgent({ serverId: server.serverId, agentId: agent.id }),
        )}
        {ui.button(
          "Link session",
          () => {
            void hub.run(() => hub.attachNative(server.serverId, agent));
          },
          linked,
        )}
      </View>
    </View>
  );
}
export function HubSessions({ hub, ui }: { hub: HubController; ui: HubUi; props: HubProps }) {
  if (hub.tab !== "Sessions") return null;
  const logical = hub.sessions.filter(
    (session) =>
      hub.filter === "all" ||
      session.endpoints.some((endpoint) => endpoint.serverId === hub.filter),
  );
  const native = hub.visible.flatMap((item) =>
    item.agents
      .filter((agent) => (agent.title || agent.cwd).toLowerCase().includes(hub.query.toLowerCase()))
      .map((agent) => ({ server: item.server, agent })),
  );
  return (
    <>
      <Text style={ui.sectionHeading}>
        {hub.project ? `${hub.project.title} · shared sessions` : "Shared sessions · all projects"}
      </Text>
      {logical.map((session) => (
        <LogicalSessionCard key={session.id} hub={hub} ui={ui} session={session} />
      ))}
      <View style={ROW}>
        {ui.button(
          "Previous sessions",
          () => hub.setCatalogOffset(Math.max(0, hub.catalogOffset - CATALOG_PAGE_SIZE)),
          hub.catalogOffset === 0,
        )}
        <Text style={ui.muted}>
          {hub.catalogTotal
            ? `${hub.catalogOffset + 1}–${Math.min(hub.catalogOffset + hub.sessions.length, hub.catalogTotal)} of ${hub.catalogTotal}`
            : "No shared sessions in this selection"}
        </Text>
        {ui.button(
          "Next sessions",
          () => hub.setCatalogOffset(hub.catalogOffset + CATALOG_PAGE_SIZE),
          hub.catalogOffset + CATALOG_PAGE_SIZE >= hub.catalogTotal,
        )}
      </View>
      <Text style={ui.sectionHeading}>Existing native sessions · all servers</Text>
      {native.map(({ server, agent }) => (
        <NativeSessionCard
          key={`${server.serverId}:${agent.id}`}
          hub={hub}
          ui={ui}
          server={server}
          agent={agent}
        />
      ))}
    </>
  );
}
