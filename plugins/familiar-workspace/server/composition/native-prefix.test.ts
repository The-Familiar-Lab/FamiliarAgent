import { describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { CompositionResource } from "../../shared/composition.js";
import { localResourceReader } from "./readers.js";

const resource: CompositionResource = {
  id: "native",
  kind: "history",
  label: "Native",
  serverId: "mac",
  format: "native-timeline",
  locator: "agent",
  readOnly: true,
};
function fixture() {
  let epoch = "live";
  let status = "idle";
  let rows = Array.from({ length: 180 }, (_, index) => ({
    seq: index + 1,
    role: index % 2 ? "assistant_message" : "user_message",
    text: `Message ${index}`,
  }));
  const refetch = vi.fn(
    async (input: { direction: string; limit: number; cursor?: { seq: number } }) => {
      const selected =
        input.direction === "tail"
          ? rows.slice(-input.limit)
          : rows.filter((row) => row.seq > (input.cursor?.seq ?? 0)).slice(0, input.limit);
      return {
        error: null,
        epoch,
        staleCursor: false,
        gap: false,
        hasOlder: selected.length > 0 && selected[0].seq > rows[0].seq,
        hasNewer: selected.length > 0 && selected.at(-1)!.seq < rows.at(-1)!.seq,
        startCursor: selected.length ? { epoch, seq: selected[0].seq } : null,
        endCursor: selected.length ? { epoch, seq: selected.at(-1)!.seq } : null,
        entries: selected.map((row) => ({
          seqStart: row.seq,
          seqEnd: row.seq,
          item: { type: row.role, text: row.text },
        })),
      };
    },
  );
  const paseo = {
    agents: {
      ref: () => ({ refresh: async () => ({ agent: { status } }), timeline: { refetch } }),
    },
  } as unknown as PaseoApi;
  return {
    refetch,
    reader: localResourceReader({ serverId: "mac", paseo, history: {} as never }),
    reload() {
      epoch = "rehydrated";
      rows = rows.map((row, index) => ({ ...row, seq: (index + 1) * 2 }));
    },
    append() {
      rows.push({ seq: rows.at(-1)!.seq + 1, role: "user_message", text: "Added after fork" });
    },
    rewrite() {
      rows[0].text = "Rewritten";
    },
    truncate() {
      rows.pop();
    },
    running() {
      status = "running";
    },
  };
}
describe("durable native history frontier", () => {
  it("uses bounded pages and survives epoch/sequence changes while excluding future messages", async () => {
    const source = fixture();
    const captured = await source.reader(resource, {
      offset: 0,
      limit: 1,
      maxCharacters: 256,
      captureBoundary: true,
    });
    expect(captured.boundary).toMatchObject({ kind: "native", prefix: { messageCount: 180 } });
    expect(source.refetch.mock.calls.every(([input]) => input.limit <= 32)).toBe(true);
    source.reload();
    source.append();
    const read = await source.reader(
      { ...resource, boundary: captured.boundary },
      { offset: 177, limit: 10, maxCharacters: 1024 },
    );
    expect(read.messages.map((item) => item.text)).toEqual(["Message 0", "Message 1", "Message 2"]);
    expect(read.nextOffset).toBeNull();
    const first = await source.reader(
      { ...resource, boundary: captured.boundary },
      { offset: 0, limit: 2, maxCharacters: 1024 },
    );
    expect(first.nextOffset).toBe(2);
    source.rewrite();
    await expect(
      source.reader(
        { ...resource, boundary: captured.boundary },
        { offset: 0, limit: 1, maxCharacters: 256 },
      ),
    ).rejects.toThrow("rewritten or truncated");
  });
  it("rejects truncated prefixes and in-flight forks instead of making fragile snapshots", async () => {
    const source = fixture();
    const captured = await source.reader(resource, {
      offset: 0,
      limit: 1,
      maxCharacters: 256,
      captureBoundary: true,
    });
    source.truncate();
    await expect(
      source.reader(
        { ...resource, boundary: captured.boundary },
        { offset: 0, limit: 1, maxCharacters: 256 },
      ),
    ).rejects.toThrow("rewritten or truncated");
    source.running();
    await expect(
      source.reader(resource, { offset: 0, limit: 1, maxCharacters: 256, captureBoundary: true }),
    ).rejects.toThrow("finish its current turn");
  });
});
