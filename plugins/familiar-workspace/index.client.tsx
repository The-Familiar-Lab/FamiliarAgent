import { ConversationLibrary } from "./client/history.js";
import { FamiliarHub } from "./client/hub.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, View, Text, TextInput, Pressable } from "react-native";
import {
  useRpc,
  type PluginClientContext,
  type PluginSurfaceProps,
  type PluginScreenProps,
  type PluginWorkspacePanelProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow, ExternalLink } from "@getpaseo/plugin/client/ui";
import {
  readSpace,
  saveSpace,
  listSpaces,
  type WorkspaceDocument,
  sharingSettingsRpc,
  sharingSettings,
} from "./shared/contracts.js";

const ROW_STYLE = { flexDirection: "row", gap: 8, flexWrap: "wrap" } as const;
const ITEM_STYLE = { gap: 6 };
const PAGE_CONTENT_STYLE = { padding: 24, gap: 16 };
function SharedWorkspace(props: PluginSurfaceProps | PluginWorkspacePanelProps) {
  const { theme, host } = props;
  const read = useRpc(readSpace),
    save = useRpc(saveSpace),
    list = useRpc(listSpaces);
  const readSharing = useRpc(sharingSettingsRpc.read),
    writeSharing = useRpc(sharingSettingsRpc.write);
  const [authority, setAuthority] = useState("");
  const [sharingRevision, setSharingRevision] = useState<string | null>(null);
  const [id, setId] = useState("main");
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const [spaces, setSpaces] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [machine, setMachine] = useState(host.label),
    [directory, setDirectory] = useState("");
  const [toolName, setToolName] = useState(""),
    [toolUrl, setToolUrl] = useState("");
  const load = useCallback(
    async (space: string) => {
      setBusy(true);
      setError("");
      try {
        setDocument(await read({ id: space }));
        setDirty(false);
        setId(space);
        setSpaces((await list({})).map((item) => item.id));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(false);
      }
    },
    [read, list],
  );
  useEffect(() => {
    void load("main");
  }, [load]);
  useEffect(() => {
    void readSharing({})
      .then((result) => {
        if (result.status !== "ready") throw new Error(result.error);
        setAuthority(sharingSettings.schema.parse(result.values).authority);
        setSharingRevision(result.revision);
        return undefined;
      })
      .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, [readSharing]);
  const changeAuthority = async () => {
    if (!sharingRevision) return;
    setBusy(true);
    setError("");
    try {
      const values = sharingSettings.schema.parse({ authority });
      const result = await writeSharing({ revision: sharingRevision, values });
      if (result.status !== "saved") throw new Error(result.error);
      setSharingRevision(result.revision);
      await load(id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!document) return;
    setBusy(true);
    setError("");
    try {
      const result = await save(document);
      setDocument(result);
      setDirty(false);
      setSpaces((await list({})).map((item) => item.id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const update = useCallback(
    (patch: Partial<WorkspaceDocument>) => {
      if (document) {
        setDocument({ ...document, ...patch });
        setDirty(true);
      }
    },
    [document],
  );
  const updateNotes = useCallback((notes: string) => update({ notes }), [update]);
  const palette = useMemo(() => {
    const text = { color: theme.colors.foreground, fontSize: 14 };
    const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
    const input = {
      ...text,
      backgroundColor: theme.colors.surface1,
      padding: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
    };
    return {
      text,
      muted,
      input,
      heading: { ...text, fontSize: 24, fontWeight: "600" as const },
      note: { ...input, minHeight: 180, textAlignVertical: "top" as const },
      page: { flex: 1, backgroundColor: theme.colors.surface0 },
      error: { color: theme.colors.statusDanger },
      disabledAction: {
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        opacity: 0.5,
      },
      action: { padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface2 },
    };
  }, [theme]);
  const { text, muted, input } = palette;
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={action}
      disabled={disabled || busy}
      style={disabled || busy ? palette.disabledAction : palette.action}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView style={palette.page} contentContainerStyle={PAGE_CONTENT_STYLE}>
      <Text style={palette.heading}>Shared workspace</Text>
      <Text style={muted}>Connected host: {host.label}. Native tools keep their own sessions.</Text>
      <Text style={text}>Shared storage server</Text>
      <Text style={muted}>
        Leave empty to store here. Point other machines to the same SSH server to share one revision
        across tools and machines.
      </Text>
      <TextInput
        accessibilityLabel="Shared storage SSH address"
        value={authority}
        onChangeText={setAuthority}
        editable={!busy && !dirty}
        style={input}
        placeholder="This server, or ssh://server?daemonPort=6787"
        autoCapitalize="none"
      />
      {button(
        "Use this shared storage",
        () => {
          void changeAuthority();
        },
        dirty || !sharingRevision,
      )}
      <View style={ROW_STYLE}>
        {spaces.map((space) => (
          <View key={space}>
            {button(
              space,
              () => {
                void load(space);
              },
              dirty,
            )}
          </View>
        ))}
      </View>
      <TextInput
        accessibilityLabel="Shared workspace ID"
        value={id}
        onChangeText={setId}
        editable={!busy && !dirty}
        style={input}
      />
      {button(
        "Open / create workspace",
        () => {
          void load(id);
        },
        dirty,
      )}
      {document ? (
        <>
          <Text style={muted}>
            Revision {document.revision} · {document.updatedAt || "Not saved yet"}
            {dirty ? " · Unsaved changes" : ""}
          </Text>
          <Text style={text}>Shared context</Text>
          <TextInput
            accessibilityLabel="Shared context"
            value={document.notes}
            onChangeText={updateNotes}
            multiline
            editable={!busy}
            style={palette.note}
            placeholder="Decisions, handoff notes, artifact references and constraints for your tools…"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
          <Text style={text}>Machine path mappings</Text>
          <Text style={muted}>
            Map the same logical workspace to each machine’s directory. A mapping does not silently
            copy or overwrite files.
          </Text>
          {document.mappings.map((mapping, index) => (
            <View key={`${mapping.machine}:${mapping.path}`} style={ITEM_STYLE}>
              <Text selectable style={text}>
                {mapping.machine} → {mapping.path}
              </Text>
              {button("Remove mapping", () =>
                update({ mappings: document.mappings.filter((_, i) => i !== index) }),
              )}
            </View>
          ))}
          <TextInput
            accessibilityLabel="Machine label"
            value={machine}
            onChangeText={setMachine}
            style={input}
            placeholder="Machine / SSH alias"
          />
          <TextInput
            accessibilityLabel="Workspace directory"
            value={directory}
            onChangeText={setDirectory}
            style={input}
            placeholder="/absolute/workspace/path"
          />
          {button(
            "Add mapping",
            () => {
              update({ mappings: [...document.mappings, { machine, path: directory }] });
              setDirectory("");
            },
            !machine.trim() || !directory.trim(),
          )}
          <Text style={text}>Native tool surfaces</Text>
          {document.tools.map((tool, index) => (
            <View key={`${tool.name}:${tool.url}`} style={ITEM_STYLE}>
              <ExternalLink href={tool.url}>{tool.name}</ExternalLink>
              {"workspaceId" in props && props.navigation?.openBrowser
                ? button("Open beside this workspace", () =>
                    props.navigation?.openBrowser?.({
                      url: tool.url,
                      workspaceId: props.workspaceId,
                    }),
                  )
                : null}
              {button("Remove tool", () =>
                update({ tools: document.tools.filter((_, i) => i !== index) }),
              )}
            </View>
          ))}
          <TextInput
            accessibilityLabel="Tool name"
            value={toolName}
            onChangeText={setToolName}
            style={input}
            placeholder="OpenRig / Orca / your web tool"
          />
          <TextInput
            accessibilityLabel="Tool URL"
            value={toolUrl}
            onChangeText={setToolUrl}
            style={input}
            placeholder="http://localhost:…"
            autoCapitalize="none"
          />
          {button(
            "Add native tool",
            () => {
              update({ tools: [...document.tools, { name: toolName, url: toolUrl }] });
              setToolName("");
              setToolUrl("");
            },
            !toolName.trim() || !/^https?:\/\//u.test(toolUrl),
          )}
          <View style={ROW_STYLE}>
            {button(
              busy ? "Working…" : "Save shared revision",
              () => {
                void commit();
              },
              !dirty,
            )}
            {button(dirty ? "Discard edits and reload" : "Refresh", () => {
              void load(document.id);
            })}
          </View>
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={palette.error}>
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}
function Entry({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "main" }), [openScreen]);
  return <SidebarRow icon="Network" active={currentScreen?.screenId === "main"} onPress={open} />;
}
function HistoryEntry({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "history" }), [openScreen]);
  return (
    <SidebarRow icon="History" active={currentScreen?.screenId === "history"} onPress={open} />
  );
}
function Hub(props: PluginSurfaceProps | PluginScreenProps) {
  return <FamiliarHub {...props} Advanced={SharedWorkspace} />;
}
export default function contribute(client: PluginClientContext) {
  const History = (props: PluginScreenProps) => {
    const openHistoryInHub = useCallback(
      (serverId: string, conversation: { id: string }) =>
        client.openScreen({
          screenId: "main",
          params: { historyServerId: serverId, historyId: conversation.id },
        }),
      [],
    );
    return <ConversationLibrary {...props} onLink={openHistoryInHub} />;
  };
  client.addCommandCenterItem({
    id: "switch-composition-tool",
    title: "Switch tool in Familiar Hub",
    icon: "Network",
    context: "agent",
    onSelect({ agent, openScreen }) {
      openScreen({ screenId: "main", params: { agentId: agent.id } });
    },
  });
  client.addSlashCommand({
    name: "familiar",
    description: "Continue this session with another tool or server",
    argumentHint: "",
    context: "agent",
    onSubmit({ agent, openScreen }) {
      openScreen({ screenId: "main", params: { agentId: agent.id } });
    },
  });
  client.addScreen({
    id: "history",
    title: "Conversation library",
    scope: "fleet",
    Component: History,
  });
  client.addSidebarHeaderItem({
    id: "history",
    title: "Conversation library",
    Component: HistoryEntry,
  });
  client.addScreen({ id: "main", title: "Familiar Hub", scope: "fleet", Component: Hub });
  client.addSidebarHeaderItem({ id: "shared", title: "Familiar Hub", Component: Entry });
  client.addWorkspacePanel({
    id: "shared",
    title: "Familiar Hub",
    icon: "Network",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: Hub,
  });
  client.addCommandCenterItem({
    id: "open-shared",
    title: "Open Familiar Hub",
    icon: "Network",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("shared");
    },
  });
  return () => {};
}
