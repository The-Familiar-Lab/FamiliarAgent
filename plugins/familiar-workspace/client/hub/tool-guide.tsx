import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ToolEntry } from "../../shared/tool-catalog.js";
import type { HubUi } from "./ui.js";

const GAP = { gap: 6 };
const HELP = { padding: 6, alignSelf: "flex-start" } as const;
export function ToolGuide({
  tool,
  ui,
  compact = false,
}: {
  tool: ToolEntry;
  ui: HubUi;
  compact?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const visible = hovered || focused || pinned;
  const state = useMemo(() => ({ expanded: visible }), [visible]);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);
  const toggle = useCallback(() => setPinned((value) => !value), []);
  return (
    <View style={GAP}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`About ${tool.name}`}
        accessibilityState={state}
        onHoverIn={hoverIn}
        onHoverOut={hoverOut}
        onFocus={focus}
        onBlur={blur}
        onPress={toggle}
        style={HELP}
      >
        <Text style={ui.text}>{compact ? "ⓘ" : `ⓘ About ${tool.name}`}</Text>
      </Pressable>
      {visible ? (
        <View style={ui.card}>
          <Text style={ui.text}>{tool.guide?.summary ?? tool.description}</Text>
          {tool.guide?.whenToUse.map((value) => (
            <Text key={value} style={ui.muted}>
              • {value}
            </Text>
          ))}
          <Text style={ui.muted}>Runs as: {tool.guide?.execution ?? tool.modes.join(", ")}</Text>
          {tool.guide?.continuation ? (
            <Text style={ui.muted}>{tool.guide.continuation}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
