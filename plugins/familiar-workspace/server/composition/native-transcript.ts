import { opendir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PaseoAgent } from "@getpaseo/client";
import type { HistoryBoundary } from "../../shared/composition.js";
import { readTranscriptPage } from "../history/page.js";
import type { ResourceReader } from "./store.js";

type NativeBoundary = Extract<HistoryBoundary, { kind: "native" }>;
const MAX_SOURCE_DIRECTORIES = 10000;

export class NativeTranscriptUnavailableError extends Error {}

/** Locate by provider-native identity, so moving a Codex thread to archived_sessions keeps its reference. */
export async function findTranscript(
  source: "Codex" | "Claude",
  nativeId: string,
  signal?: AbortSignal,
) {
  if (!/^[a-f0-9-]{36}$/iu.test(nativeId))
    throw new Error("Invalid provider-native transcript identity");
  const root =
    source === "Codex"
      ? process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
      : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const pending =
    source === "Codex"
      ? [path.join(root, "sessions"), path.join(root, "archived_sessions")]
      : [path.join(root, "projects")];
  let visited = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    if (++visited > MAX_SOURCE_DIRECTORIES)
      throw new Error("Native transcript search exceeded its directory limit");
    const directory = pending.shift()!;
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for await (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (
        entry.isFile() &&
        (entry.name === `${nativeId}.jsonl` || entry.name.endsWith(`-${nativeId}.jsonl`))
      )
        return file;
      if (entry.isDirectory()) pending.push(file);
    }
  }
  throw new NativeTranscriptUnavailableError(
    "Original native transcript is unavailable; restore its provider history before forking or reading this reference",
  );
}

export async function readNativeTranscript(
  snapshot: PaseoAgent,
  input: Parameters<ResourceReader>[1],
  boundary: NativeBoundary,
): ReturnType<ResourceReader> {
  const source = snapshot.provider === "codex" ? "Codex" : "Claude";
  const nativeId = snapshot.persistence?.sessionId ?? snapshot.runtimeInfo?.sessionId;
  if (!nativeId)
    throw new NativeTranscriptUnavailableError(
      "Native conversation has not created a persistent transcript yet",
    );
  const frozen = boundary.transcript;
  if (frozen && (frozen.source !== source || frozen.nativeId !== nativeId))
    throw new Error("Native conversation identity changed after this fork");
  const file = await findTranscript(source, nativeId);
  // Frozen pages stay recent-first. Capture needs only a bounded sample and the byte/hash frontier.
  const end = frozen ? Math.max(0, frozen.messageCount - input.offset) : input.offset + input.limit;
  const offset = frozen ? Math.max(0, end - input.limit) : input.offset;
  const page = await readTranscriptPage(file, nativeId, source, {
    offset,
    limit: input.limit,
    maxCharacters: input.maxCharacters,
    boundary: frozen?.file,
  });
  if (frozen && page.total !== frozen.messageCount)
    throw new Error(
      "Native transcript parser no longer matches this fork's recorded message boundary",
    );
  const available = Math.min(input.limit, Math.max(0, page.total - input.offset));
  return {
    messages: available ? page.messages.slice(0, available) : [],
    nextOffset: input.offset + available < page.total ? input.offset + available : null,
    truncated: page.truncated,
    boundary: frozen
      ? boundary
      : {
          ...boundary,
          transcript: { source, nativeId, messageCount: page.total, file: page.sourceBoundary },
        },
  };
}
