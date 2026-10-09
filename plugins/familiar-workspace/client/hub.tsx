import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { ConversationLibrary } from "./history.js";
import { useHubController, TABS, type HubProps } from "./hub/controller.js";
import { useHubUi, ROW, HubDisclosure, HubPicker } from "./hub/ui.js";
import { HubSelection } from "./hub/selection.js";
import { HubWorkspace } from "./hub/workspace.js";
import { HubActivity } from "./hub/activity.js";
import { HubProjects } from "./hub/projects.js";
import { HubSessions } from "./hub/sessions.js";
import { HubFiles } from "./hub/files.js";
import { HubTools } from "./hub/tools.js";
import { HubMemory } from "./hub/memory.js";
import { useResultFlow } from "./hub/result-flow.js";
import { HubResults } from "./hub/results.js";
import { HubServers } from "./hub/servers.js";
import { AdvisorDialog } from "./hub/advisor-dialog.js";
import { HubOnboarding, useOnboarding } from "./hub/onboarding.js";
import { ToolSetupDialog } from "./hub/tool-setup.js";
const HEADER = { ...ROW, alignItems: "center", justifyContent: "space-between" } as const;
const viewOptions = TABS.filter((item) => item !== "Projects").map((item) => ({
  id: item,
  label: item === "Sessions" ? "Sessions & workspace" : item,
}));
const isContextEntry = (params: HubProps["params"]) =>
  Boolean(params?.agentId || params?.terminalId || params?.toolId || params?.historyId);
export function FamiliarHub(props: HubProps) {
  const hub = useHubController(props);
  const onboarding = useOnboarding(hub, isContextEntry(props.params));
  const ui = useHubUi(props.theme, hub.busy);
  const navigationUi = useHubUi(props.theme, false);
  const results = useResultFlow(hub, props.host.id, props.params);
  const advisorOrigin = useMemo(
    () =>
      props.params?.agentId
        ? { agentId: props.params.agentId, serverId: props.params.serverId ?? props.host.id }
        : undefined,
    [props.params?.agentId, props.params?.serverId, props.host.id],
  );
  const [advisorOpen, setAdvisorOpen] = useState(false);
  const closeAdvisor = useCallback(() => setAdvisorOpen(false), []);
  const [width, setWidth] = useState(0);
  const [browsing, setBrowsing] = useState(!hub.session);
  useEffect(() => {
    if (hub.entryChoice || !hub.session?.id) setBrowsing(true);
    else setBrowsing(false);
  }, [hub.session?.id, hub.entryChoice]);
  const wide = width >= 800;
  const home = hub.tab === "Projects" || hub.tab === "Sessions";
  const filterOptions = useMemo(
    () => [
      { id: "all", label: "All servers" },
      ...hub.hosts.map((item) => ({ id: item.serverId, label: `${item.label} · ${item.status}` })),
    ],
    [hub.hosts],
  );
  const layout = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  const changeView = useCallback((value: string) => hub.setTab(value as typeof hub.tab), [hub]);
  const selected = useCallback(() => setBrowsing(false), []);
  const styles = useMemo(
    () => ({
      columns: {
        flexDirection: wide ? ("row" as const) : ("column" as const),
        gap: 14,
        alignItems: "flex-start" as const,
      },
      browse: { width: wide ? 340 : ("100%" as const), gap: 12 },
      workspace: {
        flex: wide ? 1 : undefined,
        width: wide ? undefined : ("100%" as const),
        minWidth: 0,
        gap: 12,
      },
    }),
    [wide],
  );
  if (hub.tab === "History")
    return (
      <View style={ui.fill}>
        {ui.button("Back to Familiar Hub", () => hub.setTab("Projects"))}
        <ConversationLibrary {...props} initialServerId={hub.filter} onLink={hub.linkHistory} />
      </View>
    );
  return (
    <ScrollView style={ui.page} contentContainerStyle={ui.content} onLayout={layout}>
      <HubOnboarding hub={hub} ui={navigationUi} state={onboarding} />
      <ToolSetupDialog hub={hub} ui={navigationUi} />
      <View style={HEADER}>
        <Text style={ui.heading}>Familiar Hub</Text>
        {navigationUi.button("Ask Familiar", () => setAdvisorOpen(true))}
        {navigationUi.button("Memory & Skills", () => hub.setTab("Memory & Skills"))}
        {navigationUi.button("Set up tools", onboarding.open)}
        {navigationUi.button(
          "Refresh",
          () => {
            void hub.refresh();
            void hub.reloadTools();
          },
          hub.refreshing,
        )}
      </View>
      <AdvisorDialog
        hub={hub}
        ui={navigationUi}
        close={closeAdvisor}
        visible={advisorOpen}
        origin={advisorOrigin}
      />
      <HubPicker
        label="View"
        value={home ? "Sessions" : hub.tab}
        options={viewOptions}
        onChange={changeView}
        ui={navigationUi}
      />
      {hub.error ? (
        <Text accessibilityRole="alert" style={ui.error}>
          {hub.error}
        </Text>
      ) : null}
      {hub.terminalEntryFailed
        ? navigationUi.button("Retry terminal session lookup", hub.retryTerminalEntry)
        : null}
      {Object.entries(hub.toolCatalogErrors)
        .filter(([, error]) => error)
        .map(([serverId, error]) => (
          <Text key={serverId} accessibilityRole="alert" style={ui.error}>
            {hub.hostName(serverId)}: {error}
          </Text>
        ))}
      {hub.notice ? (
        <Text selectable style={ui.text}>
          {hub.notice}
        </Text>
      ) : null}
      {hub.visible
        .filter((item) => item.error)
        .map((item) => (
          <Text key={item.server.serverId} style={ui.muted}>
            {item.server.label}: {item.error}
          </Text>
        ))}
      {home ? (
        <>
          {!wide
            ? ui.button(browsing ? "Hide session browser" : "Browse / change session", () =>
                setBrowsing(!browsing),
              )
            : null}
          <View style={styles.columns}>
            {wide || browsing ? (
              <View style={styles.browse}>
                <HubSessions hub={hub} ui={ui} onSelected={selected} />
                <HubDisclosure label="Projects without an open session" ui={ui}>
                  <HubProjects hub={hub} ui={ui} props={props} />
                </HubDisclosure>
                {hub.visible.some((item) => item.hasMore) ? (
                  <Text style={ui.muted}>
                    Latest 100 native entries per server. Use native Sessions for older pages.
                  </Text>
                ) : null}
              </View>
            ) : null}
            <View style={styles.workspace}>
              <HubSelection hub={hub} ui={ui} props={props} />
              <HubWorkspace hub={hub} ui={ui} props={props} />
              <HubActivity hub={hub} ui={ui} flow={results} />
            </View>
          </View>
        </>
      ) : (
        <>
          {ui.button("Back to sessions", () => hub.setTab("Sessions"))}
          <HubSelection hub={hub} ui={ui} props={props} />
          <HubPicker
            label="Show"
            value={hub.filter}
            options={filterOptions}
            onChange={hub.setFilter}
            ui={ui}
          />
          {ui.field("Search projects, sessions or tools", hub.query, hub.setQuery)}
          <HubResults hub={hub} ui={ui} props={props} flow={results} />
          <HubFiles hub={hub} ui={ui} props={props} />
          <HubTools hub={hub} ui={ui} props={props} flow={results} />
          <HubMemory hub={hub} ui={ui} props={props} />
          <HubServers hub={hub} ui={ui} props={props} />
        </>
      )}
    </ScrollView>
  );
}
