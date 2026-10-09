import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ROW, HubPicker, type HubUi } from "./ui.js";
import type { HubController } from "./controller.js";
import { CATALOG_PAGE_SIZE } from "./entry.js";
import {
  choiceKey,
  groupSessions,
  readSessionPreview,
  sessionRows,
  type SessionChoice,
  type SessionPreview,
  type BrowseRow,
} from "./browse.js";

const groupOptions = [
  { id: "project", label: "Project" },
  { id: "server", label: "Server" },
];
const BROWSER = { gap: 10 };
const GROUP = { gap: 6 };
const MESSAGE = { gap: 3 };
const ACTIONS = { ...ROW, justifyContent: "flex-end" } as const;
function SessionRow({
  row,
  ui,
  selected,
  active,
  choose,
}: {
  row: BrowseRow;
  ui: HubUi;
  selected: boolean;
  active: boolean;
  choose: (value: SessionChoice) => void;
}) {
  const style = useMemo(
    () => ({
      ...ui.card,
      padding: 10,
      borderColor: selected ? ui.colors.accent : ui.colors.border,
    }),
    [ui, selected],
  );
  const press = useCallback(() => choose(row.choice), [choose, row.choice]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Preview ${row.title} · ${row.detail}`}
      onPress={press}
      style={style}
    >
      <Text style={ui.text}>
        {row.title}
        {active ? " · Selected" : ""}
      </Text>
      <Text style={ui.muted}>{row.detail}</Text>
      <Text numberOfLines={1} style={ui.muted}>
        {row.folder}
      </Text>
    </Pressable>
  );
}

export function useSessionPreview(
  catalogId: string,
  choice: SessionChoice | null,
  online: ReadonlySet<string>,
) {
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const key = choice ? choiceKey(choice) : "";
  const hostsKey = [...online].sort().join("\0");
  const latest = useRef({ choice, online });
  latest.current = { choice, online };
  useEffect(() => {
    let current = true;
    setPreview(null);
    setError("");
    const selected = latest.current.choice;
    if (!selected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void readSessionPreview(catalogId, selected, latest.current.online)
      .then((value) => {
        if (current) setPreview(value);
        return undefined;
      })
      .catch((value: unknown) => {
        if (current) setError(value instanceof Error ? value.message : String(value));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [catalogId, key, hostsKey]);
  return { preview, error, loading };
}

export function HubSessions({
  hub,
  ui,
  onSelected,
}: {
  hub: HubController;
  ui: HubUi;
  onSelected?: () => void;
}) {
  const [groupBy, setGroupBy] = useState<"project" | "server">("project");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [choice, setChoice] = useState<SessionChoice | null>(null);
  useEffect(() => {
    if (hub.entryChoice) setChoice(hub.entryChoice);
  }, [hub.entryChoice]);
  const { preview, error, loading } = useSessionPreview(
    hub.host.id,
    choice,
    new Set(hub.online.map((item) => item.serverId)),
  );
  const groups = groupSessions(sessionRows(hub), groupBy, hub.hostName);
  const filterOptions = useMemo(
    () => [
      { id: "all", label: "All servers" },
      ...hub.hosts.map((host) => ({ id: host.serverId, label: `${host.label} · ${host.status}` })),
    ],
    [hub.hosts],
  );
  const chooseGroup = useCallback((id: string) => {
    setGroupBy(id as "project" | "server");
    setExpanded(new Set());
  }, []);
  const select = async () => {
    if (!choice) return;
    if (choice.kind === "shared") await hub.selectSession(choice.id);
    else await hub.attachNative(choice.serverId, choice.agent);
    onSelected?.();
  };
  return (
    <View style={BROWSER}>
      <Text style={ui.sectionHeading}>Find a session</Text>
      <HubPicker
        label="Group by"
        value={groupBy}
        options={groupOptions}
        onChange={chooseGroup}
        ui={ui}
      />
      {ui.field("Search session titles", hub.query, hub.setQuery)}
      <HubPicker
        label="Show"
        value={hub.filter}
        options={filterOptions}
        onChange={hub.setFilter}
        ui={ui}
      />
      {groups.map((group) => (
        <View key={group.id} style={GROUP}>
          {ui.button(
            `${expanded.has(group.id) ? "▾" : "▸"} ${group.label} (${group.rows.length})`,
            () =>
              setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(group.id)) next.delete(group.id);
                else next.add(group.id);
                return next;
              }),
          )}
          {expanded.has(group.id)
            ? group.rows.map((row) => (
                <SessionRow
                  key={row.key}
                  row={row}
                  ui={ui}
                  selected={choice ? choiceKey(choice) === row.key : false}
                  active={row.choice.kind === "shared" && row.choice.id === hub.session?.id}
                  choose={setChoice}
                />
              ))
            : null}
        </View>
      ))}
      {!groups.length ? (
        <Text style={ui.muted}>
          No matching sessions. Change the search or start a new session.
        </Text>
      ) : null}
      <View style={ROW}>
        {ui.button(
          "Previous",
          () => hub.setCatalogOffset(Math.max(0, hub.catalogOffset - CATALOG_PAGE_SIZE)),
          hub.catalogOffset === 0,
        )}
        {ui.button(
          "Next",
          () => hub.setCatalogOffset(hub.catalogOffset + CATALOG_PAGE_SIZE),
          hub.catalogOffset + CATALOG_PAGE_SIZE >= hub.catalogTotal,
        )}
        <Text style={ui.muted}>{hub.catalogTotal} shared sessions · latest native sessions</Text>
      </View>
      {choice ? (
        <View style={ui.card}>
          <Text style={ui.sectionHeading}>{preview?.title ?? "Conversation preview"}</Text>
          {loading ? <Text style={ui.muted}>Loading recent messages…</Text> : null}
          {error ? (
            <Text accessibilityRole="alert" style={ui.error}>
              {error}
            </Text>
          ) : null}
          {preview?.endpoints.map((endpoint) => (
            <Text key={endpoint.id} style={ui.muted}>
              {hub.hostName(endpoint.serverId)} · {endpoint.harness ?? endpoint.provider} ·{" "}
              {endpoint.model ?? "Model not reported"}
              {"\n"}
              {endpoint.cwd}
            </Text>
          ))}
          {preview?.messages.map((message) => (
            <View key={message.id} style={MESSAGE}>
              <Text style={ui.muted}>{message.role}</Text>
              <Text selectable style={ui.text}>
                {message.text}
              </Text>
            </View>
          ))}
          {preview ? <Text style={ui.muted}>{preview.note}</Text> : null}
          {choice.kind === "native" ? (
            <Text style={ui.muted}>
              Select session links this original conversation to FamiliarAgent. Nothing is sent or
              copied.
            </Text>
          ) : null}
          <View style={ACTIONS}>
            {ui.button("Cancel", () => setChoice(null))}
            {ui.button(
              "Select session",
              () => {
                void hub.run(select);
              },
              loading,
              true,
            )}
          </View>
        </View>
      ) : (
        <Text style={ui.muted}>Expand a group, preview a conversation, then select it.</Text>
      )}
    </View>
  );
}
