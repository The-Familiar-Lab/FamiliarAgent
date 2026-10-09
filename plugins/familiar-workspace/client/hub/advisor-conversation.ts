import type { PaseoAgent, PaseoAgentHandle } from "@getpaseo/client";
import { operationId } from "../fleet.js";

export interface AdvisorIdentity {
  serverId: string;
  agentId: string;
}
export interface AdvisorMessage {
  id: string;
  role: string;
  text: string;
}
export interface AdvisorSnapshot {
  messages: AdvisorMessage[];
  agent: PaseoAgent | null;
  truncated: boolean;
  error: string;
}
export interface AdvisorDelivery {
  state: "accepted" | "rejected" | "unknown";
  messageId: string;
  text: string;
  error?: string;
}
const TIMELINE_ITEMS = 24;
const TIMELINE_CHARACTERS = 16000;
const STREAM_REFRESH_MS = 400;
export async function sendAdvisorQuestion(
  agent: Pick<PaseoAgentHandle, "send">,
  text: string,
): Promise<AdvisorDelivery> {
  text = text.trim();
  if (!text || text.length > 4096) throw new Error("Enter a question of up to 4,096 characters.");
  const messageId = operationId();
  try {
    await agent.send(text, { messageId, activeTurnBehavior: "reject" });
    return { state: "accepted", messageId, text };
  } catch (error) {
    const rejected =
      !!error &&
      typeof error === "object" &&
      "deliveryState" in error &&
      error.deliveryState === "rejected";
    return {
      state: rejected ? "rejected" : "unknown",
      messageId,
      text,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Native events schedule bounded reads; no idle polling or separate agent loop. */
export function observeAdvisor(
  agent: PaseoAgentHandle,
  update: (value: AdvisorSnapshot) => void,
): () => void {
  let active = true;
  let connected = true;
  let pending = false;
  let reading = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: AdvisorSnapshot = {
    messages: [],
    agent: agent.current(),
    truncated: false,
    error: "",
  };
  const emit = (next: Partial<AdvisorSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    if (active) update(snapshot);
  };
  const request = () => {
    if (!active || !connected) return;
    pending = true;
    if (!reading && !timer)
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, STREAM_REFRESH_MS);
  };
  const read = async () => {
    if (!active || !connected || reading) return;
    pending = false;
    reading = true;
    const version = generation;
    try {
      const page = await agent.timeline.refetch({
        direction: "tail",
        projection: "canonical",
        limit: TIMELINE_ITEMS,
      });
      if (!active || version !== generation) return;
      if (page.error || page.gap || page.staleCursor)
        throw new Error(page.error || "Conversation changed. Reopen the advisor to refresh it.");
      const display = displayMessages(page);
      const current = page.agent ?? (await agent.refresh())?.agent ?? null;
      if (active && version === generation) emit({ ...display, agent: current, error: "" });
    } catch (error) {
      if (active && version === generation)
        emit({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      reading = false;
      if (pending) request();
    }
  };
  const subscription = agent.timeline.subscribe(({ event }) => {
    if (!active) return;
    if (event.type === "error") {
      connected = false;
      generation++;
      pending = false;
      if (timer) clearTimeout(timer);
      emit({ error: event.error });
      return;
    }
    if (event.type === "replacement" || event.type === "subscription_restored") {
      generation++;
      emit({ messages: [], agent: null });
    }
    request();
  });
  void subscription.ready.then(read).catch((error: unknown) => {
    if (active) emit({ error: error instanceof Error ? error.message : String(error) });
  });
  return () => {
    active = false;
    generation++;
    if (timer) clearTimeout(timer);
    subscription();
  };
}

function displayMessages(page: Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>) {
  const messages: AdvisorMessage[] = [];
  let remaining = TIMELINE_CHARACTERS;
  for (const { item, seqEnd } of page.entries.toReversed()) {
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    if (!remaining) break;
    const text = item.text.slice(0, remaining);
    remaining -= text.length;
    messages.unshift({
      id: `${page.epoch}:${seqEnd}`,
      role: item.type === "user_message" ? "You" : "Ask Familiar",
      text,
    });
  }
  return { messages, truncated: page.hasOlder || remaining === 0 };
}
