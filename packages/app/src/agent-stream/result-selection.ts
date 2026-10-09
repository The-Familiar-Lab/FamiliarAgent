import {
  RESULT_JOIN,
  RESULT_SEGMENT_LIMIT,
  RESULT_TEXT_BYTE_LIMIT,
  selectedResult,
  type SelectedResult,
} from "@getpaseo/protocol/result-input";
import type { AssistantMessageItem } from "@/types/stream";

export async function selectAssistantResult(
  items: readonly AssistantMessageItem[],
  digest: (text: string) => Promise<string>,
): Promise<SelectedResult> {
  if (!items.length || items.length > RESULT_SEGMENT_LIMIT)
    throw new Error("Select a response with fewer message segments, or use Copy instead.");
  const text = items.map((item) => item.text).join(RESULT_JOIN);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text).length;
  if (!bytes || bytes > RESULT_TEXT_BYTE_LIMIT)
    throw new Error("This response is empty or too large to link. Use Copy for manual transfer.");
  const epoch = items[0].timelineCursor?.epoch;
  let previous = -1;
  const segments = [];
  for (const item of items) {
    const cursor = item.timelineCursor;
    if (!cursor || cursor.epoch !== epoch || cursor.seq <= previous)
      throw new Error(
        "This response has no stable source position. Refresh its conversation and try again.",
      );
    previous = cursor.seq;
    segments.push({
      cursor,
      ...(item.messageId ? { messageId: item.messageId } : {}),
      sha256: await digest(item.text),
      bytes: encoder.encode(item.text).length,
    });
  }
  return selectedResult.parse({ segments, sha256: await digest(text), bytes });
}

/** Route history contains source coordinates and hashes, never conversation text. */
export function resultScreenParams(agentId: string, selection: SelectedResult) {
  return { resultAgentId: agentId, resultSelection: JSON.stringify(selection) };
}
