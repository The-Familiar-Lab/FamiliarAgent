import { Text, View } from "react-native";
import { ROW, type HubUi } from "./ui.js";
import type { HubController, HubProps } from "./controller.js";
export function HubFiles({ hub, ui }: { hub: HubController; ui: HubUi; props: HubProps }) {
  const { navigation, tab, setTab, query, setTarget, setCwd, setTitle, visible } = hub;
  const { text, muted, card, button } = ui;
  return tab === "Projects" || tab === "Files" ? (
    <>
      <Text style={ui.sectionHeading}>Folders on connected servers</Text>
      {visible.flatMap((item) =>
        item.workspaces
          .filter((workspace) =>
            `${workspace.name} ${workspace.projectRootPath}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((workspace) => (
            <View key={`${item.server.serverId}:${workspace.id}`} style={card}>
              <Text style={text}>
                {workspace.projectDisplayName} / {workspace.name}
              </Text>
              <Text selectable style={muted}>
                {item.server.label} · {workspace.workspaceDirectory ?? workspace.projectRootPath}
              </Text>
              <View style={ROW}>
                {button("Use folder", () => {
                  setTarget(item.server.serverId);
                  setCwd(workspace.workspaceDirectory ?? workspace.projectRootPath);
                  setTitle(workspace.projectDisplayName);
                  setTab("Projects");
                })}
                {button("Open files & workspace", () =>
                  navigation?.openWorkspace({
                    serverId: item.server.serverId,
                    workspaceId: workspace.id,
                  }),
                )}
              </View>
            </View>
          )),
      )}
    </>
  ) : null;
}
