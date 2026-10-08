// Cursor/Antigravity transcript field mappings adapted from Orca (MIT) and
// txcript (Apache-2.0); see NOTICE-FamiliarAgent.md for sources and versions.
import type { HistoryMessage } from "../../shared/history.js";
export type Json = Record<string, unknown>;
export const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
export const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const string = (value: unknown): string => (typeof value === "string" ? value : "");
export function timestamp(value: unknown): string {
  const normalized = typeof value === "number" && value < 1e11 ? value * 1000 : value;
  if (typeof normalized !== "number" && typeof normalized !== "string") return "";
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n\n");
  const item = object(value);
  return (
    string(item.text) ||
    string(item.value) ||
    (item.type === "tool_result" ? contentText(item.content) : "")
  );
}
function message(role: HistoryMessage["role"], text: string, at?: unknown): HistoryMessage[] {
  return text.trim()
    ? [{ role, text, ...(timestamp(at) ? { timestamp: timestamp(at) } : {}) }]
    : [];
}
export function parseCursor(composer: Json, bubbles: Map<string, Json>): HistoryMessage[] {
  const headers = array(composer.fullConversationHeadersOnly);
  let rows: unknown[] = [...bubbles.values()];
  if (array(composer.conversation).length) rows = array(composer.conversation);
  if (headers.length)
    rows = headers.map((header) => bubbles.get(string(object(header).bubbleId))).filter(Boolean);
  return rows.flatMap((raw) => {
    const row = object(raw);
    let role: "user" | "assistant" | null = null;
    if (row.type === 1) role = "user";
    if (row.type === 2) role = "assistant";
    if (!role) return [];
    const result = message(role, string(row.text), row.createdAt);
    const tool = object(row.toolFormerData);
    if (string(tool.name))
      result.push(
        ...message(
          "tool",
          `${string(tool.name)}\n${string(tool.params)}\n${contentText(tool.result)}`,
          row.createdAt,
        ),
      );
    return result;
  });
}
export function parseVSCode(session: Json): HistoryMessage[] {
  return array(session.requests).flatMap((raw) => {
    const request = object(raw);
    const result = message("user", contentText(request.message), request.timestamp);
    for (const rawPart of array(request.response)) {
      const part = object(rawPart);
      if (part.kind === "markdownContent")
        result.push(...message("assistant", contentText(part.content), request.timestamp));
      else if (part.kind === "toolInvocation" || part.kind === "toolInvocationSerialized") {
        result.push(
          ...message(
            "tool",
            [
              contentText(part.invocationMessage),
              contentText(part.pastTenseMessage),
              contentText(part.resultDetails),
            ]
              .filter(Boolean)
              .join("\n"),
            request.timestamp,
          ),
        );
      }
    }
    return result;
  });
}
export function parseJsonLines(text: string): Json[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return object(JSON.parse(line));
      } catch {
        throw new Error(`Invalid transcript JSON at line ${index + 1}`);
      }
    });
}
function parseAntigravityRecord(record: Json, primary: HistoryMessage[]) {
  const text = string(record.content);
  if (
    ["USER_EXPLICIT", "USER"].includes(string(record.source)) &&
    ["USER_INPUT", "REQUEST"].includes(string(record.type))
  ) {
    const match = text.match(/<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/);
    primary.push(...message("user", match?.[1] ?? text, record.created_at));
  } else if (record.source === "MODEL" && record.type === "PLANNER_RESPONSE")
    primary.push(...message("assistant", text, record.created_at));
}
function parseCodexRecord(record: Json, primary: HistoryMessage[], fallback: HistoryMessage[]) {
  const payload = object(record.payload);
  if (
    record.type === "response_item" &&
    payload.type === "message" &&
    ["user", "assistant"].includes(string(payload.role))
  )
    primary.push(
      ...message(
        payload.role as "user" | "assistant",
        contentText(payload.content),
        record.timestamp,
      ),
    );
  else if (record.type === "response_item" && payload.type === "function_call_output")
    primary.push(...message("tool", contentText(payload.output), record.timestamp));
  else if (
    record.type === "event_msg" &&
    ["user_message", "agent_message"].includes(string(payload.type))
  )
    fallback.push(
      ...message(
        payload.type === "user_message" ? "user" : "assistant",
        string(payload.message),
        record.timestamp,
      ),
    );
}
export function parseTranscript(
  records: Json[],
  source: "Cursor" | "Antigravity" | "Codex" | "Claude",
): HistoryMessage[] {
  const primary: HistoryMessage[] = [];
  const fallback: HistoryMessage[] = [];
  for (const record of records) {
    if (source === "Antigravity") parseAntigravityRecord(record, primary);
    else if (source === "Codex") parseCodexRecord(record, primary, fallback);
    else {
      const body = object(record.message);
      const role = string(record.role) || string(body.role) || string(record.type);
      if (role === "user" || role === "assistant")
        primary.push(
          ...message(role, contentText(body.content ?? record.content), record.timestamp),
        );
    }
  }
  return primary.length ? primary : fallback;
}
export function parseChatGPT(raw: Json): { messages: HistoryMessage[]; notes: string[] } {
  const mapping = object(raw.mapping);
  const current = string(raw.current_node);
  const nodes: Json[] = [];
  const seen = new Set<string>();
  let cursor = current;
  if (!cursor)
    throw new Error(
      "ChatGPT export has no current_node; cannot choose a conversation branch safely",
    );
  while (cursor) {
    if (seen.has(cursor)) throw new Error("ChatGPT export contains a cycle");
    seen.add(cursor);
    const node = object(mapping[cursor]);
    if (!Object.keys(node).length) throw new Error("ChatGPT export has a missing parent node");
    nodes.unshift(node);
    cursor = string(node.parent);
  }
  const messages = nodes.flatMap((node) => {
    const entry = object(node.message);
    if (object(entry.metadata).is_visually_hidden_from_conversation === true) return [];
    const role = string(object(entry.author).role);
    if (!["user", "assistant", "system", "tool"].includes(role)) return [];
    return message(
      role as HistoryMessage["role"],
      contentText(object(entry.content).parts),
      entry.create_time,
    );
  });
  const notes = ["Text transcript; original attachments and media are not copied."];
  if (seen.size < Object.keys(mapping).length)
    notes.push(
      "Showing the selected conversation branch. Other branches remain in the original export.",
    );
  return { messages, notes };
}

export function conversationTitle(messages: HistoryMessage[]): string {
  for (const item of messages) {
    if (item.role !== "user") continue;
    const query = item.text.match(/<user_query>([\s\S]*?)<\/user_query>/i)?.[1] || item.text;
    if (
      /^\s*(?:<(?:recommended_plugins|environment_context|permissions|app-context|skills_instructions)|# AGENTS\.md instructions|<INSTRUCTIONS>)/i.test(
        query,
      )
    )
      continue;
    return query.trim().replace(/\s+/g, " ").slice(0, 160);
  }
  return "";
}
