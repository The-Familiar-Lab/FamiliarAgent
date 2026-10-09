import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { AdvisorChat } from "./advisor-chat.js";
import type { AdvisorIdentity, AdvisorDelivery } from "./advisor-conversation.js";
import type { HubController } from "./controller.js";
import { HubPicker, ROW, type HubUi } from "./ui.js";
import { askFamiliar } from "./advisor.js";
const HIDDEN = { display: "none" } as const;
export function AdvisorDialog({
  hub,
  ui,
  close,
  visible,
  origin,
}: {
  hub: HubController;
  ui: HubUi;
  close: () => void;
  visible: boolean;
  origin?: AdvisorIdentity;
}) {
  const [serverId, setServer] = useState(hub.target);
  const [provider, setProvider] = useState("");
  const [question, setQuestion] = useState(
    "Which tools and skills would help with this conversation, and how should I use them in FamiliarAgent?",
  );
  const [identity, setIdentity] = useState<AdvisorIdentity | null>(null);
  const [delivery, setDelivery] = useState<AdvisorDelivery>();
  const [sourceTitle, setSourceTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const servers = useMemo(
    () =>
      hub.hosts.map((host) => ({
        id: host.serverId,
        label: host.label,
        disabled: host.status !== "online",
      })),
    [hub.hosts],
  );
  const providers = useMemo(
    () =>
      hub.tools
        .filter(
          (item) => item.serverId === serverId && item.tool.installed && item.tool.nativeProvider,
        )
        .map((item) => ({ id: item.tool.nativeProvider!, label: item.tool.name })),
    [hub.tools, serverId],
  );
  const selected = providers.some((item) => item.id === provider)
    ? provider
    : (providers[0]?.id ?? "");
  const setHost = useCallback((id: string) => {
    setServer(id);
    setProvider("");
  }, []);
  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let title = hub.session?.title || "Current context";
      if (hub.entryChoice?.kind === "native")
        title = hub.entryChoice.agent.title || "Current conversation";
      if (origin) title = `Current conversation on ${hub.hostName(origin.serverId)}`;
      setSourceTitle(title);
      const result = await askFamiliar(
        hub,
        { serverId, provider: selected, question, origin },
        (created) => {
          if (alive.current) setIdentity(created);
        },
      );
      if (alive.current) setDelivery(result.delivery);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const openFull = useCallback(() => {
    if (identity) hub.navigation?.openAgent(identity);
  }, [hub.navigation, identity]);
  return (
    <View style={visible ? ui.card : HIDDEN}>
      <Text style={ui.heading}>Ask Familiar</Text>
      {identity ? (
        <>
          <Text style={ui.muted}>
            Source: {sourceTitle} · Advisor on {hub.hostName(identity.serverId)}. The source remains
            unchanged when you browse elsewhere.
          </Text>
          <AdvisorChat
            key={`${identity.serverId}:${identity.agentId}`}
            identity={identity}
            initialDelivery={delivery}
            ui={ui}
            openFull={hub.navigation ? openFull : undefined}
            visible={visible}
            initialPending={busy}
          />
          {ui.button("Hide advisor", close)}
        </>
      ) : (
        <>
          <Text style={ui.text}>
            A separate advisor reads a bounded preview of this conversation, shared context, and
            your tool catalog. Your selected session and tool stay unchanged.
          </Text>
          <HubPicker
            label="Advisor server"
            value={serverId}
            options={servers}
            onChange={setHost}
            ui={ui}
          />
          {providers.length ? (
            <HubPicker
              label="Advisor agent"
              value={selected}
              options={providers}
              onChange={setProvider}
              ui={ui}
            />
          ) : (
            <Text style={ui.muted}>
              Connect Codex or Claude Code on this server to start an advisor.
            </Text>
          )}
          {ui.field("What would you like help with?", question, setQuestion, true)}
          <Text style={ui.muted}>
            Uses the chosen agent’s available default model and original approval flow. Installation
            in the catalog does not prove the account is signed in.
          </Text>
          <View style={ROW}>
            {ui.button(
              "Ask Familiar here",
              () => {
                void send();
              },
              busy || !selected || !question.trim(),
            )}
            {ui.button(
              "Connect Codex",
              () => {
                close();
                hub.openSetup(serverId, "codex");
              },
              busy,
            )}
            {ui.button(
              "Connect Claude Code",
              () => {
                close();
                hub.openSetup(serverId, "claude");
              },
              busy,
            )}
            {ui.button("Hide advisor", close)}
          </View>
        </>
      )}
      {busy ? (
        <Text style={ui.muted}>Preparing the separate advisor with selected context…</Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={ui.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
