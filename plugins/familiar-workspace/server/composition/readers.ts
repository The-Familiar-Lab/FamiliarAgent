import type { PaseoApi, PaseoAgent, PaseoAgentHandle } from "@getpaseo/client";
import { createHash } from "node:crypto";
import {
  readCompositionSource,
  type CompositionResource,
  type HistoryBoundary,
} from "../../shared/composition.js";
import type { HistoryStore } from "../history/store.js";
import { forwardWorkspace } from "../authority.js";
import type { ResourceReader } from "./store.js";
import { readNativePrefix } from "./native-prefix.js";
import { NativeTranscriptUnavailableError, readNativeTranscript } from "./native-transcript.js";

const EMPTY_PREFIX_SHA256 = createHash("sha256").digest("hex");

function hasFrozenEmptyPrefix(boundary: Extract<HistoryBoundary, { kind: "native" }> | undefined) {
  if (boundary?.transcript || boundary?.prefix?.messageCount !== 0) return false;
  if (boundary.prefix.sha256 !== EMPTY_PREFIX_SHA256)
    throw new Error("Frozen empty native history has an invalid prefix hash");
  return true;
}

/** Live native pages use sequence offsets; frozen pages use stable message offsets. */
export function localResourceReader(options: {
  serverId: string;
  history: Pick<HistoryStore, "readPage">;
  paseo: PaseoApi;
}): ResourceReader {
  return async (resource, input) => {
    if (resource.serverId !== options.serverId)
      throw new Error(
        `Source belongs to server ${resource.serverId}; select its connected host or configure an SSH connection for this reference`,
      );
    if (resource.kind !== "history")
      throw new Error(
        "This reference is opened with its native file, skill, MCP or tool surface; it is not a conversation history",
      );
    if (resource.format === "imported-history")
      return readImported(options.history, resource, input);
    if (resource.format === "native-timeline") return readNative(options.paseo, resource, input);
    throw new Error("History reference must declare native-timeline or imported-history format");
  };
}

async function readImported(
  history: Pick<HistoryStore, "readPage">,
  resource: CompositionResource,
  input: Parameters<ResourceReader>[1],
): ReturnType<ResourceReader> {
  if (resource.boundary && resource.boundary.kind !== "imported")
    throw new Error("History boundary does not match the source format");
  const record = await history.readPage(
    resource.locator,
    input.offset,
    input.limit,
    input.maxCharacters,
    resource.boundary?.file,
  );
  if (
    resource.boundary &&
    !resource.boundary.file &&
    resource.boundary.updatedAt !== record.updatedAt
  )
    throw new Error(
      "Imported source changed after this fork. Refresh or explicitly attach its newer revision.",
    );
  const count = Math.min(record.total, resource.boundary?.messageCount ?? record.total);
  const messages = record.messages.slice(0, Math.max(0, count - input.offset));
  return {
    messages,
    nextOffset: input.offset + messages.length < count ? input.offset + messages.length : null,
    truncated: record.truncated,
    boundary: {
      kind: "imported",
      messageCount: count,
      updatedAt: resource.boundary?.updatedAt ?? record.updatedAt,
      file: record.sourceBoundary,
    },
  };
}

async function requireStableSource(agent: PaseoAgentHandle) {
  const snapshot = await agent.refresh();
  if (!snapshot || snapshot.agent.status === "running" || snapshot.agent.status === "initializing")
    throw new Error(
      "Wait for this native agent to finish its current turn before forking its history",
    );
  return snapshot.agent;
}

async function capturePersistentNative(
  agent: PaseoAgentHandle,
  source: PaseoAgent,
  head: Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>,
  input: Parameters<ResourceReader>[1],
): ReturnType<ResourceReader> {
  try {
    return await readNativeTranscript(source, input, {
      kind: "native",
      epoch: head.epoch,
      seq: head.endCursor?.seq ?? 0,
    });
  } catch (error) {
    // Providers may defer the original transcript until the first user turn.
    const knownEmpty =
      source.provider === "codex"
        ? source.persistence?.metadata?.emptyThread === true
        : source.persistence === null && source.runtimeInfo?.sessionId === null;
    const empty =
      knownEmpty &&
      source.lastUserMessageAt === null &&
      !head.endCursor &&
      !head.entries.length &&
      !head.hasOlder &&
      !head.gap &&
      !head.staleCursor;
    if (!(error instanceof NativeTranscriptUnavailableError) || !empty) throw error;
    return readNativePrefix(agent, head, input);
  }
}

async function readNative(
  paseo: PaseoApi,
  resource: CompositionResource,
  input: Parameters<ResourceReader>[1],
): ReturnType<ResourceReader> {
  if (resource.boundary && resource.boundary.kind !== "native")
    throw new Error("History boundary does not match the source format");
  if (hasFrozenEmptyPrefix(resource.boundary)) {
    // An already captured empty prefix never includes future turns and needs no native runtime.
    return { messages: [], nextOffset: null, boundary: resource.boundary };
  }
  const agent = paseo.agents.ref(resource.locator);
  if (resource.boundary?.transcript) {
    const snapshot = await agent.refresh();
    if (!snapshot) throw new Error("Native source agent is unavailable");
    return readNativeTranscript(snapshot.agent, input, resource.boundary);
  }
  const capturing = input.captureBoundary && !resource.boundary;
  const source = capturing ? await requireStableSource(agent) : undefined;
  const head = await agent.timeline.refetch({
    direction: "tail",
    limit: input.offset || resource.boundary || input.captureBoundary ? 1 : input.limit,
    projection: "canonical",
  });
  if (head.error) throw new Error(head.error);
  if (source && ["codex", "claude"].includes(source.provider)) {
    const result = await capturePersistentNative(agent, source, head, input);
    await requireStableSource(agent);
    return result;
  }
  if (resource.boundary?.prefix || capturing) {
    const result = await readNativePrefix(agent, head, input, resource.boundary);
    if (capturing) await requireStableSource(agent);
    return result;
  }
  return readLiveNativePage(agent, head, resource, input);
}

