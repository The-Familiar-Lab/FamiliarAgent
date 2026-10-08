import { Text, View } from "react-native";
import { ROW, type HubUi } from "./ui.js";
import type { HubController, HubProps } from "./controller.js";
export function HubProjects({ hub, ui }: { hub: HubController; ui: HubUi; props: HubProps }) {
  const { tab, setTab, query, projects, run, selectProject } = hub;
  const { text, card, button } = ui;
  return (
    <>
      {tab === "Projects"
        ? projects
            .filter((item) => item.title.toLowerCase().includes(query.toLowerCase()))
            .map((item) => (
              <View key={item.id} style={card}>
                <Text style={text}>{item.title}</Text>
                <View style={ROW}>
                  {button("Open project", () => {
                    void run(() => selectProject(item.id));
                  })}
                  {button("Sessions", () => {
                    void run(async () => {
                      await selectProject(item.id);
                      setTab("Sessions");
                    });
                  })}
                </View>
              </View>
            ))
        : null}
      {tab === "Projects" && !projects.length ? (
        <Text style={text}>
          Choose an existing folder below and Create project. Then link its folder on another server
          to continue there.
        </Text>
      ) : null}
    </>
  );
}
