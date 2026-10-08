import { useMemo } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { HubController } from "./controller.js";

export const ROW = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;
const CONTENT = { padding: 24, gap: 16 };
const FILL = { flex: 1 };
function usePalette(theme: PluginSurfaceProps["theme"]) {
  return useMemo(() => {
    const colors = theme.colors;
    const text = { color: colors.foreground, fontSize: 14 };
    const input = {
      ...text,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.surface0,
    };
    return {
      colors,
      text,
      input,
      noteInput: { ...input, minHeight: 100, textAlignVertical: "top" as const },
      muted: { color: colors.foregroundMuted, fontSize: 12 },
      card: {
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        gap: 10,
      },
      heading: { ...text, fontSize: 28, fontWeight: "600" as const },
      sectionHeading: { ...text, fontSize: 18 },
      toolHeading: { ...text, fontSize: 17 },
      error: { color: colors.statusDanger },
      page: { ...FILL, backgroundColor: colors.surface0 },
      content: CONTENT,
      fill: FILL,
    };
  }, [theme]);
}
export function useHubUi(theme: PluginSurfaceProps["theme"], busy: boolean) {
  const palette = usePalette(theme);
  const button = (label: string, action: () => void, disabled = false, selected = false) => (
    <HubButton
      label={label}
      action={action}
      disabled={disabled || busy}
      selected={selected}
      theme={theme}
    />
  );
  const field = (
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    multiline = false,
  ) => (
    <TextInput
      accessibilityLabel={label}
      placeholder={label}
      placeholderTextColor={theme.colors.foregroundMuted}
      value={value}
      onChangeText={onChangeText}
      autoCapitalize="none"
      multiline={multiline}
      style={multiline ? palette.noteInput : palette.input}
    />
  );
  return { ...palette, button, field };
}
export type HubUi = ReturnType<typeof useHubUi>;
function HubButton({
  label,
  action,
  disabled,
  selected,
  theme,
}: {
  label: string;
  action: () => void;
  disabled: boolean;
  selected: boolean;
  theme: PluginSurfaceProps["theme"];
}) {
  const style = useMemo(
    () => ({
      padding: 10,
      borderRadius: 8,
      backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
      opacity: disabled ? 0.45 : 1,
    }),
    [theme, selected, disabled],
  );
  const text = useMemo(
    () => ({
      color: selected ? theme.colors.accentForeground : theme.colors.foreground,
      fontSize: 14,
    }),
    [theme, selected],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={action}
      disabled={disabled}
      style={style}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
}
export function HubTargetPicker({ hub, ui }: { hub: HubController; ui: HubUi }) {
  return (
    <View style={ROW}>
      {hub.online.map((item) => (
        <View key={item.serverId}>
          {ui.button(
            item.label,
            () => {
              hub.setTarget(item.serverId);
              const mapped = hub.project?.resources.find(
                (resource) => resource.kind === "codebase" && resource.serverId === item.serverId,
              );
              hub.setCwd(mapped?.locator ?? "");
            },
            false,
            hub.target === item.serverId,
          )}
        </View>
      ))}
    </View>
  );
}
