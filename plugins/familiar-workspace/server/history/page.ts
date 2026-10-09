import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { HistoryMessage, HistorySource } from "../../shared/history.js";
import { object, string, parseTranscript } from "./parsers.js";

export const HISTORY_PAGE_CHARACTERS = 128 * 1024;
export const MAX_TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;
export interface HistoryFileBoundary {
  identity: string;
  bytes: number;
  sha256: string;
}
export interface HistoryPageOptions {
  offset: number;
  limit: number;
  maxCharacters?: number;
  boundary?: HistoryFileBoundary;
  maxLineBytes?: number;
  signal?: AbortSignal;
  visitMessage?: (
    message: HistoryMessage,
    ordinal: number,
    projection: "primary" | "fallback",
  ) => void;
}
export interface TranscriptPage {
  messages: HistoryMessage[];
  total: number;
  truncated: boolean;
  notes: string[];
  updatedAt: string;
  sourceBoundary: HistoryFileBoundary;
  diagnostics: { bytesRead: number; peakBufferedLineBytes: number; recordsRead: number };
  projection: "primary" | "fallback";
  unreadableRecords: number;
}

interface Collector {
  count: number;
  remaining: number;
  truncated: boolean;
  messages: HistoryMessage[];
}
function collect(target: Collector, messages: HistoryMessage[], options: HistoryPageOptions) {
  for (const message of messages) {
    const position = target.count++;
    if (position < options.offset || position >= options.offset + options.limit) continue;
    if (message.text.length > target.remaining) target.truncated = true;
    if (target.remaining <= 0) continue;
    const text = message.text.slice(0, target.remaining);
    target.remaining -= text.length;
    target.messages.push({ ...message, text });
  }
}

/** Iterates byte-bounded lines, including damaged/oversized records, without a whole-file string. */
async function* lines(
  file: FileHandle,
  bytes: number,
  maxLineBytes: number,
  diagnostics: TranscriptPage["diagnostics"],
  digest: ReturnType<typeof createHash>,
  signal?: AbortSignal,
) {
  if (!bytes) return;
  const stream = file.createReadStream({
    start: 0,
    end: bytes - 1,
    highWaterMark: STREAM_CHUNK_BYTES,
    autoClose: false,
    signal,
  });
  let parts: Buffer[] = [];
  let size = 0;
  let oversized = false;
  const add = (part: Buffer) => {
    if (oversized) return;
    size += part.length;
    if (size > maxLineBytes) {
      oversized = true;
      parts = [];
      return;
    }
    diagnostics.peakBufferedLineBytes = Math.max(diagnostics.peakBufferedLineBytes, size);
    parts.push(part);
  };
  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer;
      diagnostics.bytesRead += chunk.length;
      digest.update(chunk);
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        add(chunk.subarray(start, end));
        yield oversized ? null : Buffer.concat(parts, size).toString("utf8");
        parts = [];
        size = 0;
        oversized = false;
        start = end + 1;
      }
      if (start < chunk.length) add(chunk.subarray(start));
    }
    if (size || oversized) yield oversized ? null : Buffer.concat(parts, size).toString("utf8");
  } finally {
    stream.destroy();
  }
}

