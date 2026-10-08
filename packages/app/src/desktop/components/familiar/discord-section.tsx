import { z } from "zod";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useHosts, getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { Agent } from "@/stores/session-store";
import type { HostProfile } from "@/types/host-connection";

interface Binding {
  channelId: string;
  host: string;
  agentId?: string;
  sessionId?: string;
  allowedUserIds: string[];
  sharedWorkspace: string;
}
const logicalCatalog = z.object({
  sessions: z.array(z.object({ id: z.string(), title: z.string() })),
});
interface LogicalChoice {
  id: string;
  title: string;
  host: string;
  label: string;
}
interface Status {
  bindings: Binding[];
  tokenSet: boolean;
  state: string;
  error: string | null;
}
function canConnect(
  status: Status | null,
  busy: boolean,
  bindings: Binding[],
  token: string,
): boolean {
  return (
    !busy &&
    status !== null &&
    status.tokenSet &&
    status.bindings.length > 0 &&
    status.state === "stopped" &&
    bindings === status.bindings &&
    !token
  );
}
function endpoint(profile: HostProfile): string | null {
  const activeId = getHostRuntimeStore().getSnapshot(profile.serverId)?.activeConnectionId;
  const connection =
    profile.connections.find((item) => item.id === activeId) ??
    profile.connections.find((item) => item.id === profile.preferredConnectionId) ??
    profile.connections[0];
  if (!connection) return null;
  if (connection.type === "directTcp")
    return buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false });
  if (connection.type === "directSocket" || connection.type === "directPipe")
    return connection.path;
  if (connection.type === "remoteSsh") {
    const url = new URL(`ssh://${connection.host}`);
    if (connection.sshPort) url.port = String(connection.sshPort);
    if (connection.daemonPort) url.searchParams.set("daemonPort", String(connection.daemonPort));
    return url.toString();
  }
  return null;
}
const CARD_STYLE = { padding: 16, gap: 14 };
const ITEM_STYLE = { gap: 6 };
const ACTIONS_STYLE = { flexDirection: "row", gap: 8, flexWrap: "wrap" } as const;
function BindingRow({
  binding,
  editing,
  remove,
}: {
  binding: Binding;
  editing: boolean;
  remove: (id: string) => void;
}) {
  const onRemove = useCallback(() => remove(binding.channelId), [remove, binding.channelId]);
  return (
    <View style={ITEM_STYLE}>
      <Text selectable style={settingsStyles.rowHint}>
        Channel {binding.channelId} →{" "}
        {binding.sessionId ? `Logical session ${binding.sessionId}` : binding.agentId} ·{" "}
        {binding.host}
      </Text>
      <Button variant="outline" disabled={!editing} onPress={onRemove}>
        Remove channel
      </Button>
    </View>
  );
}
function SessionButton({
  label,
  target,
  agent,
  editing,
  select,
}: {
  label: string;
  target: string;
  agent: Agent;
  editing: boolean;
  select: (target: string, id: string) => void;
}) {
  const onSelect = useCallback(() => select(target, agent.id), [select, target, agent.id]);
  return (
    <Button variant="outline" disabled={!editing} onPress={onSelect}>
      {label} · {agent.title || agent.id}
    </Button>
  );
}
function LogicalSessionButton({
  choice,
  editing,
  select,
}: {
  choice: LogicalChoice;
  editing: boolean;
  select: (choice: LogicalChoice) => void;
}) {
  const onSelect = useCallback(() => select(choice), [select, choice]);
  return (
    <Button variant="outline" disabled={!editing} onPress={onSelect}>
      {choice.title} · follows tool switches
    </Button>
  );
}
export function DiscordSection() {
  const hosts = useHosts();
  const sessions = useSessionStore((state) => state.sessions);
  const [status, setStatus] = useState<Status | null>(null);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [formRevision, setFormRevision] = useState(0);
  const [token, setToken] = useState("");
  const [channelId, setChannelId] = useState("");
  const [users, setUsers] = useState("");
  const [host, setHost] = useState("");
  const [agentId, setAgentId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [logicalSessions, setLogicalSessions] = useState<LogicalChoice[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const next = await invokeDesktopCommand<Status>("familiar_discord_status");
    setStatus(next);
    setBindings(next.bindings);
  }, []);
  useEffect(() => {
    void refresh().catch((failure) => setError(String(failure)));
  }, [refresh]);
  const action = useCallback(async (command: string, args?: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      const next = await invokeDesktopCommand<Status>(command, args);
      setStatus(next);
      setBindings(next.bindings);
      if (command === "familiar_discord_save") {
        setToken("");
        setFormRevision((value) => value + 1);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    let current = true;
    void Promise.allSettled(
      hosts.map(async (profile) => {
        const target = endpoint(profile);
        const runtime = getHostRuntimeStore().getSnapshot(profile.serverId);
        if (!target || runtime?.connectionStatus !== "online" || !runtime.client) return [];
        const catalog = logicalCatalog.parse(
          await runtime.client.invokePluginRpc("familiar-workspace", "composition.list", {
            limit: 100,
          }),
        );
        return catalog.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          host: target,
          label: profile.label,
        }));
      }),
    ).then((results) => {
      if (current) {
        const choices = results.flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        );
        setLogicalSessions([...new Map(choices.map((choice) => [choice.id, choice])).values()]);
      }
      return undefined;
    });
    return () => {
      current = false;
    };
  }, [hosts]);
  const selectLogical = useCallback((choice: LogicalChoice) => {
    setHost(choice.host);
    setSessionId(choice.id);
    setAgentId("");
    setFormRevision((value) => value + 1);
  }, []);
  const editing = !busy && status?.state === "stopped";
  const removeBinding = useCallback(
    (channel: string) => setBindings((items) => items.filter((item) => item.channelId !== channel)),
    [],
  );
  const selectAgent = useCallback((target: string, id: string) => {
    setHost(target);
    setAgentId(id);
    setSessionId("");
    setFormRevision((value) => value + 1);
  }, []);
  const addBinding = useCallback(() => {
    setBindings((items) => [
      ...items.filter((item) => item.channelId !== channelId),
      {
        channelId,
        host,
        ...(sessionId.trim() ? { sessionId: sessionId.trim() } : { agentId }),
        allowedUserIds: users.split(",").map((value) => value.trim()),
        sharedWorkspace: "main",
      },
    ]);
    setChannelId("");
    setFormRevision((value) => value + 1);
  }, [channelId, host, agentId, sessionId, users]);
  const saveSettings = useCallback(() => {
    const servers = Object.fromEntries(
      hosts.flatMap((profile) => {
        const address = endpoint(profile);
        return address ? [[profile.serverId, address]] : [];
      }),
    );
    void action("familiar_discord_save", { bindings, servers, ...(token ? { token } : {}) });
  }, [action, bindings, token, hosts]);
  const connect = useCallback(() => {
    void action("familiar_discord_start");
  }, [action]);
  const disconnect = useCallback(() => {
    void action("familiar_discord_stop");
  }, [action]);
  const refreshStatus = useCallback(() => {
    void refresh().catch((failure) => setError(String(failure)));
  }, [refresh]);
  return (
    <SettingsSection title="Discord · AI Agent Discord Connector">
      <View style={[settingsStyles.card, CARD_STYLE]}>
        <Text style={settingsStyles.rowHint}>
          Continue the same agent from the Discord app. This channel stays optional; your desktop,
          terminals and native tool screens remain available. The connector runs while FamiliarAgent
          is open.
        </Text>
        <Text style={settingsStyles.rowTitle}>Status: {status?.state ?? "loading"}</Text>
        <Text style={settingsStyles.rowHint}>
          Enable Message Content Intent for your Discord bot, invite it to your server, then copy
          your channel and user IDs using Discord Developer Mode. Only listed users can control the
          bound session.
        </Text>
        <Field
          label={
            status?.tokenSet ? "Bot token (saved securely; enter only to replace)" : "Bot token"
          }
        >
          <FormTextInput
            accessibilityLabel="Discord bot token"
            initialValue={token}
            resetKey={formRevision}
            onChangeText={setToken}
            secureTextEntry
            autoCapitalize="none"
            editable={editing}
          />
        </Field>
        {bindings.map((binding) => (
          <BindingRow
            key={binding.channelId}
            binding={binding}
            editing={editing}
            remove={removeBinding}
          />
        ))}
        <Text style={settingsStyles.rowTitle}>Follow a Familiar Hub session</Text>
        <View style={ITEM_STYLE}>
          {logicalSessions.map((choice) => (
            <LogicalSessionButton
              key={choice.id}
              choice={choice}
              editing={editing}
              select={selectLogical}
            />
          ))}
        </View>
        <Text style={settingsStyles.rowTitle}>Or choose one native agent</Text>
        <View style={ITEM_STYLE}>
          {hosts.flatMap((profile) => {
            const target = endpoint(profile);
            if (!target) return [];
            return Array.from(sessions[profile.serverId]?.agents.values() ?? [])
              .slice(0, 20)
              .map((agent) => (
                <SessionButton
                  key={`${profile.serverId}:${agent.id}`}
                  label={profile.label}
                  target={target}
                  agent={agent}
                  editing={editing}
                  select={selectAgent}
                />
              ));
          })}
        </View>
        <Field
          label="Server"
          hint="Select a session above, or enter its existing SSH / local endpoint."
        >
          <FormTextInput
            accessibilityLabel="Discord agent server"
            initialValue={host}
            resetKey={formRevision}
            onChangeText={setHost}
            editable={editing}
            placeholder="ssh://server?daemonPort=6787"
            autoCapitalize="none"
          />
        </Field>
        <Field
          label="Logical session ID (optional)"
          hint="A Familiar Hub session follows Switch tool & continue across servers. Leave empty to bind one native agent."
        >
          <FormTextInput
            accessibilityLabel="Discord logical session ID"
            initialValue={sessionId}
            resetKey={formRevision}
            onChangeText={setSessionId}
            editable={editing}
            autoCapitalize="none"
          />
        </Field>
        <Field label="Native agent ID">
          <FormTextInput
            accessibilityLabel="Discord native agent ID"
            initialValue={agentId}
            resetKey={formRevision}
            onChangeText={setAgentId}
            editable={editing}
            autoCapitalize="none"
          />
        </Field>
        <Field label="Discord channel ID">
          <FormTextInput
            accessibilityLabel="Discord channel ID"
            initialValue={channelId}
            resetKey={formRevision}
            onChangeText={setChannelId}
            editable={editing}
            keyboardType="numeric"
          />
        </Field>
        <Field label="Allowed Discord user IDs" hint="Separate multiple IDs with commas.">
          <FormTextInput
            accessibilityLabel="Allowed Discord user IDs"
            initialValue={users}
            resetKey={formRevision}
            onChangeText={setUsers}
            editable={editing}
          />
        </Field>
        <Button
          variant="outline"
          disabled={
            !editing ||
            !host ||
            (!agentId && !sessionId.trim()) ||
            !/^\d+$/u.test(channelId) ||
            !/^\d+(\s*,\s*\d+)*$/u.test(users)
          }
          onPress={addBinding}
        >
          Add channel binding
        </Button>
        <View style={ACTIONS_STYLE}>
          <Button disabled={!editing} onPress={saveSettings}>
            Save Discord settings
          </Button>
          <Button disabled={!canConnect(status, busy, bindings, token)} onPress={connect}>
            Connect Discord
          </Button>
          <Button
            variant="outline"
            disabled={busy || status?.state === "stopped"}
            onPress={disconnect}
          >
            Disconnect
          </Button>
          <Button variant="ghost" disabled={busy} onPress={refreshStatus}>
            Refresh status
          </Button>
        </View>
        <Text style={settingsStyles.rowHint}>
          In a bound channel: send a message, attach a file, or use !fa status, !fa context, !fa
          file path, !fa allow request-id, !fa deny request-id, !fa stop. Shared attachments support
          up to 4 MiB each.
        </Text>
        {error || status?.error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowHint}>
            {error || status?.error}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
