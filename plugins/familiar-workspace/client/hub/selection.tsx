import { Text, View } from "react-native";
import { ROW, type HubUi } from "./ui.js";
import type { HubController, HubProps } from "./controller.js";
export function HubSelection({ hub, ui }: { hub: HubController; ui: HubUi; props: HubProps }) {
  const active = hub.session?.endpoints.find((item) => item.id === hub.session?.activeEndpointId);
  let label = hub.project ? "SELECTED PROJECT" : "NO SESSION SELECTED";
  if (hub.session) label = "SELECTED SESSION";
  return (
    <View style={ui.card}>
      <Text style={ui.muted}>{label}</Text>
      <Text style={ui.sectionHeading}>
        {hub.session?.title ?? hub.project?.title ?? "Choose a conversation to continue"}
      </Text>
      {hub.project ? (
        <Text style={ui.muted}>
          {hub.project.title}
          {active
            ? ` · ${hub.hostName(active.serverId)} · ${active.harness ?? active.provider} · ${active.model ?? "Model not reported"}`
            : ""}
        </Text>
      ) : null}
      {active ? (
        <Text selectable numberOfLines={2} style={ui.muted}>
          {active.cwd}
        </Text>
      ) : null}
      {hub.project ? (
        <View style={ROW}>
          {ui.button("Memory & Skills", () => {
            hub.setMemory(hub.session?.memory ?? hub.project!.memory);
            hub.setTab("Memory & Skills");
          })}
          {ui.button("Clear selection", () => {
            hub.setCatalogOffset(0);
            hub.setProject(null);
            hub.setSession(null);
            hub.setTitle("");
            hub.setMemory("");
          })}
        </View>
      ) : null}
    </View>
  );
}