/** Keeps only the requested primary/fallback pages, so late offsets do not retain earlier messages. */
function pageLimits(options: HistoryPageOptions) {
  if (
    !Number.isSafeInteger(options.offset) ||
    options.offset < 0 ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    throw new Error("History page requires a non-negative offset and a limit from 1 to 100");
  const maxCharacters = options.maxCharacters ?? HISTORY_PAGE_CHARACTERS;
  const maxLineBytes = options.maxLineBytes ?? MAX_TRANSCRIPT_LINE_BYTES;
  if (
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < 1 ||
    maxCharacters > HISTORY_PAGE_CHARACTERS ||
    !Number.isSafeInteger(maxLineBytes) ||
    maxLineBytes < 256 ||
    maxLineBytes > MAX_TRANSCRIPT_LINE_BYTES
  )
    throw new Error("History page budget is outside supported limits");
  return { maxCharacters, maxLineBytes };
}

function transcriptNotes(
  invalid: number,
  oversized: number,
  maxLineBytes: number,
  truncated: boolean,
) {
  const notes = [
    "Messages are streamed from the original JSONL; only this bounded page is materialized.",
  ];
  if (invalid)
    notes.push(
      `${invalid} invalid or incomplete source lines could not be read. Original file is unchanged.`,
    );
  if (oversized)
    notes.push(
      `${oversized} source lines exceed the ${maxLineBytes / 1024 / 1024} MiB per-record limit and could not be read.`,
    );
  if (truncated)
    notes.push(
      "This page exceeds the text budget. Read fewer messages to see more of each message.",
    );
  return notes;
}

async function collectLines(
  iterator: AsyncGenerator<string | null>,
  source: HistorySource,
  options: HistoryPageOptions,
  maxCharacters: number,
  diagnostics: TranscriptPage["diagnostics"],
) {
  const primary: Collector = { count: 0, remaining: maxCharacters, truncated: false, messages: [] };
  const fallback: Collector = {
    count: 0,
    remaining: maxCharacters,
    truncated: false,
    messages: [],
  };
  let invalid = 0,
    oversized = 0,
    foundNativeId = "";
  for await (const line of iterator) {
    if (line === null) {
      oversized++;
      continue;
    }
    if (!line.trim()) continue;
    let record;
    try {
      record = object(JSON.parse(line));
    } catch {
      invalid++;
      continue;
    }
    diagnostics.recordsRead++;
    if (!foundNativeId) {
      if (source === "Codex" && record.type === "session_meta")
        foundNativeId = string(object(record.payload).id);
      else if (source !== "Codex" && string(record.cwd))
        foundNativeId = string(record.id) || string(record.sessionId);
    }
    const messages = parseTranscript(
      [record],
      source as "Codex" | "Claude" | "Cursor" | "Antigravity",
    );
    const projection = source === "Codex" && record.type === "event_msg" ? "fallback" : "primary";
    const target = projection === "fallback" ? fallback : primary;
    for (let index = 0; index < messages.length; index++)
      options.visitMessage?.(messages[index]!, target.count + index, projection);
    collect(target, messages, options);
  }
  return {
    selected: primary.count ? primary : fallback,
    projection: primary.count ? ("primary" as const) : ("fallback" as const),
    invalid,
    oversized,
    foundNativeId,
  };
}

export async function readTranscriptPage(
  filePath: string,
  nativeId: string,
  source: HistorySource,
  options: HistoryPageOptions,
): Promise<TranscriptPage> {
  if (!["Codex", "Claude", "Cursor", "Antigravity"].includes(source))
    throw new Error("History source type does not match its transcript reference");
  const { maxCharacters, maxLineBytes } = pageLimits(options);
  const file = await open(filePath, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("History source must be a regular file");
    const identity = `${info.dev}:${info.ino}`;
    const extent = options.boundary?.bytes ?? info.size;
    if (options.boundary && (options.boundary.identity !== identity || extent > info.size))
      throw new Error("Original transcript was replaced or truncated after this fork");
    const diagnostics = { bytesRead: 0, peakBufferedLineBytes: 0, recordsRead: 0 };
    const digest = createHash("sha256");
    const { selected, projection, invalid, oversized, foundNativeId } = await collectLines(
      lines(file, extent, maxLineBytes, diagnostics, digest, options.signal),
      source,
      options,
      maxCharacters,
      diagnostics,
    );
    const resolvedId =
      foundNativeId ||
      (source === "Antigravity"
        ? path.basename(path.dirname(path.dirname(path.dirname(filePath))))
        : path.basename(filePath, ".jsonl"));
    if (resolvedId !== nativeId)
      throw new Error("The source now contains a different conversation. Scan history again.");
    const sha256 = digest.digest("hex");
    if (options.boundary && options.boundary.sha256 !== sha256)
      throw new Error("Original transcript contents changed inside the frozen fork boundary");
    const notes = transcriptNotes(invalid, oversized, maxLineBytes, selected.truncated);
    return {
      messages: selected.messages,
      total: selected.count,
      truncated: selected.truncated,
      notes,
      updatedAt: info.mtime.toISOString(),
      sourceBoundary: { identity, bytes: extent, sha256 },
      diagnostics,
      projection,
      unreadableRecords: invalid + oversized,
    };
  } finally {
    await file.close();
  }
}
