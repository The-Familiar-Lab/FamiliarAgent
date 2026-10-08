import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View, Text, TextInput, Pressable } from "react-native";
import { useHosts, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  listHistory,
  scanHistory,
  readHistory,
  hideHistory,
  exportHistory,
  type HistorySummary,
  type HistoryMessage,
} from "../shared/history.js";
import { hostRpc } from "./fleet.js";
import { loadHistoryFleet, type HostedHistory } from "./history-fleet.js";

const PAGE_SIZE = 30;
const POLL_MS = 1500;
const ALL_SERVERS = "all";
const ROW = { flexDirection: "row", gap: 8, flexWrap: "wrap" } as const;
const CONTENT = { padding: 24, gap: 14 };
type LibraryProps = PluginSurfaceProps & {
  initialServerId?: string;
  onLink?: (serverId: string, conversation: HistorySummary) => void | Promise<void>;
};
export function ConversationLibrary({ host, theme, onLink, initialServerId }: LibraryProps) {
  const hosts = useHosts();
  const [serverId, setServerId] = useState(initialServerId ?? ALL_SERVERS);
  const selectedHosts = useMemo(
    () => (serverId === ALL_SERVERS ? hosts : hosts.filter((item) => item.serverId === serverId)),
    [hosts, serverId],
  );
  const [entries, setEntries] = useState<HostedHistory[]>([]),
    [total, setTotal] = useState(0),
    [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState(""),
    [includeHidden, setIncludeHidden] = useState(false),
    [offset, setOffset] = useState(0);
  const [showWarnings, setShowWarnings] = useState(false),
    [showImport, setShowImport] = useState(false),
    [hostErrors, setHostErrors] = useState<string[]>([]);
  const [job, setJob] = useState({
    running: false,
    imported: 0,
    skipped: 0,
    errors: [] as string[],
  });
  const [selected, setSelected] = useState<
    (HostedHistory & { messages: HistoryMessage[]; total: number }) | null
  >(null);
  const [messageOffset, setMessageOffset] = useState(0),
    [exportPath, setExportPath] = useState(""),
    [exportHost, setExportHost] = useState(host.id),
    [notice, setNotice] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initialServerId === undefined) return;
    setServerId(initialServerId);
    setOffset(0);
    setSelected(null);
  }, [initialServerId]);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const version = ++generation.current;
    const result = await loadHistoryFleet(
      selectedHosts,
      { query, includeHidden, offset, limit: PAGE_SIZE },
      (id, input) => hostRpc(id, listHistory, input),
    );
    if (version !== generation.current) return;
    setEntries(result.entries);
    setTotal(result.total);
    setHasMore(result.hasMore);
    setHostErrors(result.errors);
    setJob(result.job);
  }, [selectedHosts, query, includeHidden, offset]);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const changeQuery = useCallback((value: string) => {
    setQuery(value);
    setOffset(0);
  }, []);
  const selectExportHost = useCallback(async (id: string) => {
    setExportHost(id);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 200);
    return () => {
      clearTimeout(timer);
      invalidate();
    };
  }, [load, invalidate]);
  useEffect(() => {
    if (!job.running) return;
    const timer = setTimeout(() => {
      void load();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [job, load]);
  useEffect(() => {
    if (serverId !== ALL_SERVERS && !hosts.some((item) => item.serverId === serverId)) {
      setServerId(ALL_SERVERS);
      setOffset(0);
    }
  }, [hosts, serverId]);
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }, []);
  const open = async (item: HostedHistory, page = 0) => {
    const result = await hostRpc(item.serverId, readHistory, {
      id: item.id,
      offset: page,
      limit: PAGE_SIZE,
    });
    setSelected({ ...result, serverId: item.serverId, serverLabel: item.serverLabel });
    setMessageOffset(page);
  };
  const palette = useMemo(() => {
    const text = { color: theme.colors.foreground, fontSize: 14 };
    const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
    const card = { padding: 14, borderRadius: 8, backgroundColor: theme.colors.surface1, gap: 8 };
    return {
      text,
      muted,
      card,
      input: { ...text, ...card, borderWidth: 1, borderColor: theme.colors.border },
      page: { flex: 1, backgroundColor: theme.colors.surface0 },
      heading: { ...text, fontSize: 24, fontWeight: "600" as const },
      title: { ...text, fontSize: 20 },
      error: { color: theme.colors.statusDanger },
      scanError: { ...muted, color: theme.colors.statusDanger },
    };
  }, [theme]);
  const { text, muted, card, input } = palette;
  const button = (label: string, action: () => Promise<void>, disabled = false) => (
    <HistoryButton
      label={label}
      action={action}
      execute={run}
      disabled={busy || disabled}
      theme={theme}
    />
  );
  const selectServer = useCallback(async (id: string) => {
    setServerId(id);
    setOffset(0);
  }, []);
  const scanHosts = async () => {
    const results = await Promise.all(
      selectedHosts
        .filter((item) => item.status === "online")
        .map(async (item) => {
          try {
            await hostRpc(item.serverId, scanHistory, {});
            return "";
          } catch (failure) {
            return `${item.label}: ${failure instanceof Error ? failure.message : String(failure)}`;
          }
        }),
    );
    setError(results.filter(Boolean).join("\n"));
    await load();
  };
  const link = async (item: HostedHistory) => {
    if (!onLink) return;
    await onLink(item.serverId, item);
    setNotice(`Linked ${item.title} from ${item.serverLabel}. The original stays on its server.`);
  };
  const selectedView = () => {
    if (!selected) return null;
    return (
      <>
        {button("Back to library", async () => {
          setSelected(null);
        })}
        <Text selectable style={palette.title}>
          {selected.title}
        </Text>
        <Text selectable style={muted}>
          {selected.serverLabel} · {selected.source} · {selected.hidden ? "Hidden" : "Visible"} ·{" "}
          {selected.updatedAt}
          {"\n"}
          {selected.workspace || "No workspace reported"}
          {"\n"}
          {selected.origin}
          {"\n"}Native ID: {selected.nativeId}
        </Text>
        {selected.notes.map((note) => (
          <Text key={note} style={muted}>
            {note}
          </Text>
        ))}
        <Text style={muted}>
          Read-only view of the original conversation. Use in session links its context to your
          FamiliarAgent session. Native Claude/Codex execution can also resume through Import
          session.
        </Text>
        <View style={ROW}>
          {onLink ? button("Use in session", () => link(selected)) : null}
          {button(selected.hidden ? "Restore" : "Hide", async () => {
            const item = await hostRpc(selected.serverId, hideHistory, {
              id: selected.id,
              hidden: !selected.hidden,
            });
            setSelected({ ...selected, hidden: item.hidden });
            await load();
          })}
          {button("Export transcript", async () => {
            const result = await hostRpc(selected.serverId, exportHistory, { id: selected.id });
            setNotice(
              `Saved on ${selected.serverLabel}: ${result.path}\nThis export is a copy created only because you requested it.`,
            );
          })}
        </View>
        <Text style={muted}>
          Messages {selected.total ? messageOffset + 1 : 0}–
          {Math.min(messageOffset + PAGE_SIZE, selected.total)} of {selected.total}
        </Text>
        <View style={ROW}>
          {button(
            "Previous messages",
            () => open(selected, Math.max(0, messageOffset - PAGE_SIZE)),
            messageOffset === 0,
          )}
          {button(
            "Next messages",
            () => open(selected, messageOffset + PAGE_SIZE),
            messageOffset + PAGE_SIZE >= selected.total,
          )}
        </View>
        {selected.messages
          .map((message, index) => ({ ...message, key: `${messageOffset}:${index}` }))
          .map((message) => (
            <View key={message.key} style={card}>
              <Text style={muted}>
                {message.role} {message.timestamp || ""}
              </Text>
              <Text selectable style={text}>
                {message.text}
              </Text>
            </View>
          ))}
      </>
    );
  };
  return (
    <ScrollView style={palette.page} contentContainerStyle={CONTENT}>
      <Text style={palette.heading}>Conversation library</Text>
      <Text style={muted}>
        One library across your connected servers. Records point to the original apps; open a
        conversation to read its current messages.
      </Text>
      {selected ? (
        selectedView()
      ) : (
        <>
          <View style={ROW}>
            {button(serverId === ALL_SERVERS ? "All servers ✓" : "All servers", () =>
              selectServer(ALL_SERVERS),
            )}
            {hosts.map((item) => (
              <HistoryHostButton
                key={item.serverId}
                serverId={item.serverId}
                label={`${item.label}${serverId === item.serverId ? " ✓" : ""}${item.status === "online" ? "" : " · Offline"}`}
                select={selectServer}
                execute={run}
                disabled={busy}
                theme={theme}
              />
            ))}
          </View>
          <View style={ROW}>
            {button(
              scanButtonLabel(job.running, serverId === ALL_SERVERS),
              scanHosts,
              job.running || !selectedHosts.some((item) => item.status === "online"),
            )}
            {button("Refresh", load)}
            {button(includeHidden ? "Exclude hidden" : "Show hidden", async () => {
              setIncludeHidden(!includeHidden);
              setOffset(0);
            })}
            {button(showImport ? "Close ChatGPT import" : "Import ChatGPT export", async () => {
              setShowImport(!showImport);
            })}
          </View>
          <Text style={muted}>
            Find Cursor, VSCode, Codex, Claude and Antigravity records wherever they live. SSH
            editor conversations may be stored on your Mac. Keep Antigravity open to read its
            encrypted history.
          </Text>
          <TextInput
            accessibilityLabel="Search conversations"
            value={query}
            onChangeText={changeQuery}
            placeholder="Search title, source, SSH workspace or session ID"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={input}
          />
          <Text style={muted}>
            {total} conversations on available servers · Latest scan: {job.imported} linked,{" "}
            {job.skipped} empty/unchanged/older skipped{job.running ? " · Running" : ""}
          </Text>
          {hostErrors.map((item) => (
            <Text key={item} accessibilityRole="alert" style={palette.scanError}>
              {item}
            </Text>
          ))}
          {job.errors.length
            ? button(
                `${showWarnings ? "Hide" : "Show"} scan details (${job.errors.length} warnings)`,
                async () => {
                  setShowWarnings(!showWarnings);
                },
              )
            : null}
          {showWarnings
            ? [...new Set(job.errors)].map((item) => (
                <Text key={item} selectable style={palette.scanError}>
                  {item}
                </Text>
              ))
            : null}
          {showImport ? (
            <View style={card}>
              <Text style={text}>Link ChatGPT export</Text>
              <Text style={muted}>
                In ChatGPT: Settings → Data controls → Export data. Extract the ZIP and select the
                server holding conversations.json. Keep this file in place; the library reads it
                when needed.
              </Text>
              <View style={ROW}>
                {hosts.map((item) => (
                  <HistoryHostButton
                    key={item.serverId}
                    serverId={item.serverId}
                    label={`${item.label}${exportHost === item.serverId ? " ✓" : ""}`}
                    select={selectExportHost}
                    execute={run}
                    disabled={busy || item.status !== "online"}
                    theme={theme}
                  />
                ))}
              </View>
              <TextInput
                accessibilityLabel="ChatGPT export path"
                value={exportPath}
                onChangeText={setExportPath}
                placeholder="/absolute/path/conversations.json"
                placeholderTextColor={theme.colors.foregroundMuted}
                autoCapitalize="none"
                style={input}
              />
              {button(
                "Link export",
                async () => {
                  await hostRpc(exportHost, scanHistory, { exportPath: exportPath.trim() });
                  await load();
                },
                !exportPath.trim() ||
                  job.running ||
                  !hosts.some((item) => item.serverId === exportHost && item.status === "online"),
              )}
            </View>
          ) : null}
          <View style={ROW}>
            {button(
              "Previous page",
              async () => {
                setOffset(Math.max(0, offset - PAGE_SIZE));
              },
              offset === 0,
            )}
            {button(
              "Next page",
              async () => {
                setOffset(offset + PAGE_SIZE);
              },
              !hasMore,
            )}
          </View>
          <Text style={muted}>
            Page {Math.floor(offset / PAGE_SIZE) + 1} · Up to {PAGE_SIZE} records per server, newest
            first within this page.
          </Text>
          {entries.map((item) => (
            <View key={`${item.serverId}:${item.id}`} style={card}>
              <View>
                <Text numberOfLines={3} style={text}>
                  {item.title}
                </Text>
                <Text style={muted}>
                  {item.serverLabel} · {item.source} · {item.messageCount} messages
                  {item.hidden ? " · Hidden" : ""}
                  {"\n"}
                  {item.workspace || item.origin}
                </Text>
              </View>
              <View style={ROW}>
                {button("Open conversation", () => open(item))}
                {onLink ? button("Use in session", () => link(item)) : null}
                {button(item.hidden ? "Restore" : "Hide", async () => {
                  await hostRpc(item.serverId, hideHistory, { id: item.id, hidden: !item.hidden });
                  await load();
                })}
              </View>
            </View>
          ))}
          {!entries.length && !job.running ? (
            <Text style={text}>
              No matching records on this page. Scan the connected servers to link their existing
              conversations.
            </Text>
          ) : null}
        </>
      )}
      {notice ? (
        <Text selectable style={text}>
          {notice}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" selectable style={palette.error}>
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}
function HistoryButton({
  label,
  action,
  execute,
  disabled,
  theme,
}: {
  label: string;
  action: () => Promise<void>;
  execute: (action: () => Promise<void>) => Promise<void>;
  disabled: boolean;
  theme: PluginSurfaceProps["theme"];
}) {
  const press = useCallback(() => {
    void execute(action);
  }, [execute, action]);
  const style = useMemo(
    () => ({
      padding: 10,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
      opacity: disabled ? 0.5 : 1,
    }),
    [theme, disabled],
  );
  const text = useMemo(() => ({ color: theme.colors.foreground, fontSize: 14 }), [theme]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={press}
      disabled={disabled}
      style={style}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
}

function scanButtonLabel(running: boolean, all: boolean): string {
  if (running) return "Scanning…";
  return all ? "Scan all connected servers" : "Scan history";
}
function HistoryHostButton({
  serverId,
  select,
  ...props
}: Omit<Parameters<typeof HistoryButton>[0], "action"> & {
  serverId: string;
  select: (id: string) => Promise<void>;
}) {
  const action = useCallback(() => select(serverId), [select, serverId]);
  return <HistoryButton {...props} action={action} />;
}
