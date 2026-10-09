import { Text, Pressable } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ToolGuide } from "@getpaseo/protocol/familiar-tools";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import React from "react";

export function FamiliarToolHelp({ name, guide }: { name: string; guide: ToolGuide }) {
  return (
    <Tooltip enabledOnMobile>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`About ${name}`}
          style={styles.trigger}
        >
          <Text style={styles.mark}>?</Text>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="left" align="start" style={styles.content}>
        <Text style={styles.title}>{name}</Text>
        <Text style={styles.text}>{guide.summary}</Text>
        {guide.whenToUse.map((item) => (
          <Text key={item} style={styles.text}>
            • {item}
          </Text>
        ))}
        <Text style={styles.text}>{guide.execution}</Text>
        <Text style={styles.text}>{guide.continuation}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    minWidth: 32,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  mark: { color: theme.colors.foregroundMuted, fontWeight: "600" },
  content: { maxWidth: 340, gap: theme.spacing[2] },
  title: { color: theme.colors.foreground, fontWeight: "600" },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
