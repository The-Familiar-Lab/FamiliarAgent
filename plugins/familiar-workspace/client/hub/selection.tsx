import { Text, View } from "react-native";
import { ROW, type HubUi } from "./ui.js";
import type { HubController, HubProps } from "./controller.js";
export function HubSelection({ hub, ui }: { hub: HubController; ui: HubUi; props: HubProps }) {
  const { setTab, project, setProject, session, setSession, setTitle, setMemory } = hub;
  const { text, muted, card, button } = ui;
  return project ? (
    <View style={card}>
      <Text style={text}>
        Project: {project.title}
        {session ? `  /  Session: ${session.title}` : ""}
      </Text>
      <Text style={muted}>
        Linked folders and shared memory stay with this project. Each tool keeps its original
        runtime.
      </Text>
      <View style={ROW}>
        {button("Clear selection", () => {
          hub.setCatalogOffset(0);
          setProject(null);
          setSession(null);
          setTitle("");
          setMemory("");
        })}
        {button("Shared memory", () => {
          setMemory(session?.memory ?? project.memory);
          setTab("Memory & Skills");
        })}
      </View>
    </View>
  ) : null;
}
