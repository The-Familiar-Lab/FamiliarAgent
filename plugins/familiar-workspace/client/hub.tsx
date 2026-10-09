import { ScrollView, Text, View } from "react-native";
import { ConversationLibrary } from "./history.js";
import { useHubController, TABS, type HubProps } from "./hub/controller.js";
import { useHubUi, ROW } from "./hub/ui.js";
import { HubSelection } from "./hub/selection.js";
import { HubWorkspace } from "./hub/workspace.js";
import { HubProjects } from "./hub/projects.js";
import { HubSessions } from "./hub/sessions.js";
import { HubFiles } from "./hub/files.js";
import { HubTools } from "./hub/tools.js";
import { HubMemory } from "./hub/memory.js";
import { useResultFlow } from "./hub/result-flow.js";
import { HubResults } from "./hub/results.js";
import { HubServers } from "./hub/servers.js";
export function FamiliarHub(props: HubProps) {
  const hub = useHubController(props);
  const ui = useHubUi(props.theme, hub.busy);
  const results = useResultFlow(hub, props.host.id, props.params);
  const {
    navigation,
    hosts,
    tab,
    setTab,
    filter,
    setFilter,
    query,
    setQuery,
    error,
    notice,
    run,
    visible,
    refresh,
  } = hub;
  const { text, muted, button, field } = ui;
  if (hub.tab === "History")
    return (
      <View style={ui.fill}>
        {ui.button("Back to Familiar Hub", () => hub.setTab("Projects"))}
        <ConversationLibrary {...props} initialServerId={filter} onLink={hub.linkHistory} />
      </View>
    );
  return (
    <ScrollView style={ui.page} contentContainerStyle={ui.content}>
      <Text style={ui.heading}>Familiar Hub</Text>
      <Text style={muted}>
        One project. Your tools, conversations and servers. Switch how you work while keeping shared
        context.
      </Text>
      <Text style={muted}>Shared sessions managed through {hub.host.label}</Text>
      <View style={ROW}>
        {TABS.map((item) => (
          <View key={item}>{button(item, () => setTab(item), false, tab === item)}</View>
        ))}
      </View>
      <View style={ROW}>
        {button("All servers", () => setFilter("all"), false, filter === "all")}
        {hosts.map((item) => (
          <View key={item.serverId}>
            {button(
              `${item.label} · ${item.status}`,
              () => setFilter(item.serverId),
              false,
              filter === item.serverId,
            )}
          </View>
        ))}
        {button("Refresh", () => {
          void run(refresh);
        })}
        {navigation?.openServers ? button("Add server", navigation.openServers) : null}
      </View>
      {field("Search projects, sessions or tools", query, setQuery)}
      {error ? (
        <Text accessibilityRole="alert" style={ui.error}>
          {error}
        </Text>
      ) : null}
      {notice ? (
        <Text selectable style={text}>
          {notice}
        </Text>
      ) : null}
      {visible
        .filter((item) => item.error)
        .map((item) => (
          <Text key={item.server.serverId} style={muted}>
            {item.server.label}: {item.error}
          </Text>
        ))}
      {visible.some((item) => item.hasMore) ? (
        <Text style={muted}>
          Showing the latest 100 entries per server. The native Sessions screen provides paginated
          full history.
        </Text>
      ) : null}
      <HubSelection hub={hub} ui={ui} props={props} />
      <HubWorkspace hub={hub} ui={ui} props={props} />
      <HubProjects hub={hub} ui={ui} props={props} />
      <HubSessions hub={hub} ui={ui} props={props} />
      <HubResults hub={hub} ui={ui} props={props} flow={results} />
      <HubFiles hub={hub} ui={ui} props={props} />
      <HubTools hub={hub} ui={ui} props={props} flow={results} />
      <HubMemory hub={hub} ui={ui} props={props} />
      <HubServers hub={hub} ui={ui} props={props} />
    </ScrollView>
  );
}
