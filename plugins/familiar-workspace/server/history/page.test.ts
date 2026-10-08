import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { HistoryStore } from "./store.js";
import { readTranscriptPage } from "./page.js";

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "familiar-history-page-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const codex = (text: string) =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  }) + "\n";
describe("streamed original transcript pages", () => {
  it("reads late pages beyond the previous whole-file limit without retaining earlier messages", async () => {
    const file = path.join(await setup(), "large.jsonl");
    const handle = await open(file, "w");
    const count = 2000;
    try {
      for (let i = 0; i < count; i++)
        await handle.write(codex(`message-${i}: ${"x".repeat(36 * 1024)}`));
    } finally {
      await handle.close();
    }
    const bytes = (await stat(file)).size;
    expect(bytes).toBeGreaterThan(64 * 1024 * 1024);
    const page = await readTranscriptPage(file, "large", "Codex", {
      offset: 1997,
      limit: 1,
      maxCharacters: 1024,
    });
    expect(page.total).toBe(count);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].text.startsWith("message-1997")).toBe(true);
    expect(page.messages[0].text.length).toBe(1024);
    expect(page.diagnostics.peakBufferedLineBytes).toBeLessThan(40 * 1024);
    expect(page.diagnostics.bytesRead).toBe(bytes);
    expect(page.sourceBoundary.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("uses Codex primary records even when duplicate fallback events precede them", async () => {
    const file = path.join(await setup(), "session.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "duplicate" },
      }) +
        "\n" +
        codex("canonical") +
        codex("next"),
    );
    const page = await readTranscriptPage(file, "session", "Codex", { offset: 0, limit: 10 });
    expect(page.total).toBe(2);
    expect(page.messages.map((item) => item.text)).toEqual(["canonical", "next"]);
  });
  it("pins byte extent and digest: appends remain invisible, edits or replacement are rejected", async () => {
    const root = await setup(),
      file = path.join(root, "session.jsonl");
    await writeFile(file, codex("before"));
    const first = await readTranscriptPage(file, "session", "Codex", { offset: 0, limit: 10 });
    await appendFile(file, codex("after"));
    const frozen = await readTranscriptPage(file, "session", "Codex", {
      offset: 0,
      limit: 10,
      boundary: first.sourceBoundary,
    });
    expect(frozen.messages.map((item) => item.text)).toEqual(["before"]);
    const changed = (await readFile(file, "utf8")).replace("before", "edited");
    await writeFile(file, changed);
    await expect(
      readTranscriptPage(file, "session", "Codex", {
        offset: 0,
        limit: 10,
        boundary: first.sourceBoundary,
      }),
    ).rejects.toThrow("contents changed");
    await writeFile(file, "");
    await expect(
      readTranscriptPage(file, "session", "Codex", {
        offset: 0,
        limit: 10,
        boundary: first.sourceBoundary,
      }),
    ).rejects.toThrow("truncated");
  });
  it("bounds oversized and corrupt lines, retaining readable Claude messages", async () => {
    const file = path.join(await setup(), "claude.jsonl");
    const message = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Kept" }] },
    });
    await writeFile(file, "x".repeat(5000) + "\ninvalid\n" + message);
    const page = await readTranscriptPage(file, "claude", "Claude", {
      offset: 0,
      limit: 10,
      maxLineBytes: 512,
    });
    expect(page.messages.map((item) => item.text)).toEqual(["Kept"]);
    expect(page.notes.join(" ")).toContain("1 invalid");
    expect(page.notes.join(" ")).toContain("1 source lines exceed");
    expect(page.diagnostics.peakBufferedLineBytes).toBeLessThanOrEqual(512);
  });
  it("reads linked store pages without materializing or caching the source transcript", async () => {
    const root = await setup(),
      file = path.join(root, "session.jsonl");
    await writeFile(file, codex("first") + codex("second"));
    const store = new HistoryStore(path.join(root, "library"));
    await store.put({
      source: "Codex",
      nativeId: "session",
      title: "Session",
      origin: file,
      workspace: root,
      reference: { kind: "transcript-jsonl", path: file },
      updatedAt: (await stat(file)).mtime.toISOString(),
      messages: [{ role: "user", text: "scan metadata" }],
      notes: [],
    });
    const id = createHash("sha256").update("Codex\0session").digest("hex");
    const page = await store.readPage(id, 1, 1, 256);
    expect(page.messages[0].text).toBe("second");
    expect(page.total).toBe(2);
    expect((await stat(path.join(root, "library/records", `${id}.json`))).size).toBeLessThan(2048);
    expect(await readFile(file, "utf8")).toContain("first");
  });
});
