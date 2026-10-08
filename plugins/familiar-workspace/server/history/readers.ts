import { scanAntigravity } from "./antigravity.js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setImmediate } from "node:timers/promises";
import type { HistorySource, HistoryMessage } from "../../shared/history.js";
import { historyReference, type HistoryReference } from "./references.js";
import {
  object,
  array,
  string,
  timestamp,
  parseCursor,
  conversationTitle,
  parseVSCode,
  parseTranscript,
  parseJsonLines,
  parseChatGPT,
  type Json,
} from "./parsers.js";

export const MAX_HISTORY_FILE_BYTES = 64 * 1024 * 1024;
export interface DiscoveredConversation {
  nativeId: string;
  source: HistorySource;
  title: string;
  origin: string;
  workspace: string;
  updatedAt: string;
  messages: HistoryMessage[];
  notes: string[];
  reference: HistoryReference;
}
export interface ScanSink {
  accept(record: DiscoveredConversation): Promise<void>;
  error(message: string): void;
}
const textNotes = [
  "Readable text and tool results. Original attachments, media and editor checkpoints stay in the source app.",
];
export async function readBounded(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_HISTORY_FILE_BYTES)
    throw new Error(`History file exceeds ${MAX_HISTORY_FILE_BYTES / 1024 / 1024} MiB: ${file}`);
  return readFile(file, "utf8");
}
export async function entries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function* files(directory: string, depth: number): AsyncGenerator<string> {
  for (const entry of await entries(directory)) {
    const file = path.join(directory, entry.name);
    if (entry.isFile()) yield file;
    else if (entry.isDirectory() && depth > 0) yield* files(file, depth - 1);
  }
}
function jsonCell(value: unknown): Json {
  if (value === null || value === undefined) return {};
  let text = "";
  if (typeof value === "string") text = value;
  else if (value instanceof Uint8Array) text = Buffer.from(value).toString("utf8");
  return text ? object(JSON.parse(text)) : {};
}
function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=250");
  return db;
}
function tableExists(db: DatabaseSync, name: string) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function uriText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const uri = object(raw);
  const scheme = string(uri.scheme),
    authority = string(uri.authority),
    pathname = string(uri.path);
  return scheme && pathname ? `${scheme}://${authority}${pathname}` : string(uri.fsPath);
}
async function workspaceUri(directory: string): Promise<string> {
  try {
    const data = object(JSON.parse(await readBounded(path.join(directory, "workspace.json"))));
    return string(data.folder) || string(data.workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
async function cursorWorkspaceIndex(root: string, sink: ScanSink): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const folder of await entries(path.join(root, "workspaceStorage"))) {
    if (!folder.isDirectory()) continue;
    const directory = path.join(root, "workspaceStorage", folder.name);
    let db: DatabaseSync | undefined;
    try {
      const uri = await workspaceUri(directory);
      result.set(folder.name, uri);
      const dbPath = path.join(directory, "state.vscdb");
      try {
        await stat(dbPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      db = openDatabase(dbPath);
      if (!tableExists(db, "ItemTable")) continue;
      const row = db.prepare("SELECT value FROM ItemTable WHERE key='composer.composerData'").get();
      for (const raw of array(jsonCell(row?.value).allComposers)) {
        const id = string(object(raw).composerId);
        if (id) result.set(id, uri);
      }
    } catch (error) {
      sink.error(
        `Cursor workspace ${folder.name}: ${error instanceof Error ? error.message : "Cannot read index"}`,
      );
    } finally {
      db?.close();
    }
    await setImmediate();
  }
  return result;
}
async function readCursorConversation(
  id: string,
  dbPath: string,
  workspaces: Map<string, string>,
  cell: ReturnType<DatabaseSync["prepare"]>,
  headers: ReturnType<DatabaseSync["prepare"]> | null,
  bubbleRows: ReturnType<DatabaseSync["prepare"]>,
  sink: ScanSink,
) {
  const row = cell.get(`composerData:${id}`, MAX_HISTORY_FILE_BYTES);
  if (!row) throw new Error("Composer exceeds the history file size limit");
  const composer = jsonCell(row.value);
  const header = headers?.get(id);
  const head = jsonCell(header?.value);
  const bubbles = new Map<string, Json>();
  let bytes = 0;
  for (const bubble of bubbleRows.iterate(`bubbleId:${id}:`, `bubbleId:${id};`)) {
    bytes +=
      typeof bubble.value === "string"
        ? Buffer.byteLength(bubble.value)
        : ((bubble.value as Uint8Array)?.byteLength ?? 0);
    if (bytes > MAX_HISTORY_FILE_BYTES)
      throw new Error("Conversation exceeds the history file size limit");
    bubbles.set(String(bubble.key).slice(`bubbleId:${id}:`.length), jsonCell(bubble.value));
  }
  const messages = parseCursor(composer, bubbles);
  const workspace =
    workspaces.get(id) ||
    workspaces.get(String(header?.workspaceId)) ||
    uriText(object(head.workspaceIdentifier).uri) ||
    uriText(object(object(head.agentLocation).environment).uri) ||
    string(object(array(head.trackedGitRepos)[0]).repoPath);
  await sink.accept({
    nativeId: id,
    source: "Cursor",
    reference: { kind: "cursor-database", path: dbPath },
    origin: dbPath,
    workspace,
    title:
      string(head.name) ||
      string(composer.name) ||
      messages.find((item) => item.role === "user")?.text.slice(0, 160) ||
      id,
    updatedAt: timestamp(composer.lastUpdatedAt ?? composer.createdAt),
    messages,
    notes: textNotes,
  });
}
async function scanCursor(root: string, sink: ScanSink) {
  const dbPath = path.join(root, "globalStorage", "state.vscdb");
  try {
    await stat(dbPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const workspaces = await cursorWorkspaceIndex(root, sink);
  const db = openDatabase(dbPath);
  try {
    if (!tableExists(db, "cursorDiskKV")) return;
    const keys = db
      .prepare(
        "SELECT key FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND value IS NOT NULL",
      )
      .all();
    const cell = db.prepare("SELECT value FROM cursorDiskKV WHERE key=? AND length(value)<=?");
    const headers = tableExists(db, "composerHeaders")
      ? db.prepare("SELECT value,workspaceId FROM composerHeaders WHERE composerId=?")
      : null;
    const bubbleRows = db.prepare(
      "SELECT key,value FROM cursorDiskKV WHERE key>=? AND key<? AND value IS NOT NULL ORDER BY rowid",
    );
    for (const { key } of keys) {
      const id = String(key).slice("composerData:".length);
      try {
        await readCursorConversation(id, dbPath, workspaces, cell, headers, bubbleRows, sink);
      } catch (error) {
        sink.error(`Cursor ${id}: ${error instanceof Error ? error.message : "Read failed"}`);
      }
      await setImmediate();
    }
  } finally {
    db.close();
  }
}
async function scanVSCode(root: string, sink: ScanSink) {
  for (const folder of await entries(path.join(root, "workspaceStorage"))) {
    if (!folder.isDirectory()) continue;
    const directory = path.join(root, "workspaceStorage", folder.name);
    for (const file of await entries(path.join(directory, "chatSessions"))) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const source = path.join(directory, "chatSessions", file.name);
      try {
        const data = object(JSON.parse(await readBounded(source)));
        const messages = parseVSCode(data);
        await sink.accept({
          nativeId: string(data.sessionId) || file.name,
          source: "VSCode",
          reference: { kind: "vscode-json", path: source },
          origin: source,
          workspace: await workspaceUri(directory),
          title:
            string(data.customTitle) ||
            messages.find((item) => item.role === "user")?.text.slice(0, 160) ||
            file.name,
          updatedAt: timestamp(data.lastMessageDate ?? data.creationDate),
          messages,
          notes: textNotes,
        });
      } catch (error) {
        sink.error(
          `VSCode ${file.name}: ${error instanceof Error ? error.message : "Read failed"}`,
        );
      }
      await setImmediate();
    }
  }
}
async function readTranscriptLines(
  file: string,
  source: HistorySource,
  sink: ScanSink,
): Promise<Json[]> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const records: Json[] = [];
  let bytes = 0;
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      lineNumber++;
      let record: Json | undefined;
      try {
        [record] = parseJsonLines(line);
      } catch {
        sink.error(
          `${source} ${file}: invalid or incomplete JSON at line ${lineNumber}; other readable messages were retained.`,
        );
        continue;
      }
      if (!record) continue;
      if (
        source === "Codex" &&
        !["session_meta", "response_item", "event_msg"].includes(string(record.type))
      )
        continue;
      if (
        source === "Codex" &&
        record.type === "event_msg" &&
        !["user_message", "agent_message"].includes(string(object(record.payload).type))
      )
        continue;
      if (
        source === "Codex" &&
        record.type === "response_item" &&
        !["message", "function_call_output"].includes(string(object(record.payload).type))
      )
        continue;
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_HISTORY_FILE_BYTES)
        throw new Error("Readable transcript exceeds 64 MiB; use a smaller export");
      records.push(record);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return records;
}
async function* transcriptFiles(roots: string[], depth: number) {
  for (const root of roots) yield* files(root, depth);
}
async function isTranscript(file: string, source: HistorySource) {
  if (!file.endsWith(".jsonl")) return false;
  if (source === "Cursor" && !file.includes(`${path.sep}agent-transcripts${path.sep}`))
    return false;
  if (
    source === "Antigravity" &&
    !/[/\\]\.system_generated[/\\]logs[/\\]transcript(?:_full)?\.jsonl$/.test(file)
  )
    return false;
  if (source === "Antigravity" && file.endsWith("/transcript.jsonl")) {
    try {
      await stat(path.join(path.dirname(file), "transcript_full.jsonl"));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return true;
}
async function scanTranscripts(
  source: "Cursor" | "Codex" | "Claude" | "Antigravity",
  roots: string[],
  sink: ScanSink,
  titles = new Map<string, string>(),
) {
  for await (const file of transcriptFiles(roots, source === "Cursor" ? 4 : 3)) {
    if (!(await isTranscript(file, source))) continue;
    try {
      const warnings: string[] = [];
      const records = await readTranscriptLines(file, source, {
        accept: sink.accept,
        error: (warning) => {
          warnings.push(warning);
          sink.error(warning);
        },
      });
      const meta =
        source === "Codex"
          ? object(records.find((item) => item.type === "session_meta")?.payload)
          : (records.find((item) => string(item.cwd)) ?? {});
      const messages = parseTranscript(records, source);
      const firstUser = conversationTitle(messages);
      await sink.accept({
        nativeId:
          string(meta.id) ||
          string(meta.sessionId) ||
          (source === "Antigravity"
            ? path.basename(path.dirname(path.dirname(path.dirname(file))))
            : path.basename(file, ".jsonl")),
        source,
        reference: { kind: "transcript-jsonl", path: file },
        origin: file,
        workspace: string(meta.cwd),
        title: titles.get(string(meta.id)) || firstUser || path.basename(file),
        updatedAt: (await stat(file)).mtime.toISOString(),
        messages,
        notes: warnings.length
          ? [
              ...textNotes,
              `${warnings.length} invalid or incomplete source lines could not be imported. Original file is unchanged.`,
            ]
          : textNotes,
      });
    } catch (error) {
      sink.error(`${source} ${file}: ${error instanceof Error ? error.message : "Read failed"}`);
    }
    await setImmediate();
  }
}
export async function scanChatGPT(file: string, sink: ScanSink) {
  const raw: unknown = JSON.parse(await readBounded(file));
  let records = [raw];
  if (Array.isArray(raw)) records = raw;
  else if (Array.isArray(object(raw).conversations)) records = array(object(raw).conversations);
  if (!records.length) throw new Error("The export contains no conversations");
  for (const rawRecord of records) {
    const data = object(rawRecord),
      id = string(data.id) || string(data.conversation_id);
    if (!id || !data.mapping)
      throw new Error("Expected ChatGPT conversations.json export (not an account/settings file)");
    try {
      const { messages, notes } = parseChatGPT(data);
      await sink.accept({
        nativeId: id,
        source: "ChatGPT",
        reference: { kind: "chatgpt-export", path: file },
        origin: file,
        workspace: "",
        title: string(data.title) || id,
        updatedAt: timestamp(data.update_time ?? data.create_time),
        messages,
        notes,
      });
    } catch (error) {
      sink.error(`ChatGPT ${id}: ${error instanceof Error ? error.message : "Read failed"}`);
    }
    await setImmediate();
  }
}

async function readLinkedCursor(file: string, nativeId: string) {
  const db = openDatabase(file);
  const found: DiscoveredConversation[] = [];
  try {
    const cell = db.prepare("SELECT value FROM cursorDiskKV WHERE key=? AND length(value)<=?");
    const headers = tableExists(db, "composerHeaders")
      ? db.prepare("SELECT value,workspaceId FROM composerHeaders WHERE composerId=?")
      : null;
    const bubbles = db.prepare(
      "SELECT key,value FROM cursorDiskKV WHERE key>=? AND key<? AND value IS NOT NULL ORDER BY rowid",
    );
    await readCursorConversation(nativeId, file, new Map(), cell, headers, bubbles, {
      accept: async (value) => {
        found.push(value);
      },
      error: (message) => {
        throw new Error(message);
      },
    });
    return { messages: found[0]!.messages, notes: textNotes };
  } finally {
    db.close();
  }
}
async function readLinkedVSCode(file: string, nativeId: string) {
  const data = object(JSON.parse(await readBounded(file)));
  if ((string(data.sessionId) || path.basename(file)) !== nativeId)
    throw new Error("The VSCode source now contains a different conversation. Scan history again.");
  return { messages: parseVSCode(data), notes: textNotes };
}
async function readLinkedTranscript(file: string, nativeId: string, source: HistorySource) {
  if (source !== "Cursor" && source !== "Codex" && source !== "Claude" && source !== "Antigravity")
    throw new Error("History source type does not match its reference");
  const warnings: string[] = [];
  const records = await readTranscriptLines(file, source, {
    accept: async () => {},
    error: (message) => {
      warnings.push(message);
    },
  });
  const meta =
    source === "Codex"
      ? object(records.find((item) => item.type === "session_meta")?.payload)
      : (records.find((item) => string(item.cwd)) ?? {});
  const id =
    string(meta.id) ||
    string(meta.sessionId) ||
    (source === "Antigravity"
      ? path.basename(path.dirname(path.dirname(path.dirname(file))))
      : path.basename(file, ".jsonl"));
  if (id !== nativeId)
    throw new Error("The source now contains a different conversation. Scan history again.");
  return {
    messages: parseTranscript(records, source),
    notes: warnings.length
      ? [
          ...textNotes,
          `${warnings.length} invalid or incomplete source lines could not be read. Original file is unchanged.`,
        ]
      : textNotes,
  };
}
async function readLinkedChatGPT(file: string, nativeId: string) {
  const raw: unknown = JSON.parse(await readBounded(file));
  let records = [raw];
  if (Array.isArray(raw)) records = raw;
  else if (Array.isArray(object(raw).conversations)) records = array(object(raw).conversations);
  const record = records
    .map(object)
    .find((item) => (string(item.id) || string(item.conversation_id)) === nativeId);
  if (!record)
    throw new Error(
      "This conversation is no longer in the ChatGPT export. Scan a current export to relink it.",
    );
  return parseChatGPT(record);
}
async function readLinkedAntigravity(home: string, nativeId: string) {
  const found: DiscoveredConversation[] = [],
    errors: string[] = [];
  await scanAntigravity(
    home,
    {
      accept: async (value) => {
        if (value.nativeId === nativeId) found.push(value);
      },
      error: (message) => {
        errors.push(message);
      },
    },
    nativeId,
  );
  if (!found.length)
    throw new Error(
      errors[0] || "Open the original Antigravity IDE to read this linked conversation.",
    );
  return { messages: found[0]!.messages, notes: found[0]!.notes };
}
/** Resolve one native conversation only when the user opens or exports it. */
export async function readHistorySource(
  rawReference: HistoryReference,
  nativeId: string,
  source: HistorySource,
): Promise<{ messages: HistoryMessage[]; notes: string[] }> {
  const reference = historyReference.parse(rawReference);
  switch (reference.kind) {
    case "cursor-database":
      if (source !== "Cursor") throw new Error("History source type does not match its reference");
      return readLinkedCursor(reference.path, nativeId);
    case "vscode-json":
      if (source !== "VSCode") throw new Error("History source type does not match its reference");
      return readLinkedVSCode(reference.path, nativeId);
    case "transcript-jsonl":
      return readLinkedTranscript(reference.path, nativeId, source);
    case "chatgpt-export":
      if (source !== "ChatGPT") throw new Error("History source type does not match its reference");
      return readLinkedChatGPT(reference.path, nativeId);
    case "antigravity-reader":
      if (source !== "Antigravity")
        throw new Error("History source type does not match its reference");
      return readLinkedAntigravity(reference.home, nativeId);
  }
}
export async function scanLocalHistory(
  sink: ScanSink,
  sources?: HistorySource[],
  home = os.homedir(),
) {
  const selected = new Set(sources ?? ["Cursor", "VSCode", "Codex", "Claude", "Antigravity"]);
  let config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  if (process.platform === "darwin") config = path.join(home, "Library", "Application Support");
  else if (process.platform === "win32")
    config = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const tasks: [HistorySource, () => Promise<void>][] = [
    ["Cursor", () => scanCursor(path.join(config, "Cursor", "User"), sink)],
    ["Cursor", () => scanCursor(path.join(home, ".cursor-server", "data", "User"), sink)],
    ["Cursor", () => scanTranscripts("Cursor", [path.join(home, ".cursor", "projects")], sink)],
    ["VSCode", () => scanVSCode(path.join(config, "Code", "User"), sink)],
    ["VSCode", () => scanVSCode(path.join(home, ".vscode-server", "data", "User"), sink)],
    [
      "Codex",
      async () => {
        const titles = new Map<string, string>();
        try {
          for (const entry of parseJsonLines(
            await readBounded(path.join(home, ".codex", "session_index.jsonl")),
          )) {
            if (string(entry.id) && string(entry.thread_name))
              titles.set(string(entry.id), string(entry.thread_name));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            sink.error("Codex conversation names could not be read; using message titles.");
        }
        await scanTranscripts(
          "Codex",
          [path.join(home, ".codex", "sessions"), path.join(home, ".codex", "archived_sessions")],
          sink,
          titles,
        );
      },
    ],
    ["Claude", () => scanTranscripts("Claude", [path.join(home, ".claude", "projects")], sink)],
    [
      "Antigravity",
      () =>
        scanTranscripts(
          "Antigravity",
          ["antigravity", "antigravity-ide", "antigravity-cli"].map((name) =>
            path.join(home, ".gemini", name, "brain"),
          ),
          sink,
        ),
    ],
    ["Antigravity", () => scanAntigravity(home, sink)],
  ];
  for (const [source, scan] of tasks) {
    if (!selected.has(source)) continue;
    try {
      await scan();
    } catch (error) {
      sink.error(`${source}: ${error instanceof Error ? error.message : "Scan failed"}`);
    }
  }
}
