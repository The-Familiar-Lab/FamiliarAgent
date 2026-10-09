import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { readCompositionContext, type CompositionResource } from "../../shared/composition.js";
import { readSkill } from "../../shared/tool-catalog.js";
import { hostRpc, operationId } from "../fleet.js";
import type { HubController } from "./controller.js";
import type { HubUi } from "./ui.js";
import { ContextHelp, ContextToggle } from "./context-help.js";
import { selectSessionSkill, type SkillSelection } from "./session-resources.js";

interface SkillRow extends SkillSelection {
  label: string;
  path?: string;
  checked: boolean;
  available: boolean;
}
export function SessionSkills({ hub, ui }: { hub: HubController; ui: HubUi }) {
  const [effective, setEffective] = useState<CompositionResource[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const session = hub.session;
  const key = session ? `${session.id}:${session.revision}` : "";
  const currentSession = useRef(session);
  currentSession.current = session;
  useEffect(() => {
    let current = true;
    setEffective([]);
    setError("");
    setTruncated(false);
    const source = currentSession.current;
    if (!source) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void hostRpc(hub.host.id, readCompositionContext, {
      id: source.id,
      revision: source.revision,
      maxResources: 200,
      maxCharacters: 65536,
    })
      .then((value) => {
        if (current) {
          setEffective(value.resources);
          setTruncated(value.truncated);
        }
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
  }, [hub.host.id, key]);
  const hostName = hub.hostName;
  const rows = useMemo(() => {
    const items = new Map<string, SkillRow>();
    for (const host of hub.resourceCatalog) {
      for (const skill of host.value?.skills ?? []) {
        items.set(JSON.stringify([host.serverId, skill.id]), {
          serverId: host.serverId,
          connection: hub.hosts.find((entry) => entry.serverId === host.serverId)?.connection,
          skillId: skill.id,
          label: host.label,
          path: skill.path,
          available: !host.error,
          checked: false,
        });
      }
    }
    for (const resource of effective.filter((item) => item.kind === "skill")) {
      const identity = JSON.stringify([resource.serverId, resource.locator]);
      const existing = items.get(identity);
      items.set(
        identity,
        existing
          ? { ...existing, checked: true }
          : {
              serverId: resource.serverId,
              connection: resource.connection,
              skillId: resource.locator,
              label: hostName(resource.serverId),
              checked: true,
              available: false,
            },
      );
    }
    return [...items.values()];
  }, [hub.resourceCatalog, hub.hosts, effective, hostName]);
  const toggle = useCallback(
    async (row: SkillRow) => {
      if (!session) throw new Error("Select a session first.");
      const changes = selectSessionSkill(session, effective, row, !row.checked, operationId());
      await hub.saveSessionPreferences({ ...changes, memoryEnabled: session.memoryEnabled });
      hub.setNotice(
        row.checked
          ? "Stopped using this skill for future shared-context reads. Already-read model context is unchanged."
          : "Skill selected for this session. The next shared-context read can load its original instructions.",
      );
    },
    [session, effective, hub],
  );
  const toggleMemory = useCallback(() => {
    if (!session) return;
    void hub.run(async () => {
      await hub.saveSessionPreferences({
        resources: session.resources,
        disabledResourceIds: session.disabledResourceIds,
        memoryEnabled: session.memoryEnabled === false,
      });
      hub.setNotice(
        "Shared memory preference saved for this session. Existing model context is unchanged.",
      );
    });
  }, [hub, session]);
  if (!session)
    return (
      <View style={ui.card}>
        <Text style={ui.text}>Select a session to choose its memory and skills.</Text>
        <Text style={ui.muted}>
          Use the conversation preview and Select session. Browsing this list does not change a
          native conversation.
        </Text>
      </View>
    );
  return (
    <View style={ui.card}>
      <Text style={ui.sectionHeading}>Use in this session · {session.title}</Text>
      <ContextToggle
        label="Shared project and session memory"
        checked={session.memoryEnabled !== false}
        disabled={hub.busy || loading}
        onPress={toggleMemory}
        ui={ui}
      />
      <ContextHelp label="What these checks change" ui={ui}>
        <Text style={ui.text}>
          Memory includes the saved project/session decisions and shared parent notes. Checked
          skills expose their original SKILL.md through Familiar context on the owning server. Files
          and credentials are not copied.
        </Text>
        <Text style={ui.text}>
          Changes apply when this session next reads Familiar context or continues with another
          tool. A running model may keep instructions it already read. Unchecking stops future
          shared reads; it cannot erase the current model’s context or remove an original tool’s
          independently configured skills.
        </Text>
        <Text style={ui.text}>
          These checks affect this logical session only. Global library defaults and native project
          folder links are managed separately in Advanced.
        </Text>
      </ContextHelp>
      {loading ? <Text style={ui.muted}>Loading selected context…</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" style={ui.error}>
          {error}
        </Text>
      ) : null}
      {truncated ? (
        <Text style={ui.muted}>
          The shared context is large; this bounded view may omit additional inherited references.
        </Text>
      ) : null}
      {rows.map((row) => (
        <SessionSkillRow
          key={JSON.stringify([row.serverId, row.skillId])}
          row={row}
          ui={ui}
          hub={hub}
          disabled={loading || !!error}
          toggle={toggle}
        />
      ))}
      {!rows.length && !loading ? (
        <Text style={ui.muted}>
          No registered skills yet. Set up a skill package or add a library folder in Advanced.
        </Text>
      ) : null}
      {hub.resourceCatalog
        .filter((item) => item.error)
        .map((item) => (
          <Text key={item.serverId} style={ui.error}>
            {item.label}: {item.error}. Its selected references remain owned by that server.
          </Text>
        ))}
    </View>
  );
}
function SessionSkillRow({
  row,
  hub,
  ui,
  disabled,
  toggle,
}: {
  row: SkillRow;
  hub: HubController;
  ui: HubUi;
  disabled: boolean;
  toggle: (row: SkillRow) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const click = useCallback(() => {
    void hub.run(() => toggle(row));
  }, [hub, row, toggle]);
  const preview = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const value = await hostRpc(row.serverId, readSkill, {
        id: row.skillId,
        maxCharacters: 4096,
      });
      if (alive.current) setText(value.text + (value.truncated ? "\n[Preview truncated]" : ""));
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [row.serverId, row.skillId, loading]);
  return (
    <View style={ui.card}>
      <ContextToggle
        label={`${row.skillId} · ${row.label}`}
        checked={row.checked}
        disabled={disabled || hub.busy || (!row.available && !row.checked)}
        onPress={click}
        ui={ui}
      />
      <Text selectable style={ui.muted}>
        {row.path ?? "Original registry unavailable; you can stop using this reference."}
      </Text>
      <ContextHelp label={`About skill ${row.skillId} on ${row.label}`} ui={ui}>
        <Text style={ui.text}>
          Checked: the current session can read this original skill’s instructions on {row.label}.
          Unchecked: Familiar omits it from this session’s future context reads. A native tool’s
          separate project configuration is unchanged.
        </Text>
        {ui.button(
          loading ? "Reading skill…" : "Preview original instructions",
          () => {
            void preview();
          },
          loading || !row.available,
        )}
        {text ? (
          <Text selectable style={ui.text}>
            {text}
          </Text>
        ) : null}
        {error ? <Text style={ui.error}>{error}</Text> : null}
      </ContextHelp>
    </View>
  );
}