async function readLiveNativePage(
  agent: PaseoAgentHandle,
  head: Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>,
  resource: CompositionResource,
  input: Parameters<ResourceReader>[1],
): ReturnType<ResourceReader> {
  if (resource.boundary && resource.boundary.kind !== "native")
    throw new Error("History boundary does not match the source format");
  if (resource.boundary && resource.boundary.epoch !== head.epoch)
    throw new Error(
      "Native history was replaced after this fork; its frozen cursor is unavailable",
    );
  const boundary: HistoryBoundary = resource.boundary ?? {
    kind: "native",
    epoch: head.epoch,
    seq: head.endCursor?.seq ?? 0,
  };
  if (boundary.seq === 0) return { messages: [], nextOffset: null, boundary };
  const before = input.offset || (resource.boundary ? boundary.seq + 1 : 0);
  const page = before
    ? await agent.timeline.refetch({
        direction: "before",
        cursor: { epoch: head.epoch, seq: Math.min(before, boundary.seq + 1) },
        limit: input.limit,
        projection: "canonical",
      })
    : head;
  if (page.error) throw new Error(page.error);
  if (page.staleCursor || page.gap)
    throw new Error(
      "Native history changed or is no longer retained; refresh the source reference",
    );
  const messages = page.entries.flatMap(({ item }) => {
    if (item.type === "user_message" || item.type === "assistant_message")
      return [{ role: item.type === "user_message" ? "user" : "assistant", text: item.text }];
    return [];
  });
  return {
    messages,
    nextOffset: page.hasOlder ? (page.startCursor?.seq ?? null) : null,
    boundary,
  };
}

export function routedResourceReader(options: {
  serverId: string;
  local: ResourceReader;
  cliPath?: string;
  bridge?: (resource: CompositionResource) => Promise<ResourceReader | null>;
}): ResourceReader {
  return async (resource, page) => {
    if (resource.serverId === options.serverId) return options.local(resource, page);
    const bridge = await options.bridge?.(resource);
    if (bridge) return bridge(resource, page);
    if (!resource.connection?.startsWith("ssh://")) {
      throw new Error(
        `Server ${resource.serverId} is not reachable from this daemon. Read it through the desktop's connected host, or add its SSH URI or private return path in FamiliarAgent.`,
      );
    }
    let address: URL;
    try {
      address = new URL(resource.connection);
    } catch {
      throw new Error("History connection must be an SSH URI");
    }
    if (
      address.protocol !== "ssh:" ||
      address.password ||
      address.hash ||
      (address.pathname && address.pathname !== "/")
    )
      throw new Error("History connection must be an SSH URI without passwords or a path");
    const result = readCompositionSource.output.parse(
      await forwardWorkspace(
        resource.connection,
        "composition.source.read",
        { resource, ...page },
        options.cliPath,
      ),
    );
    return {
      messages: result.messages,
      nextOffset: result.nextOffset,
      truncated: result.truncated,
      boundary: result.resource.boundary,
    };
  };
}

export async function boundedSourceRead(
  resource: CompositionResource,
  input: { offset: number; limit: number; maxCharacters: number; captureBoundary?: boolean },
  reader: ResourceReader,
) {
  const result = await reader(resource, input);
  let remaining = input.maxCharacters;
  let truncated = result.truncated ?? false;
  const messages = result.messages.slice(0, input.limit).flatMap((message) => {
    if (message.text.length > remaining) truncated = true;
    if (!remaining) return [];
    const text = message.text.slice(0, remaining);
    remaining -= text.length;
    return [{ ...message, text }];
  });
  truncated ||= messages.length < result.messages.length;
  return {
    resource: { ...resource, boundary: result.boundary ?? resource.boundary },
    messages,
    offset: input.offset,
    nextOffset: result.nextOffset,
    truncated,
  };
}

export async function captureHistoryBoundaries(
  resources: CompositionResource[],
  reader: ResourceReader,
) {
  const boundaries: Record<string, HistoryBoundary> = {};
  for (let offset = 0; offset < resources.length; offset += 4) {
    await Promise.all(
      resources.slice(offset, offset + 4).map(async (resource) => {
        const boundary =
          resource.boundary ??
          (
            await reader(resource, {
              offset: 0,
              limit: 1,
              maxCharacters: 256,
              captureBoundary: true,
            })
          ).boundary;
        if (!boundary)
          throw new Error(
            `Cannot pin history ${resource.label}; reconnect its owning server or exclude history from the fork`,
          );
        boundaries[resource.id] = boundary;
      }),
    );
  }
  return boundaries;
}
