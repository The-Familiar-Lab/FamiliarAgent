import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { HubUi } from "./ui.js";
const GAP = { gap: 6 };
const BUTTON = { padding: 6, alignSelf: "flex-start" } as const;

export function ContextHelp({
  label,
  children,
  ui,
}: {
  label: string;
  children: ReactNode;
  ui: HubUi;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const state = useMemo(
    () => ({ expanded: hovered || focused || pinned }),
    [hovered, focused, pinned],
  );
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);
  const toggle = useCallback(() => setPinned((value) => !value), []);
  return (
    <View style={GAP}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={state}
        onHoverIn={enter}
        onHoverOut={leave}
        onFocus={focus}
        onBlur={blur}
        onPress={toggle}
        style={BUTTON}
      >
        <Text style={ui.muted}>? {label}</Text>
      </Pressable>
      {state.expanded ? <View style={ui.card}>{children}</View> : null}
    </View>
  );
}
export function ContextToggle({
  label,
  checked,
  disabled,
  onPress,
  ui,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onPress: () => void;
  ui: HubUi;
}) {
  const state = useMemo(() => ({ checked, disabled: !!disabled }), [checked, disabled]);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={state}
      disabled={disabled}
      onPress={onPress}
      style={BUTTON}
    >
      <Text style={disabled ? ui.muted : ui.text}>
        {checked ? "☑" : "☐"} {label}
      </Text>
    </Pressable>
  );
}
