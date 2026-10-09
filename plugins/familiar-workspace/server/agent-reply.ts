const REPLY_CHARACTER_LIMIT = 64 * 1024;
interface ReplyEntry {
  item: { type: string; text?: string; messageId?: string; clientMessageId?: string };
}
/** Never attribute a previous or intervening user's response to this Discord delivery. */
export function selectAgentReply(entries: ReplyEntry[], messageId: string) {
  const matching = entries.flatMap(({ item }, index) =>
    item.type === "user_message" &&
    (item.clientMessageId === messageId || item.messageId === messageId)
      ? [index]
      : [],
  );
  if (matching.length !== 1) return null;
  const texts: string[] = [];
  let remaining = REPLY_CHARACTER_LIMIT;
  let truncated = false;
  for (const { item } of entries.slice(matching[0]! + 1)) {
    if (item.type === "user_message") break;
    if (item.type !== "assistant_message" || !item.text?.trim()) continue;
    const separator = texts.length ? "\n\n" : "";
    const text = separator + item.text;
    texts.push(text.slice(0, remaining));
    truncated ||= text.length > remaining;
    remaining = Math.max(0, remaining - text.length);
  }
  return texts.length ? { text: texts.join(""), truncated } : null;
}

interface ReceiptReader {
  messageReceipt(
    messageId: string,
    options: { text: string; activeTurnBehavior: "steer" },
  ): Promise<{ state: string }>;
}
interface ReplyPage {
  entries: ReplyEntry[];
  hasOlder: boolean;
  hasNewer: boolean;
  error?: string | null;
  gap?: unknown;
  staleCursor?: unknown;
}
/** Provider reloads can lose client IDs. A complete bounded window and one verified durable
 * receipt are required; matching prompt text alone never establishes delivery identity. */
export async function resolveAgentReply(agent: ReceiptReader, page: ReplyPage, messageId: string) {
  if (page.error || page.gap || page.staleCursor) return null;
  if (
    page.entries.some(
      ({ item }) =>
        item.type === "user_message" &&
        (item.clientMessageId === messageId || item.messageId === messageId),
    )
  )
    return selectAgentReply(page.entries, messageId);
  if (page.hasOlder || page.hasNewer) return null;
  let matched = -1;
  for (const [index, { item }] of page.entries.entries()) {
    if (item.type !== "user_message" || typeof item.text !== "string") continue;
    let receipt: { state: string };
    try {
      receipt = await agent.messageReceipt(messageId, {
        text: item.text,
        activeTurnBehavior: "steer",
      });
    } catch (error) {
      if (error instanceof Error && error.message === "agent_request_key_conflict") continue;
      throw error;
    }
    if (receipt.state !== "completed") continue;
    if (matched !== -1) return null;
    matched = index;
  }
  if (matched === -1) return null;
  const entries = [...page.entries];
  entries[matched] = { item: { ...entries[matched]!.item, clientMessageId: messageId } };
  return selectAgentReply(entries, messageId);
}
