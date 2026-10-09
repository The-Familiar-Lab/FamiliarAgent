import type { PaseoAgent, PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import type { HistoryBoundary } from "../../shared/composition.js";
import {
  selectedResult,
  resultSourceSelection,
  type SelectedResult,
  type ResultSourceSelection,
} from "../../shared/result-selection.js";
import type { ResultAnchor } from "../../shared/results.js";
import { readTranscriptPage } from "../history/page.js";
import { findTranscript } from "./native-transcript.js";
import { textDigest, verifySelectedText, joinSelectedText } from "./result-text.js";

const RESULT_READ_TIMEOUT_MS = 15_000;
type NativeBoundary = Extract<HistoryBoundary, { kind: "native" }>;
interface Match {
  ordinal: number;
  text: string;
  count: number;
}

/** One original-file scan; retained text is at most one bounded candidate per selected digest. */
async function scanResult(
  snapshot: PaseoAgent,
  expected: SelectedResult | ResultSourceSelection,
  boundary: NativeBoundary,
) {
  if (snapshot.provider !== "codex" && snapshot.provider !== "claude")
    throw new Error(
      "Exact original-result links currently support Codex and Claude; use Copy input for this tool",
    );
  const source = snapshot.provider === "codex" ? "Codex" : "Claude";
  const nativeId = snapshot.persistence?.sessionId ?? snapshot.runtimeInfo?.sessionId;
  if (!nativeId) throw new Error("The selected response has no persistent original conversation");
  const frozen = boundary.transcript;
  if (frozen && (frozen.source !== source || frozen.nativeId !== nativeId))
    throw new Error("Selected source conversation identity changed");
  const signal = AbortSignal.timeout(RESULT_READ_TIMEOUT_MS);
  const file = await findTranscript(source, nativeId, signal);
  const maps = { primary: new Map<string, Match>(), fallback: new Map<string, Match>() };
  const digests = new Map(expected.segments.map((segment) => [segment.sha256, segment]));
  const frozenOrdinals = "ordinal" in expected.segments[0]!;
  if (!frozenOrdinals && digests.size !== expected.segments.length)
    throw new Error(
      "Repeated identical response segments are ambiguous; select a distinct response",
    );
  const ordinals = new Map(
    expected.segments.flatMap((segment) =>
      "ordinal" in segment ? [[segment.ordinal, segment] as const] : [],
    ),
  );
  const page = await readTranscriptPage(file, nativeId, source, {
    offset: 0,
    limit: 1,
    maxCharacters: 1,
    boundary: frozen?.file,
    signal,
    visitMessage: (message, ordinal, projection) => {
      if (message.role !== "assistant" || (frozenOrdinals && !ordinals.has(ordinal))) return;
      const digest = textDigest(message.text);
      const target = frozenOrdinals ? ordinals.get(ordinal) : digests.get(digest.sha256);
      if (!target || target.sha256 !== digest.sha256 || target.bytes !== digest.bytes) return;
      const key = frozenOrdinals ? String(ordinal) : digest.sha256;
      const previous = maps[projection].get(key);
      if (previous) previous.count++;
      else maps[projection].set(key, { ordinal, text: message.text, count: 1 });
    },
  });
  if (page.unreadableRecords)
    throw new Error(
      "Original transcript contains unreadable records; an exact result link cannot be verified",
    );
  if (frozen && page.total !== frozen.messageCount)
    throw new Error("Selected source message boundary changed");
  const matches = expected.segments.map((segment) => {
    const key = "ordinal" in segment ? String(segment.ordinal) : segment.sha256;
    const match = maps[page.projection].get(key);
    if (!match || match.count !== 1)
      throw new Error(
        "Selected response is missing or ambiguous in its original transcript; use Copy input instead",
      );
    return match;
  });
  if (matches.some((match, index) => index > 0 && match.ordinal <= matches[index - 1]!.ordinal))
    throw new Error("Selected response order does not match its original transcript");
  const selection = resultSourceSelection.parse({
    sha256: expected.sha256,
    bytes: expected.bytes,
    segments: matches
      .map((match, index) => ({ ...expected.segments[index], ordinal: match.ordinal }))
      .map(({ ordinal, sha256, bytes }) => ({ ordinal, sha256, bytes })),
  });
  const messages = matches.map((match) => ({ role: "assistant", text: match.text }));
  const text = joinSelectedText(messages, selection);
  return {
    selection,
    messages,
    text,
    boundary: frozen
      ? boundary
      : ({
          ...boundary,
          transcript: { source, nativeId, messageCount: page.total, file: page.sourceBoundary },
        } as NativeBoundary),
  };
}

export async function readResultSource(snapshot: PaseoAgent, anchor: ResultAnchor) {
  if (anchor.resource.boundary?.kind !== "native" || !anchor.resource.boundary.transcript)
    throw new Error("An exact result link requires its original native transcript boundary");
  return scanResult(snapshot, anchor.selection, anchor.resource.boundary);
}

async function verifyNativeSegment(
  agent: PaseoAgentHandle,
  segment: SelectedResult["segments"][number],
) {
  const page = await agent.timeline.refetch({
    direction: "before",
    cursor: { epoch: segment.cursor.epoch, seq: segment.cursor.seq + 1 },
    limit: 2,
    projection: "canonical",
  });
  if (page.error || page.staleCursor || page.gap || page.epoch !== segment.cursor.epoch)
    throw new Error("Selected response cursor is no longer current; select the response again");
  const matches = page.entries.filter(
    (entry) => entry.seqEnd === segment.cursor.seq && entry.item.type === "assistant_message",
  );
  const item = matches[0]?.item;
  if (
    matches.length !== 1 ||
    item?.type !== "assistant_message" ||
    (segment.messageId && item.messageId !== segment.messageId)
  )
    throw new Error("Selected response does not identify one complete native assistant message");
  verifySelectedText(item.text, segment);
  return item.text;
}

async function readCanonicalResult(paseo: PaseoApi, agentId: string, raw: SelectedResult) {
  const selection = selectedResult.parse(raw);
  const agent = paseo.agents.ref(agentId);
  const current = await agent.refresh();
  if (!current || current.agent.status !== "idle")
    throw new Error("Wait for the source agent to finish before linking its response");
  const epochs = new Set(selection.segments.map((segment) => segment.cursor.epoch));
  if (
    epochs.size !== 1 ||
    selection.segments.some(
      (segment, index) =>
        index > 0 && segment.cursor.seq <= selection.segments[index - 1]!.cursor.seq,
    )
  )
    throw new Error(
      "Selected response cursors are stale or out of order; select the response again",
    );
  const messages = [];
  for (const segment of selection.segments)
    messages.push({ role: "assistant", text: await verifyNativeSegment(agent, segment) });
  const text = joinSelectedText(messages, selection);
  return { agent, current, selection, text };
}

async function assertSourceStable(agent: PaseoAgentHandle, current: PaseoAgent) {
  const after = await agent.refresh();
  if (
    !after ||
    after.agent.status !== "idle" ||
    after.agent.persistence?.sessionId !== current.persistence?.sessionId
  )
    throw new Error(
      "Source agent changed while selecting the result; select it again after its turn finishes",
    );
}

export async function previewResult(paseo: PaseoApi, agentId: string, raw: SelectedResult) {
  const { agent, current, text } = await readCanonicalResult(paseo, agentId, raw);
  await assertSourceStable(agent, current.agent);
  return { text };
}

export async function captureResult(
  paseo: PaseoApi,
  serverId: string,
  agentId: string,
  raw: SelectedResult,
) {
  const { agent, current, selection } = await readCanonicalResult(paseo, agentId, raw);
  const end = selection.segments.at(-1)!.cursor;
  const captured = await scanResult(current.agent, selection, {
    kind: "native",
    epoch: end.epoch,
    seq: end.seq,
  });
  await assertSourceStable(agent, current.agent);
  const anchor: ResultAnchor = {
    resource: {
      id: `result-${textDigest(serverId + "\0" + agentId).sha256.slice(0, 24)}`,
      kind: "history",
      label: `${current.agent.provider} selected result`,
      serverId,
      format: "native-timeline",
      locator: agentId,
      readOnly: true,
      boundary: captured.boundary,
    },
    selection: captured.selection,
  };
  return { anchor, text: captured.text };
}
