import { describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { readCompositionSource, type CompositionResource } from "../../shared/composition.js";
import { boundedSourceRead, localResourceReader, routedResourceReader } from "./readers.js";

const resource: CompositionResource = {
  id: "history",
  kind: "history",
  label: "History",
  serverId: "mac",
  format: "native-timeline",
  locator: "agent",
  readOnly: true,
};
const nativePage = {
  error: null,
  epoch: "epoch",
  staleCursor: false,
  gap: false,
  hasOlder: true,
  startCursor: { epoch: "epoch", seq: 40 },
  endCursor: { epoch: "epoch", seq: 42 },
  entries: [
    { item: { type: "user_message", text: "Question" } },
    { item: { type: "assistant_message", text: "Answer" } },
    { item: { type: "tool_call", name: "Read" } },
  ],
};
function fixture() {
  const refetch = vi.fn().mockResolvedValue(nativePage);
  const history = {
    readPage: vi.fn().mockImplementation(async (_id: string, offset: number, limit: number) => ({
      updatedAt: "2026-10-08T12:00:00Z",
      total: 3,
      truncated: false,
      messages: [
        { role: "user", text: "one" },
        { role: "assistant", text: "two" },
        { role: "user", text: "three" },
      ].slice(offset, offset + limit),
    })),
  };
  const paseo = {
    agents: { ref: vi.fn(() => ({ timeline: { refetch } })) },
  } as unknown as PaseoApi;
  return {
    refetch,
    history,
    reader: localResourceReader({ serverId: "mac", history, paseo }),
  };
}
describe("lazy composition sources", () => {
  it("projects catalog coordinates out before crossing a strict source transport", async () => {
    const catalogRead = {
      id: "logical-session",
      resourceId: resource.id,
      revision: 2,
      forwarded: true,
      offset: 0,
      limit: 1,
      maxCharacters: 256,
      captureBoundary: true,
    };
    const reader = vi.fn(async (source: CompositionResource, input) => {
      readCompositionSource.input.parse({ resource: source, ...input });
      return {
        messages: [{ role: "assistant", text: "selected" }],
        nextOffset: null,
      };
    });
    await boundedSourceRead(resource, catalogRead, reader);
    expect(reader).toHaveBeenCalledWith(resource, {
      offset: 0,
      limit: 1,
      maxCharacters: 256,
      captureBoundary: true,
    });
  });
  it("rejects a malformed frozen empty prefix without accessing the provider", async () => {
    const { reader, refetch } = fixture();
    await expect(
      reader(
        {
          ...resource,
          boundary: {
            kind: "native",
            epoch: "original",
            seq: 0,
            prefix: { messageCount: 0, sha256: "0".repeat(64) },
          },
        },
        { offset: 0, limit: 1, maxCharacters: 100 },
      ),
    ).rejects.toThrow("invalid prefix hash");
    expect(refetch).not.toHaveBeenCalled();
  });
  it("uses frozen native cursors and rejects replaced source epochs", async () => {
    const { reader, refetch } = fixture();
    const pinned = {
      ...resource,
      boundary: { kind: "native" as const, epoch: "epoch", seq: 20 },
    };
    await reader(pinned, { offset: 0, limit: 10, maxCharacters: 1000 });
    expect(refetch).toHaveBeenLastCalledWith({
      direction: "before",
      cursor: { epoch: "epoch", seq: 21 },
      limit: 10,
      projection: "canonical",
    });
    await expect(
      reader(
        { ...pinned, boundary: { ...pinned.boundary, epoch: "replaced" } },
        { offset: 0, limit: 1, maxCharacters: 1000 },
      ),
    ).rejects.toThrow("was replaced");
  });
  it("does not silently substitute a reimported transcript for a pinned archive", async () => {
    const { reader } = fixture();
    await expect(
      reader(
        {
          ...resource,
          format: "imported-history",
          boundary: { kind: "imported", messageCount: 2, updatedAt: "old" },
        },
        { offset: 0, limit: 1, maxCharacters: 1000 },
      ),
    ).rejects.toThrow("changed after this fork");
  });
  it("reads bounded native pages using canonical sequence cursors", async () => {
    const { reader, refetch } = fixture();
    const page = await reader(resource, {
      offset: 0,
      limit: 10,
      maxCharacters: 1000,
    });
    expect(page.messages.map((item) => item.text)).toEqual(["Question", "Answer"]);
    expect(page.nextOffset).toBe(40);
    await reader(resource, { offset: 40, limit: 10, maxCharacters: 1000 });
    expect(refetch).toHaveBeenLastCalledWith({
      direction: "before",
      cursor: { epoch: "epoch", seq: 40 },
      limit: 10,
      projection: "canonical",
    });
    expect(refetch.mock.calls.every(([input]) => input.limit > 0)).toBe(true);
  });
  it("reads only requested imported messages and checks the source host", async () => {
    const { reader, history } = fixture();
    const page = await reader(
      { ...resource, format: "imported-history" },
      { offset: 1, limit: 1, maxCharacters: 1000 },
    );
    expect(page.messages[0].text).toBe("two");
    expect(page.nextOffset).toBe(2);
    await expect(
      reader({ ...resource, serverId: "other" }, { offset: 0, limit: 1, maxCharacters: 1000 }),
    ).rejects.toThrow("belongs to server");
    expect(history.readPage).toHaveBeenCalledOnce();
  });
  it("reports inaccessible peers without silently reading a local object with the same ID", async () => {
    const local = vi.fn();
    const routed = routedResourceReader({ serverId: "linux", local });
    await expect(routed(resource, { offset: 0, limit: 1, maxCharacters: 1000 })).rejects.toThrow(
      "not reachable",
    );
    await expect(
      routed(
        { ...resource, connection: "https://example.com" },
        { offset: 0, limit: 1, maxCharacters: 1000 },
      ),
    ).rejects.toThrow("SSH URI");
    expect(local).not.toHaveBeenCalled();
  });
  it("caps returned text and keeps source errors visible", async () => {
    const { reader, refetch } = fixture();
    const page = await boundedSourceRead(
      resource,
      { offset: 0, limit: 2, maxCharacters: 8 },
      reader,
    );
    expect(page.messages.map((item) => item.text).join("")).toBe("Question");
    expect(page.truncated).toBe(true);
    refetch.mockResolvedValue({ ...nativePage, gap: true });
    await expect(reader(resource, { offset: 0, limit: 1, maxCharacters: 1000 })).rejects.toThrow(
      "no longer retained",
    );
  });
});
