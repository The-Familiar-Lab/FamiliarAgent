import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AssistantMessageItem, StreamItem } from "@/types/stream";
import { collectAssistantResponseItems } from "./strategy";
import { resolveStreamRenderStrategy } from "./strategy-resolver";
import { resultScreenParams, selectAssistantResult } from "./result-selection";

const digest = async (text: string) => createHash("sha256").update(text).digest("hex");
const assistant = (seq: number, text: string): AssistantMessageItem => ({
  id: `display-${seq}`,
  kind: "assistant_message",
  messageId: `message-${seq}`,
  timelineCursor: { epoch: "one", seq },
  text,
  timestamp: new Date(0),
});
const user = (id: string): StreamItem => ({
  id,
  kind: "user_message",
  text: id,
  timestamp: new Date(0),
});
describe("selected native result", () => {
  it.each(["web", "ios"])(
    "matches Copy on %s and excludes later responses, user text and thoughts",
    async (platform) => {
      const strategy = resolveStreamRenderStrategy({ platform, isMobileBreakpoint: false });
      const chronological: StreamItem[] = [
        user("first"),
        assistant(1, "Older 한글"),
        {
          kind: "thought",
          id: "thought",
          text: "private reasoning",
          status: "ready",
          timestamp: new Date(0),
        },
        assistant(3, "Second segment"),
        user("next"),
        assistant(5, "Newer response"),
      ];
      const items = strategy.orderTail(chronological);
      const index = items.findIndex((item) => item.id === "display-3");
      const selected = collectAssistantResponseItems(items, index, (value) =>
        strategy.getNeighborIndex(value, "above"),
      );
      const text = strategy.collectAssistantResponseContent(items, index);
      expect(selected.map((item) => item.text).join("\n\n")).toBe(text);
      expect(text).toBe("Older 한글\n\nSecond segment");
      const result = await selectAssistantResult(selected, digest);
      expect(result.bytes).toBe(Buffer.byteLength(text));
      expect(result.sha256).toBe(await digest(text));
      expect(result.segments.map((segment) => segment.cursor.seq)).toEqual([1, 3]);
      const route = resultScreenParams("source-agent", result);
      expect(JSON.stringify(route)).not.toContain("Older");
      expect(JSON.stringify(route)).not.toContain("private reasoning");
      expect(route.resultAgentId).toBe("source-agent");
      expect(JSON.parse(route.resultSelection)).toEqual(result);
    },
  );
  it("rejects missing, repeated or mixed epoch source positions instead of guessing", async () => {
    await expect(
      selectAssistantResult([{ ...assistant(1, "one"), timelineCursor: undefined }], digest),
    ).rejects.toThrow("stable source");
    await expect(
      selectAssistantResult([assistant(1, "one"), assistant(1, "two")], digest),
    ).rejects.toThrow("stable source");
    await expect(
      selectAssistantResult(
        [assistant(1, "one"), { ...assistant(2, "two"), timelineCursor: { epoch: "two", seq: 2 } }],
        digest,
      ),
    ).rejects.toThrow("stable source");
  });
  it("bounds source text before hashing and does not mutate original items", async () => {
    const item = Object.freeze(assistant(1, "Selected original"));
    await selectAssistantResult([item], digest);
    expect(item.text).toBe("Selected original");
    await expect(selectAssistantResult([assistant(1, "가".repeat(65536))], digest)).rejects.toThrow(
      "too large",
    );
  });
});
