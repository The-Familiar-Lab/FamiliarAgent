import { createHash } from "node:crypto";
import type { PaseoAgentHandle } from "@getpaseo/client";
import type { HistoryBoundary } from "../../shared/composition.js";
import type { ResourceReader } from "./store.js";

const NATIVE_SCAN_PAGE_SIZE = 32;
type NativeBoundary = Extract<HistoryBoundary, { kind: "native" }>;
type Page = Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>;

async function* visiblePrefix(agent: PaseoAgentHandle, head: Page, maximumMessages: number) {
  let cursor = 0;
  let count = 0;
  const frontier = head.endCursor?.seq ?? 0;
  while (cursor < frontier && count < maximumMessages) {
    const page = await agent.timeline.refetch({
      direction: "after",
      cursor: { epoch: head.epoch, seq: cursor },
      limit: NATIVE_SCAN_PAGE_SIZE,
      projection: "canonical",
    });
    if (page.error) throw new Error(page.error);
    if (page.epoch !== head.epoch || page.staleCursor || page.gap)
      throw new Error(
        "Native history changed during its bounded prefix scan; retry after the source settles",
      );
    for (const entry of page.entries) {
      if (entry.seqEnd > frontier || count >= maximumMessages) break;
      const item = entry.item;
      if (item.type !== "user_message" && item.type !== "assistant_message") continue;
      count++;
      yield { role: item.type === "user_message" ? "user" : "assistant", text: item.text };
    }
    const next = page.endCursor?.seq ?? cursor;
    if (next <= cursor) throw new Error("Native history prefix is no longer retained");
    cursor = next;
    if (!page.hasNewer) break;
  }
}

/** Epochs are projection lifetimes, not durable identities. Verify only the frozen visible prefix. */
export async function readNativePrefix(
  agent: PaseoAgentHandle,
  head: Page,
  input: Parameters<ResourceReader>[1],
  boundary?: NativeBoundary,
): ReturnType<ResourceReader> {
  const expected = boundary?.prefix;
  const maximumMessages = expected?.messageCount ?? Number.POSITIVE_INFINITY;
  // Native pages remain recent-first; the offset counts visible messages from the frozen end.
  const end = expected
    ? Math.max(0, expected.messageCount - input.offset)
    : input.offset + input.limit;
  const start = expected ? Math.max(0, end - input.limit) : input.offset;
  const hash = createHash("sha256");
  const messages: Awaited<ReturnType<ResourceReader>>["messages"] = [];
  let count = 0;
  let remaining = input.maxCharacters;
  let truncated = false;
  for await (const message of visiblePrefix(agent, head, maximumMessages)) {
    hash
      .update(message.role)
      .update("\0")
      .update(String(Buffer.byteLength(message.text)))
      .update("\0")
      .update(message.text);
    if (count >= start && count < end) {
      const text = message.text.slice(0, remaining);
      messages.push({ role: message.role, text });
      remaining -= text.length;
      truncated ||= text.length < message.text.length;
    }
    count++;
  }
  const sha256 = hash.digest("hex");
  if (expected && (count !== expected.messageCount || sha256 !== expected.sha256))
    throw new Error(
      "Native conversation was rewritten or truncated after this fork; its frozen prefix is unavailable",
    );
  return {
    messages,
    nextOffset: input.offset + messages.length < count ? input.offset + messages.length : null,
    truncated,
    boundary: boundary ?? {
      kind: "native",
      epoch: head.epoch,
      seq: head.endCursor?.seq ?? 0,
      prefix: { messageCount: count, sha256 },
    },
  };
}
