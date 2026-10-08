import { Text, View } from "react-native";
import { type HubUi } from "./ui.js";
import type { HubController, HubProps } from "./controller.js";
export function HubServers({ hub, ui, props }: { hub: HubController; ui: HubUi; props: HubProps }) {
  const { hosts, tab, setTab, setFilter, advanced, setAdvanced } = hub;
  const { text, muted, card, button } = ui;
  return tab === "Servers" ? (
    <>
      {hosts.map((server) => (
        <View key={server.serverId} style={card}>
          <Text style={text}>
            {server.label} · {server.status}
          </Text>
          <Text style={muted}>{server.connection || "Managed local / configured connection"}</Text>
          <Text style={muted}>
            FamiliarAgent data: ~/.local/share/familiaragent · Original tools keep their own data
            paths.
          </Text>
          {button("Discover conversations", () => {
            setFilter(server.serverId);
            setTab("History");
          })}
        </View>
      ))}
      {button(advanced ? "Hide Advanced" : "Advanced", () => setAdvanced(!advanced))}
      {advanced ? <props.Advanced {...props} /> : null}
    </>
  ) : null;
}
