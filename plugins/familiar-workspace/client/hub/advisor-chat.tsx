import { useEffect, useMemo, useRef, useState } from "react";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import {
  observeAdvisor,
  sendAdvisorQuestion,
  type AdvisorIdentity,
  type AdvisorDelivery,
  type AdvisorSnapshot,
} from "./advisor-conversation.js";
import type { HubUi } from "./ui.js";
import { ROW } from "./ui.js";
export function AdvisorChat({
  identity,
  initialDelivery,
  ui,
  openFull,
  visible,
  initialPending,
}: {
  identity: AdvisorIdentity;
  initialDelivery?: AdvisorDelivery;
  ui: HubUi;
  openFull?: () => void;
  visible: boolean;
  initialPending: boolean;
}) {
  const [snapshot, setSnapshot] = useState<AdvisorSnapshot>({
    messages: [],
    agent: null,
    truncated: false,
    error: "",
  });
  const [question, setQuestion] = useState("");
  const [delivery, setDelivery] = useState(initialDelivery);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const agent = useMemo(
    () => getPaseoClient(identity.serverId).agents.ref(identity.agentId),
    [identity.serverId, identity.agentId],
  );
  useEffect(() => {
    setDelivery(initialDelivery);
  }, [initialDelivery]);
  useEffect(() => {
    if (!visible) return;
    const stop = observeAdvisor(agent, setSnapshot);
    return () => {
      stop();
    };
  }, [agent, visible]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const send = async () => {
    if (busy || delivery?.state === "unknown") return;
    setBusy(true);
    setError("");
    try {
      const result = await sendAdvisorQuestion(agent, question);
      if (alive.current) {
        setDelivery(result);
        if (result.state === "accepted") setQuestion("");
      }
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const checkDelivery = async () => {
    if (!delivery || busy) return;
    setBusy(true);
    setError("");
    try {
      const receipt = await agent.messageReceipt(delivery.messageId, {
        text: delivery.text,
        activeTurnBehavior: "reject",
      });
      if (!alive.current) return;
      if (receipt.state === "completed")
        setDelivery({ ...delivery, state: "accepted", error: undefined });
      else if (receipt.state === "rejected")
        setDelivery({
          ...delivery,
          state: "rejected",
          error: receipt.error ?? "The agent rejected this input.",
        });
      else
        setError(
          "Delivery is still uncertain. Open the full conversation to inspect it. This input will not be resent automatically.",
        );
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const blocked = advisorInputBlocked(snapshot, initialPending || busy, delivery, question);
  return (
    <View style={ui.card}>
      <AdvisorTranscript snapshot={snapshot} ui={ui} />
      {delivery?.state === "unknown" ? (
        <Text accessibilityRole="alert" style={ui.error}>
          Delivery is uncertain. Check delivery or open the full conversation before another input.{" "}
          {delivery.error}
        </Text>
      ) : null}
      {delivery?.state === "rejected" ? (
        <Text accessibilityRole="alert" style={ui.error}>
          Input was rejected: {delivery.error}
        </Text>
      ) : null}
      {ui.field("Ask a follow-up", question, setQuestion, true)}
      <View style={ROW}>
        {ui.button(
          "Send to advisor",
          () => {
            void send();
          },
          blocked,
        )}
        {delivery?.state === "unknown"
          ? ui.button(
              "Check delivery",
              () => {
                void checkDelivery();
              },
              busy,
            )
          : null}
        {openFull ? ui.button("Open full conversation", openFull) : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={ui.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function advisorInputBlocked(
  snapshot: AdvisorSnapshot,
  busy: boolean,
  delivery: AdvisorDelivery | undefined,
  question: string,
) {
  const agent = snapshot.agent;
  if (!agent || agent.archivedAt || snapshot.error || busy || !question.trim()) return true;
  return (
    agent.pendingPermissions.length > 0 ||
    agent.status === "running" ||
    agent.status === "initializing" ||
    delivery?.state === "unknown"
  );
}
function AdvisorTranscript({ snapshot, ui }: { snapshot: AdvisorSnapshot; ui: HubUi }) {
  return (
    <>
      <Text style={ui.muted}>
        {snapshot.agent
          ? `Advisor · ${snapshot.agent.provider} · ${snapshot.agent.model ?? "Default model"} · ${snapshot.agent.status}`
          : "Connecting to the original agent…"}
      </Text>
      {snapshot.messages.map((message) => (
        <View key={message.id} style={ui.card}>
          <Text style={ui.muted}>{message.role}</Text>
          <Text selectable style={ui.text}>
            {message.text}
          </Text>
        </View>
      ))}
      {snapshot.truncated ? (
        <Text style={ui.muted}>
          Recent messages only. Open the full conversation for earlier messages and tool details.
        </Text>
      ) : null}
      {snapshot.agent?.pendingPermissions.length ? (
        <Text accessibilityRole="alert" style={ui.text}>
          The original agent needs approval or an answer. Open the full conversation to review its
          request.
        </Text>
      ) : null}
      {snapshot.agent?.lastError ? <Text style={ui.error}>{snapshot.agent.lastError}</Text> : null}
      {snapshot.error ? (
        <Text accessibilityRole="alert" style={ui.error}>
          {snapshot.error}
        </Text>
      ) : null}
    </>
  );
}
