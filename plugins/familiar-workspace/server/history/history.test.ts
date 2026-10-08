import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  conversationTitle,
  parseChatGPT,
  parseCursor,
  parseVSCode,
  parseTranscript,
} from "./parsers.js";
import { parseSteps } from "./antigravity.js";
import { scanLocalHistory, readHistorySource, type DiscoveredConversation } from "./readers.js";
import { HistoryStore } from "./store.js";
import { CACHED_HISTORY_NOTE, LINKED_HISTORY_NOTE } from "./references.js";
const temporary: string[] = [];
async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), "familiar-history-"));
  temporary.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const record: DiscoveredConversation = {
  source: "Cursor",
  nativeId: "native-one",
  title: "Example",
  workspace: "vscode-remote://ssh-remote+server/project",
  origin: "fixture",
  reference: { kind: "transcript-jsonl", path: "/fixture/original.jsonl" },
  updatedAt: "2026-10-01T00:00:00.000Z",
  messages: [{ role: "user", text: "Keep this" }],
  notes: [],
};
describe("native conversation readers", () => {
  it("uses a readable title while preserving original transcript text", () => {
    expect(
      conversationTitle([
        { role: "user", text: "<recommended_plugins>metadata</recommended_plugins>" },
        { role: "user", text: "<timestamp>date</timestamp><user_query>Real question</user_query>" },
      ]),
    ).toBe("Real question");
  });
  it("retains readable messages and records partial-import warnings for damaged JSONL", async () => {
    const home = await directory(),
      folder = path.join(home, ".codex", "sessions");
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "session.jsonl");
    await writeFile(
      file,
      JSON.stringify({ type: "session_meta", payload: { id: "damaged", cwd: "/project" } }) +
        "\nnot-json\n" +
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "Retained" },
        }),
    );
    const found: DiscoveredConversation[] = [],
      errors: string[] = [];
    await scanLocalHistory(
      {
        accept: async (value) => {
          found.push(value);
        },
        error: (value) => errors.push(value),
      },
      ["Codex"],
      home,
    );
    expect(found[0]?.messages[0]?.text).toBe("Retained");
    expect(found[0]?.notes.join(" ")).toContain("1 invalid");
    expect(errors).toHaveLength(1);
  });

  it("respects Cursor header ordering and preserves tools", () => {
    const rows = new Map([
      [
        "b",
        {
          type: 2,
          text: "Answer",
          toolFormerData: { name: "read", params: "file", result: "content" },
        },
      ],
      ["a", { type: 1, text: "Question" }],
    ]);
    expect(
      parseCursor(
        { fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }] },
        rows,
      ).map((item) => item.role),
    ).toEqual(["user", "assistant", "tool"]);
    expect(parseCursor({ conversation: [{ type: 1, text: "Legacy" }] }, new Map())[0]?.text).toBe(
      "Legacy",
    );
  });
  it("reads VSCode markdown responses and Codex extension session records without event duplicates", () => {
    expect(
      parseVSCode({
        requests: [
          {
            message: { text: "Hi" },
            response: [{ kind: "markdownContent", content: { value: "Hello" } }],
          },
        ],
      }).map((item) => item.text),
    ).toEqual(["Hi", "Hello"]);
    expect(
      parseTranscript(
        [
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "answer" }],
            },
          },
          { type: "event_msg", payload: { type: "agent_message", message: "answer" } },
        ],
        "Codex",
      ),
    ).toHaveLength(1);
  });
  it("selects ChatGPT current branch and rejects corrupt parent chains", () => {
    const mapping = {
      a: { parent: null, message: { author: { role: "user" }, content: { parts: ["Question"] } } },
      b: {
        parent: "a",
        message: { author: { role: "assistant" }, content: { parts: ["Chosen"] } },
      },
      c: { parent: "a", message: { author: { role: "assistant" }, content: { parts: ["Other"] } } },
    };
    const result = parseChatGPT({ current_node: "b", mapping });
    expect(result.messages.map((item) => item.text)).toEqual(["Question", "Chosen"]);
    expect(result.notes).toHaveLength(2);
    expect(() => parseChatGPT({ current_node: "a", mapping: { a: { parent: "a" } } })).toThrow(
      "cycle",
    );
    expect(() => parseChatGPT({ current_node: "missing", mapping })).toThrow("missing parent");
  });
  it("imports Antigravity visible messages without private internal metadata", () => {
    expect(
      parseSteps([
        { userInput: { items: [{ text: "Question" }] } },
        {
          plannerResponse: {
            response: "Answer",
            thinking: "internal",
            thinkingSignature: "private",
          },
        },
      ]).map((item) => item.text),
    ).toEqual(["Question", "Answer"]);
  });
  it("reads a Cursor database without changing it and retains its SSH workspace", async () => {
    const home = await directory();
    const root = path.join(home, ".cursor-server", "data", "User");
    const global = path.join(root, "globalStorage");
    const workspace = path.join(root, "workspaceStorage", "hash");
    await mkdir(global, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "workspace.json"),
      JSON.stringify({ folder: record.workspace }),
    );
    const index = new DatabaseSync(path.join(workspace, "state.vscdb"));
    index.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    index
      .prepare("INSERT INTO ItemTable VALUES (?,?)")
      .run(
        "composer.composerData",
        JSON.stringify({ allComposers: [{ composerId: "native-one" }] }),
      );
    index.close();
    const file = path.join(global, "state.vscdb");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO cursorDiskKV VALUES (?,?)").run(
      "composerData:native-one",
      JSON.stringify({ conversation: [{ type: 1, text: "Original" }] }),
    );
    db.close();
    const before = await readFile(file),
      found: DiscoveredConversation[] = [],
      errors: string[] = [];
    await scanLocalHistory(
      {
        accept: async (value) => {
          found.push(value);
        },
        error: (value) => errors.push(value),
      },
      ["Cursor"],
      home,
    );
    expect(errors).toEqual([]);
    expect(found).toHaveLength(1);
    expect(found[0]?.workspace).toBe(record.workspace);
    expect(await readFile(file)).toEqual(before);
    expect(
      (await readHistorySource(found[0]!.reference, found[0]!.nativeId, "Cursor")).messages[0]
        ?.text,
    ).toBe("Original");
  });
});
describe("conversation library persistence", () => {
  it("imports a ChatGPT export through the same store job used by the UI", async () => {
    const dir = await directory(),
      file = path.join(dir, "conversations.json");
    await writeFile(
      file,
      JSON.stringify([
        {
          id: "chatgpt-export-1",
          title: "Imported export",
          current_node: "one",
          mapping: {
            one: {
              parent: null,
              message: { author: { role: "user" }, content: { parts: ["Exported message"] } },
            },
          },
        },
      ]),
    );
    const store = new HistoryStore(path.join(dir, "library"));
    await store.start({ exportPath: file });
    await store.waitForScan();
    const result = await store.list({
      query: "ChatGPT",
      includeHidden: false,
      offset: 0,
      limit: 10,
    });
    expect(result.job.errors).toEqual([]);
    expect(result.total).toBe(1);
    expect((await store.read(result.entries[0]!.id)).messages[0]?.text).toBe("Exported message");
    const stored = await readFile(
      path.join(dir, "library", "records", `${result.entries[0]!.id}.json`),
      "utf8",
    );
    expect(stored).not.toContain("Exported message");
    expect(JSON.parse(stored)).not.toHaveProperty("messages");
    expect(JSON.parse(stored).reference).toEqual({ kind: "chatgpt-export", path: file });
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("Exported message", "Changed in the source"),
    );
    expect((await store.read(result.entries[0]!.id)).messages[0]?.text).toBe(
      "Changed in the source",
    );
    await rm(file);
    await expect(store.read(result.entries[0]!.id)).rejects.toThrow("unavailable");
  });

  it("deduplicates scans, persists hide/restore, exports context and prevents traversal", async () => {
    const dir = await directory();
    const readSource = async () => ({ messages: record.messages, notes: record.notes });
    const store = new HistoryStore(dir, readSource);
    const scan = async (sink: { accept(value: DiscoveredConversation): Promise<void> }) => {
      await sink.accept(record);
      await sink.accept(record);
    };
    await store.start({}, scan);
    await store.waitForScan();
    const query = { query: "", includeHidden: true, offset: 0, limit: 50 };
    let result = await store.list(query);
    expect(result.total).toBe(1);
    const id = result.entries[0]!.id;
    await store.hide(id, true);
    await store.start({}, scan);
    await store.waitForScan();
    const restored = new HistoryStore(dir, readSource);
    expect((await restored.list({ ...query, includeHidden: false })).total).toBe(0);
    expect((await restored.read(id)).hidden).toBe(true);
    await restored.hide(id, false);
    result = await restored.list({ ...query, query: "ssh-remote+server" });
    expect(result.total).toBe(1);
    expect(await readFile((await restored.export(id)).path, "utf8")).toContain("Keep this");
    await expect(restored.read("../../other")).rejects.toThrow();
  });
  it("reports failed imports, does not overwrite newer records, rejects simultaneous scans", async () => {
    const store = new HistoryStore(await directory(), async () => ({
      messages: record.messages,
      notes: record.notes,
    }));
    let release!: () => void;
    await store.start({}, async (sink) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await sink.accept(record);
      await sink.accept({
        ...record,
        updatedAt: "2025-01-01",
        messages: [{ role: "user", text: "old" }],
      });
    });
    await expect(store.start({})).rejects.toThrow("already running");
    release();
    await store.waitForScan();
    let result = await store.list({ query: "", includeHidden: true, offset: 0, limit: 50 });
    expect(result.job.skipped).toBe(1);
    expect((await store.read(result.entries[0]!.id)).messages[0]?.text).toBe("Keep this");
    await store.start({ exportPath: "relative.json" });
    await store.waitForScan();
    result = await store.list({ query: "", includeHidden: true, offset: 0, limit: 50 });
    expect(result.job.errors[0]).toContain("absolute");
  });

  it("relinks legacy cached records on demand and labels unavailable legacy copies", async () => {
    const dir = await directory();
    const id = "a".repeat(64),
      oldId = "b".repeat(64);
    const source = path.join(dir, "original.jsonl");
    await writeFile(
      source,
      JSON.stringify({ role: "user", message: { content: "Live original" } }),
    );
    const legacy = {
      ...record,
      id,
      nativeId: "original",
      origin: source,
      messageCount: 1,
      hidden: false,
    };
    const unavailable = {
      ...legacy,
      id: oldId,
      nativeId: "gone",
      origin: path.join(dir, "gone.jsonl"),
    };
    await mkdir(path.join(dir, "records"));
    const { reference: _reference, ...cached } = legacy;
    const { reference: _otherReference, ...gone } = unavailable;
    await writeFile(path.join(dir, "records", `${id}.json`), JSON.stringify(cached));
    await writeFile(path.join(dir, "records", `${oldId}.json`), JSON.stringify(gone));
    await writeFile(path.join(dir, "index.json"), JSON.stringify([cached, gone]));
    const store = new HistoryStore(dir);
    expect((await store.read(id)).messages[0]?.text).toBe("Live original");
    expect((await store.read(id)).notes).toContain(LINKED_HISTORY_NOTE);
    expect(
      JSON.parse(await readFile(path.join(dir, "records", `${id}.json`), "utf8")),
    ).not.toHaveProperty("messages");
    const fallback = await store.read(oldId);
    expect(fallback.messages[0]?.text).toBe("Keep this");
    expect(fallback.notes).toContain(CACHED_HISTORY_NOTE);
  });
});
