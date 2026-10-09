import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { HubController } from "./controller.js";

export const ROW = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;
const CONTENT = { padding: 12, gap: 12 };
const FILL = { flex: 1 };
const PICKER = { gap: 6 };
const OPTIONS = { gap: 4, paddingLeft: 8 };
const DISCLOSURE = { gap: 8 };
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
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        gap: 10,
      },
      heading: { ...text, fontSize: 22, fontWeight: "600" as const },
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
      padding: 8,
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
  const options = useMemo(
    () =>
      hub.hosts.map((item) => ({
        id: item.serverId,
        label: `${item.label}${item.status === "online" ? "" : " · offline"}`,
        disabled: item.status !== "online",
      })),
    [hub.hosts],
  );
  return (
    <HubPicker
      label="Run on"
      value={hub.target}
      options={options}
      onChange={hub.setTarget}
      ui={ui}
    />
  );
}

export function HubPicker({
  label,
  value,
  options,
  onChange,
  ui,
}: {
  label: string;
  value: string;
  options: { id: string; label: string; disabled?: boolean }[];
  onChange: (id: string) => void;
  ui: HubUi;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={PICKER}>
      {ui.button(
        `${label}: ${options.find((item) => item.id === value)?.label ?? "Choose…"} ${open ? "▴" : "▾"}`,
        () => setOpen(!open),
      )}
      {open ? (
        <View style={OPTIONS}>
          {options.map((item) => (
            <View key={item.id}>
              {ui.button(
                item.label,
                () => {
                  onChange(item.id);
                  setOpen(false);
                },
                item.disabled,
                value === item.id,
              )}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function HubDisclosure({
  label,
  ui,
  children,
}: {
  label: string;
  ui: HubUi;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={DISCLOSURE}>
      {ui.button(`${open ? "▾" : "▸"} ${label}`, () => setOpen(!open))}
      {open ? children : null}
    </View>
  );
}
